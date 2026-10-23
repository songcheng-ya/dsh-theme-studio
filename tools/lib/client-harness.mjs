/**
 * 客户端 bundle 的 Node 侧最小加载器。
 *
 * 为什么需要它：`lib/client.js` 是一个「惰性 CJS」bundle，正常只在浏览器里由
 * client-modules 物化。要对 `ThemeRuntime` 的壁纸解析、以及设置面板里那些
 * **闭包在组件内部**的动作（清空壁纸 / 换一张 / 切来源）做回归，必须先假装出
 * 它用到的浏览器 API，再把工厂函数跑起来。
 *
 * 这里**只实现 client.js 真正调用到的那一小撮 API**，不追求通用 DOM ——
 * 桩越大，测试越容易测到桩而不是产品代码。
 *
 * 用法：
 *   const { client, dom, setContextValue, requests } = await loadClient()
 *   const runtime = new client.ThemeRuntime()
 *
 * 注意：ESM 模块只求值一次，所以 `loadClient()` 是幂等的；同一个进程里
 * 需要「多个独立的运行时」时请 new 多个 `ThemeRuntime`，不要重复加载 bundle
 * （bundle 顶层的 `window.__ModuleLoader__.load(...)` 不会执行第二次）。
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.resolve(HERE, '..', '..', 'lib', 'client.js')

/* ═══════════════════════════════════════════════════════════════════
 * 最小 DOM 桩
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * 造一个「够用」的元素。
 *
 * 只覆盖 client.js 用到的：dataset / style.setProperty / setAttribute /
 * removeAttribute / appendChild / append / remove / textContent。
 * `remove()` 会真的从父节点的 children 里摘掉 —— 断言「背景层已销毁」时
 * 光看 `isConnected` 不够，还得确认 DOM 树里真的没有它了。
 * @param tag - 标签名。
 * @returns 元素桩。
 */
function makeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    dataset: {},
    style: {
      setProperty(key, value) {
        this[key] = value
      },
    },
    children: [],
    parent: null,
    isConnected: true,
    textContent: '',
    setAttribute(key, value) {
      this[key] = value
    },
    removeAttribute(key) {
      delete this[key]
    },
    hasAttribute(key) {
      return key in this
    },
    appendChild(child) {
      this.children.push(child)
      child.parent = this
      return child
    },
    append(...nodes) {
      for (const node of nodes) {
        this.children.push(node)
        node.parent = this
      }
    },
    remove() {
      this.isConnected = false
      if (this.parent !== null && Array.isArray(this.parent.children)) {
        const index = this.parent.children.indexOf(this)
        if (index >= 0) this.parent.children.splice(index, 1)
      }
      this.parent = null
    },
    addEventListener() {},
  }
}

/** 造一份 document 桩（head / body / documentElement 都真实存在）。 */
function createDom() {
  const head = makeElement('head')
  const body = makeElement('body')
  const html = makeElement('html')
  const document = {
    head,
    body,
    documentElement: html,
    createElement: makeElement,
    // 一律「找不到」：injectStyle 每次都会新建一个 <style>。测试不关心复用，
    // 但断言背景层是否存在时要看 html.children，而不是靠选择器。
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
  }
  return { document, head, body, html }
}

/**
 * Image 桩：设 src 时**同步**回调 onload。
 *
 * 背景层用它做「图片能不能加载」的探测，探测结果通过 `runtime.lastLoadResult`
 * 暴露给面板。同步 onload 让 `apply()` 返回的 Promise 立刻完成，
 * 断言不用等定时器。
 */
class ImageStub {
  constructor() {
    this.naturalWidth = 1920
    this.naturalHeight = 1080
    this.onload = null
    this.onerror = null
    this._src = ''
  }

  set src(value) {
    this._src = value
    if (typeof this.onload === 'function') this.onload()
  }

  get src() {
    return this._src
  }
}

/* ═══════════════════════════════════════════════════════════════════
 * 最小 React 桩
 * ═══════════════════════════════════════════════════════════════════ */

/** useContext 的返回值：面板靠 `useContext(RUNTIME_CONTEXT)` 拿到运行时。 */
let contextValue

/**
 * 最近一次 `useState` 的覆盖：按**初始值**匹配，用于把面板渲染成非默认标签页或
 * 预置某个 state（如候选墙 gallery）。
 *
 * 为什么按初始值而不是调用序号：序号会被子树里其它 useState 干扰（smoke-client
 * 已经踩过这个坑，这里沿用它的做法）。覆盖只在下一次 useState 命中后自动失效，
 * 所以「渲染 + 展开」必须在同一小段同步代码里完成。
 *
 * 同一个初始值可能出现多次（folders 与 gallery 的初始值都是 `[]`），因此支持
 * `nth` 指定第几次命中；`match` 也可以是谓词（按内容匹配数组，避免引用比较）。
 */
let stateOverride = null

export function setContextValue(value) {
  contextValue = value
}

export function setStateOverride(match, value, nth = 1) {
  stateOverride = { match, value, nth, seen: 0 }
}

export function clearStateOverride() {
  stateOverride = null
}

/** 判断某个 useState 的初始值是否命中本次覆盖。 */
function matchesState(match, value) {
  if (typeof match === 'function') {
    try {
      return match(value) === true
    } catch {
      return false
    }
  }
  return Object.is(match, value)
}

/**
 * 「带状态重渲染」会话（只在 `createHookRenderer()` 里存在，见那里的注释）。
 *
 * 默认桩的 useState 是 no-op，因此「点一下之后状态真的翻转」这类断言
 * （Card 的展开/收起、DiagReport 的行展开）根本无法观察。这里不重写组件，
 * 只把 useState / useId 换成按**调用顺序**存取的槽位；会话之外的既有测试
 * 走原来的 no-op / 覆盖逻辑，行为完全不变。
 */
let hookState = null

/** useId 的自增序列：没有会话时也必须保证同一次静态渲染里的 id 唯一。 */
let idSeq = 0

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  /**
   * useId 的最小实现。
   *
   * 真实 React 的 useId 在每个组件实例上跨渲染稳定。这里没有 fiber，所以分两种：
   *   · 在 createHookRenderer 的会话里占用一个槽位，重渲染返回同一个 id ——
   *     Card 的 aria-controls 必须在展开/收起之间保持不变，否则测试验不出关联；
   *   · 平时只递增，保证同一次静态渲染里 id 不重复即可。
   * @returns 形如 `dsh-ts-id-7` 的字符串。
   */
  useId: () => {
    if (hookState === null) {
      idSeq += 1
      return `dsh-ts-id-${idSeq}`
    }
    const index = hookState.cursor
    hookState.cursor += 1
    if (hookState.slots[index] === undefined) {
      idSeq += 1
      hookState.slots[index] = `dsh-ts-id-${idSeq}`
    }
    return hookState.slots[index]
  },
  useState: (initial) => {
    const value = typeof initial === 'function' ? initial() : initial
    if (hookState !== null) {
      const index = hookState.cursor
      hookState.cursor += 1
      if (!Object.hasOwn(hookState.slots, index)) hookState.slots[index] = value
      const current = hookState.slots[index]
      /* setter 必须捕获**本次会话**而不是读全局 hookState：点击发生在渲染之后，
       * 那时全局会话已经复位。 */
      const session = hookState
      return [current, (next) => {
        session.slots[index] = typeof next === 'function' ? next(current) : next
      }]
    }
    const setter = makeStateSetter()
    if (stateOverride !== null && matchesState(stateOverride.match, value)) {
      stateOverride.seen += 1
      if (stateOverride.seen === stateOverride.nth) {
        const replacement = stateOverride.value
        stateOverride = null
        return [replacement, setter]
      }
    }
    return [value, setter]
  },
  useEffect: (fn) => {
    /* 默认仍是 no-op：既有 80 条断言都是「直接调用组件函数」，补上 effect 会
     * 额外触发 reloadFolders、打乱它们对 requests 计数的假设。
     * 只有显式 mountPanel() 期间才收集 effect（见下面的挂载设施）。 */
    if (hookSession !== null) hookSession.effects.push(fn)
  },
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  useContext: (context) => (contextValue !== undefined ? contextValue : context?._current),
  useMemo: (fn) => fn(),
  // Provider 故意留空：面板组件是它唯一的子节点，调用方直接取 children[0] 渲染。
  createContext: (initial) => ({ _current: initial }),
}

/**
 * 挂载会话：只在 `mountPanel()` 期间存在。
 *
 * 它让 useState 的 setter 变成「计数器」、让 useEffect 被收集起来，
 * 从而支持「卸载后是否还 setState / 是否还发 PUT」这类回归。
 * 不挂载时一切保持原来的极简桩行为。
 */
let hookSession = null

/** 生成一个 setter；挂载期间调用会累加计数（卸载后继续计数，正是要断言的回归点）。 */
function makeStateSetter() {
  if (hookSession === null) return () => {}
  const session = hookSession
  return () => {
    session.setStateCalls += 1
  }
}


const primitivesStub = { Switch: () => null }

/* ═══════════════════════════════════════════════════════════════════
 * 假定时器（可手动推进）与挂载 / 卸载
 *
 * 为什么需要：保存管线的两个关键行为只能在时间轴上验证 ——
 *   · 350ms 防抖窗口内连续 persist 是否合并成一笔；
 *   · 卸载后定时器是否被清掉（推进时间不能再发 PUT）。
 * 另外「卸载后在途 fetch 回来不能 setState」需要 effect 的 cleanup 真的会跑。
 * 这两样都不能靠真实等待（慢且不稳定），所以在桩上补两个小的可注入点，
 * 不重写 DOM / React 桩本身。
 * ═══════════════════════════════════════════════════════════════════ */

/** 当前生效的假定时器（null = 用 Node 真实定时器）。 */
let fakeTimers = null

/**
 * 安装可手动推进的假定时器。
 *
 * 只替换 `globalThis.setTimeout / clearTimeout`：client.js 的防抖是裸调用，
 * 因此不用改产品代码就能精确控制「350ms 到了没有」。
 * 其余异步（fetch 桩、Promise）照常走微任务。
 * @returns 句柄：`{ advance(ms), pending(), restore() }`。
 */
export function installFakeTimers() {
  if (fakeTimers !== null) return fakeTimers
  const original = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  }
  const queue = []
  let now = 0
  let nextId = 1

  globalThis.setTimeout = (fn, ms = 0) => {
    const id = nextId
    nextId += 1
    queue.push({ id, at: now + Math.max(0, Number(ms) || 0), fn })
    return id
  }
  globalThis.clearTimeout = (id) => {
    const index = queue.findIndex((timer) => timer.id === id)
    if (index >= 0) queue.splice(index, 1)
  }

  fakeTimers = {
    /** 当前还排队的定时器数量（断言 cleanup 真的清掉了表）。 */
    pending() {
      return queue.length
    },
    /**
     * 推进 ms 毫秒，按到期时间（同刻按入队顺序）执行回调。
     * 回调里新排的定时器只要也落在窗口内会继续执行 —— 与真实定时器一致。
     * 注意：回调里的 Promise 链要由调用方 `await` 一拍再断言。
     */
    advance(ms) {
      now += Math.max(0, Number(ms) || 0)
      for (;;) {
        let due = null
        for (const timer of queue) {
          if (timer.at > now) continue
          if (due === null || timer.at < due.at || (timer.at === due.at && timer.id < due.id)) due = timer
        }
        if (due === null) return
        queue.splice(queue.indexOf(due), 1)
        due.fn()
      }
    },
    restore() {
      globalThis.setTimeout = original.setTimeout
      globalThis.clearTimeout = original.clearTimeout
      fakeTimers = null
    },
  }
  return fakeTimers
}

/**
 * 把设置面板「挂载」一次：执行函数组件、收集并运行 useEffect，返回卸载句柄。
 *
 * 与既有测试的直接渲染（`section.type(props)`，effect 是 no-op）刻意分开：
 * 直接渲染用于测同步闭包，挂载用于测**异步回调在卸载后是否还会 setState**，
 * 以及 effect cleanup 是否清掉了防抖定时器。
 *
 * 组件内部用 `mounted` ref 做闸门（cleanup 置 false），所以：
 *   · 卸载后正常代码不应再调用任何 setter → `setStateCalls` 不增长；
 *   · 若回归发生（少了 ifMounted），计数会立刻上涨。
 * @param render - 零参函数：用当前 context 渲染并返回元素树。
 * @param options - `{ runtime, tab }`：塞进 React context 的运行时与初始标签页。
 * @returns `{ tree, session, setStateCalls, unmount() }`。
 */
export function mountPanel(render, options = {}) {
  if (typeof render !== 'function') throw new TypeError('mountPanel(render): render 必须是函数')
  if (hookSession !== null) throw new Error('mountPanel() 不支持嵌套挂载')

  const session = {
    /** 所有 useState setter 被调用的总次数（卸载后继续计数）。 */
    setStateCalls: 0,
    /** 本次渲染期间声明的 effect（按声明顺序）。 */
    effects: [],
    /** 已运行 effect 返回的 cleanup（按声明顺序）。 */
    cleanups: [],
    unmounted: false,
  }

  setContextValue(options.runtime)
  if (options.tab !== undefined) setStateOverride('wallpaper', options.tab)

  let tree = null
  hookSession = session
  try {
    tree = render()
  } finally {
    clearStateOverride()
    hookSession = null
  }

  // React 在提交后按声明顺序运行 effect；首次挂载所有 effect 都会执行。
  for (const effect of session.effects) {
    const cleanup = effect()
    if (typeof cleanup === 'function') session.cleanups.push(cleanup)
  }

  return {
    tree,
    session,
    /** 当前累计的 setState 次数（断言时取快照做差）。 */
    get setStateCalls() {
      return session.setStateCalls
    },
    /** 卸载：倒序执行 cleanup（与 React 一致），只执行一次。 */
    unmount() {
      if (session.unmounted) return
      session.unmounted = true
      while (session.cleanups.length > 0) {
        const cleanup = session.cleanups.pop()
        cleanup()
      }
    },
  }
}


/**
 * 造一个「会重渲染」的最小渲染器。
 *
 * 为什么需要：默认桩的 useState 是 no-op（挂载时也只计数），所以 Card 的展开/收起、
 * DiagReport 的行展开这些**点击后状态翻转**的语义无法在测试里观察到。这里只把
 * useState / useId 换成按调用顺序存取的槽位：调用方点击按钮（setter 写入槽位）
 * 之后再渲染一次，拿到的就是新状态的树。
 *
 * 限制：槽位按**调用顺序**而不是组件实例，所以只能重渲染同一个组件的同一次调用；
 * 不要拿它渲染整棵面板（不同子组件的 hook 会串到同一组槽位里）。
 *
 * 用法：
 *   const render = createHookRenderer()
 *   let tree = render(() => Card({ title: 'x', defaultOpen: true, children: [] }))
 *   findButton(tree, '收起').props.onClick()
 *   tree = render(() => Card({ title: 'x', defaultOpen: true, children: [] }))
 * @returns `(renderFn) => any`：执行一次渲染并复位游标。
 */
export function createHookRenderer() {
  const slots = []
  return function render(renderFn) {
    if (typeof renderFn !== 'function') throw new TypeError('createHookRenderer()(render): 需要函数')
    if (hookState !== null) throw new Error('createHookRenderer() 的渲染不支持嵌套')
    hookState = { slots, cursor: 0 }
    try {
      return renderFn()
    } finally {
      hookState = null
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════
 * 最小 locale 服务桩
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * 造一个够用的 locale 服务桩：`register(ns, { zh, en })` + `bind(ns)`。
 *
 * 为什么需要：`apply(ctx)` 现在要验证「设置导航标签真的跟随界面语言」。
 * 只断言 label() 返回某个字符串没有意义 —— 它仍可能是硬编码的。这里让
 * stub 保存字典并允许运行时切换 `active`，测试就能看到 label() 在不同
 * 语言下读到了不同条目。
 *
 * 只实现 client.js 真正用到的两种方法（整份对象注册、按 ns 绑定），
 * 并做最基本的 active → en → key 回落；不模拟 DSH 的多级语言回退链、
 * 复数、插值等能力 —— 桩越大越容易测到桩自己。
 * @param initial - 初始界面语言，默认 'zh'。
 * @returns locale 服务桩。
 */
export function createLocaleStub(initial = 'zh') {
  /** ns → { zh: {...}, en: {...} } */
  const dictionaries = new Map()
  /** 每次 register() 的记录：`{ ns, locales }`。 */
  const registrations = []
  /** bind() 过的命名空间（用来证明 apply 没绕开 locale）。 */
  const boundNamespaces = []
  const bound = new Map()
  let active = initial

  return {
    /** 当前界面语言（测试可读）。 */
    get active() {
      return active
    },
    /** 切换界面语言：此后 bind() 出来的 t 会读新字典。 */
    setActive(locale) {
      active = locale
    },
    /**
     * 注册整份字典（client.js 用的形式）。
     * @param ns - 命名空间。
     * @param localeOrDicts - `{ zh: {...}, en: {...} }`。
     * @returns 空 disposer：测试不模拟注销，apply 的 effect 只需要一个可调用的清理函数。
     */
    register(ns, localeOrDicts) {
      if (localeOrDicts === null || typeof localeOrDicts !== 'object') {
        throw new TypeError('createLocaleStub.register(ns, dicts): 只支持整份字典注册')
      }
      dictionaries.set(ns, { ...(dictionaries.get(ns) ?? {}), ...localeOrDicts })
      registrations.push({ ns, locales: Object.keys(localeOrDicts) })
      return () => {}
    },
    /**
     * 绑定命名空间，返回 `t(key)`。
     *
     * 查找顺序只保留 active → en → key（与 DSH 的「缺键回落英文、再回落键名」
     * 语义一致；本插件只有两种语言，不需要完整回退链）。
     * @param ns - 命名空间。
     * @returns 翻译函数。
     */
    bind(ns) {
      const cached = bound.get(ns)
      if (cached !== undefined) return cached
      boundNamespaces.push(ns)
      const t = (key) => {
        const dicts = dictionaries.get(ns) ?? {}
        const dict = dicts[active] ?? dicts.en
        return dict?.[key] ?? key
      }
      bound.set(ns, t)
      return t
    },
    /** 某个命名空间的字典（断言注册内容用）。 */
    dictionary(ns) {
      return dictionaries.get(ns)
    },
    /** 某个命名空间注册过的语言列表（按注册顺序，去重）。 */
    languages(ns) {
      const found = new Set()
      for (const item of registrations) {
        if (item.ns !== ns) continue
        for (const locale of item.locales) found.add(locale)
      }
      return [...found]
    },
    registrations,
    boundNamespaces,
  }
}

/* ═══════════════════════════════════════════════════════════════════
 * 加载 bundle
 * ═══════════════════════════════════════════════════════════════════ */

/** 单次加载的结果（幂等）。 */
let loading = null

/**
 * 加载 `lib/client.js` 并物化它的工厂函数。
 * @param options - `{ fetch }`：可选的 fetch 桩，返回 `{ status, text() }`。
 * @returns `{ client, registrations, dom, react, storage, requests, setFetchHandler, resetRequests }`
 *   `client` 就是 `module.exports`（ThemeRuntime / defaultConfig / buildCss …）。
 */
export async function loadClient(options = {}) {
  if (loading !== null) return loading
  loading = (async () => {
    const dom = createDom()
    const storage = new Map()
    /** 记录所有 fetch 调用，断言「一次提交」时按 method 过滤。 */
    const requests = []
    let fetchHandler = options.fetch ?? null

    globalThis.document = dom.document
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
      takeRecords() {
        return []
      }
    }
    globalThis.Image = ImageStub
    globalThis.fetch = async (url, init = {}) => {
      const request = {
        url: String(url),
        method: String(init?.method ?? 'GET').toUpperCase(),
        body: init?.body,
      }
      requests.push(request)
      if (fetchHandler !== null) return fetchHandler(request)
      // 默认「什么都成功、什么都不改」：不带 config 字段，避免覆盖调用方的运行时配置。
      return { status: 200, text: async () => JSON.stringify({ ok: true }) }
    }

    const registrations = []
    globalThis.window = {
      __ModuleLoader__: {
        load(registration) {
          registrations.push(registration)
        },
      },
      localStorage: {
        getItem(key) {
          return storage.has(key) ? storage.get(key) : null
        },
        setItem(key, value) {
          storage.set(key, String(value))
        },
        removeItem(key) {
          storage.delete(key)
        },
      },
    }
    // 客户端现在只用 `window.localStorage`，但别名一份可以挡掉「将来写成裸 localStorage」的低级失败。
    globalThis.localStorage = globalThis.window.localStorage

    await import(pathToFileURL(BUNDLE).href)
    if (registrations.length !== 1) {
      throw new Error(`期望 bundle 恰好注册 1 个模块，实际 ${registrations.length} 个`)
    }

    const client = registrations[0].factory((name) => {
      if (name === 'react') return ReactStub
      if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
      throw new Error(`unexpected require("${name}")`)
    })

    return {
      client,
      registrations,
      dom,
      react: ReactStub,
      storage,
      requests,
      setContextValue,
      setStateOverride,
      clearStateOverride,
      setFetchHandler(handler) {
        fetchHandler = handler
      },
      resetRequests() {
        requests.length = 0
      },
    }
  })()
  return loading
}
