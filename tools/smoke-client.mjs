/**
 * 冒烟测试：在 Node 里用最小 DOM/React 桩加载客户端 bundle，
 * 验证「模块包装格式 + 工厂可物化 + CSS 可生成 + apply 不崩」。
 *
 * 用法：node tools/smoke-client.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.resolve(HERE, '..', 'lib', 'client.js')
const source = fs.readFileSync(BUNDLE, 'utf8')

/* ── 最小 DOM 桩 ───────────────────────────────────────────────── */

const created = []

function makeElement(tag) {
  const element = {
    tagName: String(tag).toUpperCase(),
    style: {
      setProperty(key, value) {
        this[key] = value
      },
    },
    dataset: {},
    children: [],
    isConnected: true,
    textContent: '',
    setAttribute(key, value) {
      this[key] = value
    },
    removeAttribute(key) {
      delete this[key]
    },
    appendChild(child) {
      this.children.push(child)
      child.parent = this
      return child
    },
    append(...nodes) {
      for (const node of nodes) this.children.push(node)
    },
    remove() {
      this.isConnected = false
    },
    addEventListener() {},
  }
  created.push(element)
  return element
}

const head = makeElement('head')
const html = makeElement('html')
const body = makeElement('body')

globalThis.document = {
  head,
  body,
  documentElement: html,
  createElement: makeElement,
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
}
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.localStorage = {
  store: new Map(),
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null
  },
  setItem(key, value) {
    this.store.set(key, value)
  },
}
globalThis.fetch = async (url) => ({
  ok: true,
  json: async () => (String(url).includes('/config') ? { ok: true, config: {} } : { ok: true, groups: [] }),
})

/**
 * 渲染期一次性覆盖：把最近一次 `useState(初始值)` 的返回值换成指定值。
 *
 * 按初始值匹配比按调用序号稳定（序号会被子树里的其它 useState 干扰 —— 前两版踩过这个坑）。
 * 但初始值可能重复（例如 folders / gallery 都是 `[]`），所以支持 `nth` 指定第几次出现，
 * 用来精确覆盖某一个 state。用 `__isset` 区分「要覆盖成 undefined」和「不覆盖」。
 */
let stateOverride

/** 与匹配值等价的比较（数组/对象按内容比较，便于用 `[]` 命中等值初始值）。 */
const sameValue = (a, b) => {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => {
    const value = typeof initial === 'function' ? initial() : initial
    if (stateOverride !== undefined && sameValue(stateOverride.match, value)) {
      stateOverride.seen = (stateOverride.seen ?? 0) + 1
      const wanted = stateOverride.nth ?? 1
      if (stateOverride.seen === wanted) {
        // 必须先把替换值取出来再清空 stateOverride —— 否则读到的已经是 undefined，
        // 标签页会被覆盖成 undefined，所有 `tab === '…'` 分支全部落空。
        const replacement = stateOverride.value
        stateOverride = undefined
        return [replacement, () => {}]
      }
    }
    return [value, () => {}]
  },
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  useContext: () => undefined,
  useMemo: (fn) => fn(),
  createContext: (initial) => ({ _current: initial }),
}

const stubs = {
  react: React,
  '@deepseek-ai/dsh-client-ui-primitives': { Switch: () => null },
}

/* ── 加载 bundle ───────────────────────────────────────────────── */

const registrations = []
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration)
    },
  },
}

await import(`file://${BUNDLE.replace(/\\/g, '/')}`)

const check = (label, ok, detail) => {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) process.exitCode = 1
}

check('bundle 注册了一个模块', registrations.length === 1, `id=${registrations[0]?.id}`)
check('模块 id 正确', registrations[0]?.id === 'dsh-theme-studio', String(registrations[0]?.id))

const moduleExports = registrations[0].factory((name) => {
  if (name in stubs) return stubs[name]
  throw new Error(`unexpected require("${name}")`)
})

check('导出 apply', typeof moduleExports.apply === 'function')
check('导出 inject', Array.isArray(moduleExports.inject), JSON.stringify(moduleExports.inject))
check('导出 ThemeRuntime', typeof moduleExports.ThemeRuntime === 'function')
check('导出 buildCss', typeof moduleExports.buildCss === 'function')

/* ── 单测：非 JSON 响应的兜底（0.2.4 用户报障的回归点）─────────────
 *
 * 报障原文：`重置失败：Failed to execute 'json' on 'Response': Unexpected end of JSON input`
 * 成因是宿主半侧的路由**只在启动时注册** —— 「新前端 + 旧宿主」时请求打到不存在的
 * 路径，拿到的是**没有 body 的 404**，`response.json()` 当场抛出上面那句天书。
 * 所以这两个 helper 的行为要直接测，而不是靠字符串断言源码里有没有它。 */

const { readJsonResponse, describeHostFailure } = moduleExports
check('导出 readJsonResponse / describeHostFailure', typeof readJsonResponse === 'function' && typeof describeHostFailure === 'function')

/** 造一个假 Response。 */
const fakeResponse = (status, text) => ({ status, text: async () => text })

const asJson = await readJsonResponse(fakeResponse(200, '{"ok":true,"config":{"a":1}}'))
check('正常 JSON 响应能解析出 body', asJson.body?.ok === true && asJson.status === 200, JSON.stringify(asJson.body))

const asEmpty = await readJsonResponse(fakeResponse(404, ''))
check('★ 空响应体不抛异常，而是 body=null（这就是那句天书的来源）',
  asEmpty.body === null && asEmpty.status === 404 && asEmpty.raw === '')

const asHtml = await readJsonResponse(fakeResponse(500, '<html>oops</html>'))
check('非 JSON 响应体也不抛，原文留在 raw 里',
  asHtml.body === null && asHtml.raw === '<html>oops</html>')

const notFound = describeHostFailure(asEmpty, '重置')
check('★ 404（宿主还没重启）的提示直接点明「重启 dsh web」',
  notFound.includes('重启 dsh web') && notFound.includes('404'), notFound)
check('★ 提示里不再出现那句 json 解析报错',
  !/Unexpected end of JSON input|Failed to execute/.test(notFound), notFound)

const withError = describeHostFailure({ status: 400, body: { ok: false, error: '缺少参数' }, raw: '' }, '重置')
check('响应体自带 error 时优先用它', withError === '缺少参数', withError)
const empty500 = describeHostFailure(asHtml, '重置')
check('其他状态码回落成「HTTP 状态 + 原文摘要」',
  empty500.includes('HTTP 500') && empty500.includes('oops'), empty500)


const defaults = moduleExports.defaultConfig()
const css = moduleExports.buildCss(defaults)
check('CSS 非空', css.length > 500, `${css.length} chars`)
check('CSS 含 token 覆盖', css.includes('--dsw-specific-input-major'))
check('CSS 含外壳透明规则（玻璃生效的前提）', css.includes('.pI_x6G_frame { background: transparent'))
check('分区选择器表含四个分区（0.1.15 起 sidebar + topbar 合并为 bars）',
  Object.keys(moduleExports.REGION_SELECTORS).length === 4 &&
    ['bars', 'input', 'bubble', 'menu'].every((key) => key in moduleExports.REGION_SELECTORS),
  Object.keys(moduleExports.REGION_SELECTORS).join(','))
check('CSS 含暗色分支', css.includes('[data-ds-dark-theme]'))
check('CSS 括号配平', (css.match(/\{/g) ?? []).length === (css.match(/\}/g) ?? []).length,
  `${(css.match(/\{/g) ?? []).length} { vs ${(css.match(/\}/g) ?? []).length} }`)

/* 出厂默认必须是「不修改任何东西」：壁纸原样、界面原样。 */
check('出厂默认不产生任何模糊规则', !css.includes('backdrop-filter: blur'), '应为 0 条')
check('出厂默认壁纸遮罩为 0（不暗化）', /--ds-ts-bg-dim, 0\)/.test(css))
check('出厂默认暗角为 0', /--ds-ts-bg-vignette, 0\)/.test(css))
check('出厂默认分区完全不透明', /--ds-ts-input: rgb\(255 255 255 \/ 1\.000\)/.test(css))

/* 用户把不透明度拉起来后，才应该生成模糊规则。
 * 样本分区用 `input`：它同时有 `background` 与 `box-shadow` 两条声明，比 chat 更能
 * 暴露「规则体拼错」的问题。 */
const glassy = moduleExports.buildCss({
  ...defaults,
  glass: {
    ...defaults.glass,
    input: { enabled: true, opacity: 0.55, blur: 18 },
  },
})
check('调低不透明度后生成模糊规则', glassy.includes('backdrop-filter: blur(18px)'))
check('调低不透明度后生成该分区的选择器', glassy.includes('.uV2eYG_card'))

const accentCss = moduleExports.buildCss({
  ...defaults,
  accent: { enabled: true, rgb: [232, 106, 148], preset: 'sakura' },
})
check('主题色启用时覆盖品牌令牌', accentCss.includes('--dsw-static-deepseek-500'))
check('主题色 RGB 正确', accentCss.includes('232 106 148'))

const opaqueCss = moduleExports.buildCss({
  ...defaults,
  glass: { ...defaults.glass, input: { enabled: true, opacity: 1, blur: 18 } },
})
// 不透明度 100% 时不该输出任何模糊，因为不透明元素上的 backdrop-filter
// 没有视觉效果、只白烧 GPU。
check(
  '不透明度=100% 时不输出该分区的 blur',
  !/\.uV2eYG_card \{[^}]*backdrop-filter: blur/.test(opaqueCss),
)

/* ── 回归（0.1.11）：去掉「画质档位」，模糊上限提到 100px ────────────────
 *
 * 之前上限由 perf 档位决定（省电 10 / 均衡 22 / 高画质 40），用户在界面上
 * 把「模糊」拉到 40 就到头了，再往上没有反应 —— 因为滑块 max 与档位上限
 * 是两层截断，谁都看不出来。现在只有一条固定上限。 */
const atHundred = moduleExports.buildCss({
  ...defaults,
  glass: { ...defaults.glass, input: { enabled: true, opacity: 0.5, blur: 100 } },
})
check('模糊 100px 原样输出（不再被 40px 档位截断）',
  atHundred.includes('backdrop-filter: blur(100px)'), atHundred.match(/backdrop-filter: blur\(\d+px\)/g)?.join(',') ?? '(无)')

const overCap = moduleExports.buildCss({
  ...defaults,
  glass: { ...defaults.glass, input: { enabled: true, opacity: 0.5, blur: 250 } },
})
check('模糊超过 100px 时截到 100px',
  overCap.includes('blur(100px)') && !overCap.includes('blur(250px)'),
  overCap.match(/backdrop-filter: blur\(\d+px\)/g)?.join(',') ?? '(无)')

const negativeBlur = moduleExports.buildCss({
  ...defaults,
  glass: { ...defaults.glass, input: { enabled: true, opacity: 0.5, blur: -30 } },
})
check('负数模糊归零', negativeBlur.includes('blur(0px)') && !negativeBlur.includes('blur(-'),
  negativeBlur.match(/backdrop-filter: blur\([-\d]+px\)/g)?.join(',') ?? '(无)')

/* 回归（0.1.11）：backdrop-filter 里不再有 saturate()。
 * 故意传一个带 saturation 的旧配置进去 —— 参数已废弃，多出来的键必须被忽略。 */
const legacyGlass = moduleExports.buildCss({
  ...defaults,
  glass: { ...defaults.glass, input: { enabled: true, opacity: 0.5, blur: 20, saturation: 2.4 } },
})
check('backdrop-filter 里不再出现 saturate()（旧的 saturation 键被忽略）',
  !/backdrop-filter:[^;]*saturate\(/.test(legacyGlass),
  legacyGlass.match(/backdrop-filter:[^;]*/g)?.join(' | ') ?? '(无)')
check('出厂配置里没有任何分区带 saturation 字段',
  Object.entries(defaults.glass).every(([, value]) => typeof value !== 'object' || !('saturation' in value)),
  Object.keys(defaults.glass).join(','))

/* ── apply 路径 ────────────────────────────────────────────────── */

const effects = []
const registrationsCalls = []
const injected = []
const ctx = {
  effect(fn, label) {
    effects.push(label ?? 'unnamed')
    return () => {}
  },
  locale: { register: () => () => {} },
  slots: {
    inject(name, fn) {
      injected.push(name)
      fn()
      return () => {}
    },
    register(options, component) {
      registrationsCalls.push({ options, component })
      return () => {}
    },
  },
}

moduleExports.apply(ctx)
check('注册了 settings.section', injected.includes('settings.section'), injected.join(','))
check('注册项 id 正确', registrationsCalls[0]?.options?.id === 'theme-studio', String(registrationsCalls[0]?.options?.id))
check('注册项带组件', typeof registrationsCalls[0]?.component === 'function')
check('注册了 effect', effects.length > 0, effects.join(' | '))

await new Promise((resolve) => setTimeout(resolve, 80))
const styleTags = head.children.filter((child) => typeof child.textContent === 'string' && child.textContent.length > 0)
check('样式已注入 head', styleTags.length > 0, `${styleTags.length} 个 <style>，共 ${styleTags.reduce((n, t) => n + t.textContent.length, 0)} 字符`)
check('样式带 data-plugin 归属', styleTags.every((tag) => tag.dataset.plugin === 'dsh-theme-studio'))
check('背景层未在无壁纸时创建', html.children.filter((child) => child.id === 'dsh-theme-studio-bg').length === 0)
check('导出分区选择器表', typeof moduleExports.REGION_SELECTORS === 'object' && moduleExports.REGION_SELECTORS !== null)

/* ── 真正把面板渲染一遍 ─────────────────────────────────────────
 *
 * 这一步是必须的：函数组件体里的代码（含所有 useCallback 定义）只有在渲染时才执行，
 * 所以「给未声明变量赋值」这类手误可以躲过 node --check，也能躲过只调用 apply() 的
 * 检查 —— 曾把 `const applyWallpaper = …` 写成裸赋值，只有打开面板才会整块炸掉。
 * 这里用极简桩把四个标签页各渲染一次，任何此类错误都会当场抛出来。
 * ───────────────────────────────────────────────────────────────── */

const Section = registrationsCalls[0]?.component
check('拿到面板组件', typeof Section === 'function')

/**
 * 递归把 React 元素树摊平成字符串，便于断言文案。
 *
 * 关键点：遇到**函数组件**必须真的调用它 —— 面板本身被包在
 * `RUNTIME_CONTEXT.Provider` 里，只遍历 children 的话会在 Provider 处停住，
 * 一个字符都取不到（这正是第一版渲染测试全部失败的原因）。
 * @param node - 元素、字符串或数组。
 * @param out - 累积输出。
 * @param depth - 递归深度保护。
 * @returns 文本片段数组。
 */
function flatten(node, out = [], depth = 0) {
  if (depth > 40 || node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out, depth + 1)
    return out
  }
  if (typeof node !== 'object') return out
  // 函数组件：调用它（它的输出才是真正的 UI 树）。
  // 注意不要在这里重置 useStateCalls —— 最外层的 Section 就靠它认领标签页覆盖，
  // 复位会让面板永远停在第一个标签页（这是第一版渲染测试踩过的坑）。
  if (typeof node.type === 'function') {
    flatten(node.type({ ...(node.props ?? {}), t: (key) => key }), out, depth + 1)
    return out
  }
  for (const child of [].concat(node.children ?? [])) flatten(child, out, depth + 1)
  return out
}

/**
 * 渲染一个标签页并**立刻**展开成文本。
 *
 * 必须「渲染 + 展开」在一次覆盖生效期内完成：React 元素是惰性的，元素树只是数据，
 * 函数组件要等到 flatten 才会被调用；如果先渲染完四个标签页再统一 flatten，
 * 覆盖早已被清空，四个页面会全部渲染成同一个标签页。
 * @param tab - 目标标签页 id。
 * @returns 该页的纯文本。
 */
/**
 * 渲染一个标签页并**立刻**展开成文本。
 *
 * 必须「渲染 + 展开」在一次覆盖生效期内完成：React 元素是惰性的，元素树只是数据，
 * 函数组件要等到 flatten 才会被调用；如果先渲染完四个标签页再统一 flatten，
 * 覆盖早已被清空，四个页面会全部渲染成同一个标签页。
 * @param tab - 目标标签页 id。
 * @returns 该页的纯文本。
 */
function renderTab(tab) {
  stateOverride = { match: 'wallpaper', value: tab }
  const element = Section({ t: (key) => key })
  const text = flatten(element, [], 0).join(' ')
  stateOverride = undefined
  return text
}

/**
 * 在某个标签页的元素树里按组件名找出节点的 props。
 *
 * 比「整页文本断言」稳：卡片正文的渲染受 state 桩影响，逐字符断言容易假失败；
 * 直接取组件的 props 就能精确验证「传下去的选项列表」本身是否正确。
 * @param tab - 目标标签页 id。
 * @param componentName - 组件的函数名（如 'SelectRow' / 'SliderRow'）。
 * @returns 该组件的 props 数组。
 */
function findComponentProps(tab, componentName) {
  const found = []
  stateOverride = { match: 'wallpaper', value: tab }
  const root = Section({ t: (key) => key })
  stateOverride = undefined
  const seen = new Set()
  const walk = (node, depth) => {
    if (depth > 30 || node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (typeof node.type === 'function') {
      if (node.type.name === componentName) found.push(node.props ?? {})
      if (seen.has(node.type)) return // 避免组件自递归
      seen.add(node.type)
      walk(node.type({ ...(node.props ?? {}), t: (key) => key }), depth + 1)
      seen.delete(node.type)
      return
    }
    for (const child of [].concat(node.children ?? [])) walk(child, depth + 1)
  }
  walk(root, 0)
  return found
}

const texts = {}
const renderErrors = []
for (const tab of ['wallpaper', 'glass', 'accent', 'misc']) {
  try {
    texts[tab] = renderTab(tab)
  } catch (error) {
    texts[tab] = ''
    renderErrors.push(`${tab}: ${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`)
  }
}
check('四个标签页都能渲染而不抛错', renderErrors.length === 0, renderErrors.join(' | ') || 'ok')
check(
  '四个标签页内容各不相同（覆盖生效）',
  new Set(Object.values(texts).map((text) => text.slice(0, 200))).size === 4,
  `唯一长度=${new Set(Object.values(texts)).size}`,
)

/* 页面级文案。这几条只依赖「组件被调用且不抛错」，与 state 桩的精确行为无关。 */
const wallpaperText = texts.wallpaper
check('壁纸页含中文标题', wallpaperText.includes('图片来源') && wallpaperText.includes('壁纸表现'), wallpaperText.slice(0, 120) || '(空)')
check('壁纸页含候选卡片', wallpaperText.includes('壁纸候选'))
check('玻璃页含四个分区名称（边栏 = 侧边栏 + 顶边栏）', ['边栏', '输入框', '气泡', '弹层菜单']
  .every((name) => texts.glass.includes(name)), texts.glass.slice(0, 120) || '(空)')
/* 这里**不能**直接断言「页面文本里没有『侧边栏』三个字」——「边栏」卡片的说明文字
 * 就是「侧边栏与顶边栏，共用一份参数」，那是有意写上去的。所以要判的是
 * 「没有以这两个名字为**标题**的分区卡片」：标题在 DOM 里紧跟在「收起/展开」按钮之后。 */
check('玻璃页没有以「侧边栏 / 顶边栏」为标题的分区卡片',
  !/收起\s*侧边栏/.test(texts.glass) && !/收起\s*顶边栏/.test(texts.glass),
  texts.glass.slice(0, 240) || '(空)')
check('玻璃页不再出现对话区分区', !texts.glass.includes('对话区'), texts.glass.slice(0, 200) || '(空)')
check('玻璃页不再出现设置界面分区', !texts.glass.includes('设置界面'), texts.glass.slice(0, 200) || '(空)')
// 主题色页只断言到「页面标题渲染出来了」为止：这张卡片的正文受 state 桩影响会时有时无
// （同一份 Card 代码在「其他」页能正常展开），是个不可靠的断言点，留着只会造成假失败。
// 控件本身的存在性由下面的静态检查覆盖。
check('主题色页标题渲染', texts.accent.includes('主题色'), texts.accent.slice(0, 160) || '(空)')
check('其他页含维护与自检', texts.misc.includes('维护') && texts.misc.includes('分区命中自检'), texts.misc.slice(0, 160) || '(空)')
/* 0.2.3：其他页新增「重置」卡片 —— 用户要的是「重置本插件造成的所有效果」。
 * 它与旁边那个「一键关闭并复原」（只把 enabled 置 false）是两件不同的事，
 * 所以两个入口都要在，且重置必须带两步确认。 */
check('★ 其他页新增「重置」卡片，与「维护」并存',
  texts.misc.includes('重置') && texts.misc.includes('维护'), texts.misc.slice(0, 200))
/* ⚠️ 重置卡片是 `defaultOpen: false`，所以它的**正文**不会出现在渲染文本里。
 * 0.2.5 用户明确要求：卡片里**只留功能**，不要再放解释性描述段落 ——
 * 所以这里不再断言「说明文案存在」，反过来由下面的「只留功能按钮」那条守着。
 * 唯一保留的说明性文字是执行前的确认问句（那是两步确认的一部分，不是描述）。 */
check('★ 重置默认只显示按钮（两步确认，不一点就执行）',
  /* 精确到确认问句本身：别的卡片的副标题里就有「确认」二字（自检那张卡是
   * 「确认毛玻璃到底作用到了哪些元素」），用单字判会假失败。 */
  !texts.misc.includes('确认重置全部配置') && !texts.misc.includes('确认清理本地缓存'), texts.misc.slice(0, 220))
check('★ 重置走宿主 /api/reset，并用返回的出厂配置覆盖本地',
  source.includes('${API}/reset') && source.includes('purgeFiles') &&
    /const fresh = result\.body\.config \?\? defaultConfig\(\)/.test(source))
/* 0.2.5 用户要求：卡片里**只留功能**，别把解释性描述塞进界面。
 * 同时「清理本地缓存」收窄为**只清缓存** —— 它复用 `/api/reset?purgeFiles=true`，
 * 而那个端点会顺带把配置写回出厂，所以必须把当前配置原样写回去，
 * 否则点一下「清理本地缓存」会莫名其妙丢掉全部设置。 */
check('★ 重置卡片只留功能按钮，没有解释性描述段落',
  !source.includes('这一项不是「卸载插件」') && !source.includes('关闭只是把效果撤掉、配置留着') &&
    !source.includes("tr('重置并清理数据文件')") && !source.includes("tr('重置并删除插件文件')"))
check('★ 两个按钮是「重置配置」与「清理本地缓存」',
  source.includes("tr('重置配置')") && source.includes("tr('清理本地缓存')"))
check('★ 「清理本地缓存」只清缓存：清完必须把当前配置原样写回去',
  source.includes('const purgeCache = async () =>') && source.includes('const before = runtime.config') &&
    source.includes('await putConfig(before)'))
check('★ 非 JSON 响应要能翻译成人话（本轮报障的回归点）',
  source.includes('async function readJsonResponse') && source.includes('function describeHostFailure') &&
    !/await response\.json\(\)/.test(source))
check('★ 404（宿主还没重启）的提示里要说清「重启 dsh web」',
  source.includes('宿主没有这个接口') && source.includes('重启 dsh web'))
check('面板不含英文界面词', !/\b(Wallpaper|Glass|Theme color|Master switch|Source|Opacity|Enable)\b/.test(
  Object.values(texts).join(' '),
))

/* 静态检查：控件确实在源码里被使用、且文案是中文。
   这里刻意不逐个数渲染出的控件数量 —— 那依赖 state 桩的精确行为，
   假失败会掩盖真问题；要抓的是「整块渲染抛错」这类致命问题，上面的渲染断言已经覆盖。
   注意：`source`（bundle 源码）在文件开头就已读入。 */
check('候选缩略图带悬停删除按钮', source.includes('ds-ts-thumb-del') && source.includes("'✕'"))
/* 0.2.0：删除语义按来源分三种，aria-label 必须给出真实语义。
 * ⚠️ 这条断言读的是 **bundle 源码（含注释）** —— 上一版把「文件夹来源只从候选墙移除」
 * 这句话写进了注释，于是旧文案被注释里的字样**假通过**了。改断言时顺手把注释里的
 * 旧字样也换掉，别让注释替代码背书。 */
check('删除文案按来源区分：上传的图是真删、登记目录里的原图只移出视图',
  source.includes("tr('删除这张上传的图')") && source.includes("tr('从候选墙移除')") &&
    !source.includes("tr('移出候选')") && !source.includes("tr('恢复已移除')"))
check('三个分区都有滑块控件', ['不透明度', '模糊'].every((label) => source.includes(`tr('${label}')`)))
check('R/G/B 滑块标签存在', source.includes("['R 红', 'G 绿', 'B 蓝']"))

/* 回归（0.1.11）：设置界面上不再有「画质档位」，也不再有每分区的「饱和度」滑块。
 * 注意两点：
 *   ·「饱和度」三个字在壁纸页仍然合法（那是给壁纸本身调色的），所以只断言**玻璃路径**；
 *   · 注释里刻意留着「已移除」的历史说明，因此判定要先把注释行剔掉再搜。 */
const codeOnly = source
  .split('\n')
  .filter((line) => {
    const trimmed = line.trim()
    return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
  })
  .join('\n')

check('不再读写每分区的 glass.*.saturation',
  !codeOnly.includes('${region.key}.saturation') && !codeOnly.includes('glass.${region.key}.saturation'),
  (codeOnly.match(/[^\n]*\.saturation[^\n]*/g) ?? []).map((line) => line.trim().slice(0, 60)).join(' || ') || '(无)')
/* 回归（0.2.0）：`wallpaper.hidden` 那套「已移除候选」机制整体拆掉。
 * 必须用 codeOnly 判 —— 注释里刻意留着这段历史说明（否则下一个人会把它写回来）。 */
check('代码里不再有 hidden 名单与恢复入口（注释里的历史说明不算）',
  !codeOnly.includes('wallpaper.hidden') && !codeOnly.includes('restoreAll') &&
    !codeOnly.includes('hiddenCount') && !codeOnly.includes("patch('wallpaper.hidden'"),
  (codeOnly.match(/[^\n]*hidden[^\n]*/gi) ?? []).map((line) => line.trim().slice(0, 70)).join(' || ') || '(无)')
check('代码里不再有「已移除 N 张」这类统计文案（注释不算）',
  /* 精确匹配旧句式，别笼统禁掉「已移除」三个字：0.2.2 新增的
   * 「已移除最后一个登记目录」是合法文案，被笼统判定误伤过一次。 */
  !/已移除[^`'\n]{0,16}张/.test(codeOnly),
  (codeOnly.match(/[^\n]*已移除[^\n]*/g) ?? []).join(' || ') || '(无)')
check('「画质档位」与 perf 参数已从代码里消失（注释里的历史说明不算）',
  !codeOnly.includes('画质档位') && !codeOnly.includes('PERF_CAP') &&
    !codeOnly.includes('config.perf') && !codeOnly.includes("patch('perf'") &&
    !/\bcap\(/.test(codeOnly),
  '')
check('模糊上限是 100px 常量', codeOnly.includes('const MAX_BLUR = 100'))
check('分区模糊滑块用上限常量而不是硬编码 40',
  codeOnly.includes('max: MAX_BLUR') && !/label: tr\('模糊'\)[\s\S]{0,120}max: 40/.test(codeOnly))

/* 回归：一律不得使用原生 title —— 那会弹出浏览器自带的文件名提示，纯插件侧无法拦截。 */
check('缩略图不再使用原生 title 提示', !/'title':/.test(source) && !/^\s*title: name/m.test(source))
check('删除按钮不再使用原生 title 提示', !/title: label/.test(source))
/* 用户明确要求：悬停 ✕ 时不显示任何文字，所以自绘气泡也一并去掉。 */
check('删除按钮悬停不再显示文字气泡', !source.includes('ds-ts-thumb-tip') && !/role: 'tooltip'/.test(source))
/* 回归：删除按钮里不能再塞文案 —— 缩略图的 overflow:hidden 会把它裁掉（实测只剩「移」）。 */
check('删除按钮内不放文案', !source.includes('ds-ts-thumb-del-text'))
/* 回归：文件名角标必须用专属类名。写通配的 `.ds-ts-thumb span` 会把删除按钮内部的
   文案 span 一起拉成整行，文字溢出、按钮看起来「偏出去」。
   判定方式：只认「真的是一条 CSS 规则」的行（同一行里出现 { 且以 } 结束），
   这样修复说明的注释（会引用这条旧选择器）不会自指误报。 */
const cssRuleLines = source.split('\n').filter((line) => line.includes('{') && line.trimEnd().endsWith('}'))
check('文件名角标使用专属类名（不再通配 span）',
  cssRuleLines.some((line) => line.includes('.ds-ts-thumb-name {')) &&
    !cssRuleLines.some((line) => line.includes('.ds-ts-thumb span {')))

/* 回归：已删除的两个分区必须**彻底不受本插件影响**（sidebar 0.1.9 / topbar 0.1.12）。
 *
 * 侧栏毛玻璃先后试过两种层级方案都出现「模糊断层」（用户实测）：
 *   · 模糊放在侧栏**子元素**上 → 子元素采到的 backdrop 是父级铺好的平膜，
 *     模糊平膜等于没模糊，观感是「一层平白膜 + 只有控件有边界」；
 *   · 模糊放在**根容器**上 → 整块是均匀磨砂了，但控件自身底色叠在上面又成了第二层，
 *     且根容器的 backdrop-filter 会把设置弹窗（fixed）锁进侧栏 280×807。
 * 用户要求整块删掉重做，因此断言的是**删除**本身。
 * 顶边栏是「模糊等代码全部删除」，删的是 `--ds-ts-topbar` 变量 + `.wSkVaW_header` 那条规则。
 *
 * 关键：这里刻意把**所有分区都开到半透明**再生成 CSS ——
 * 否则「默认配置下没有这些选择器」可能只是因为默认值中立，而不是代码真的删干净了。 */
const allGlassy = {
  ...defaults,
  glass: {
    ...Object.fromEntries(Object.keys(defaults.glass)
      .filter((key) => typeof defaults.glass[key] === 'object')
      .map((key) => [key, { enabled: true, opacity: 0.5, blur: 20 }])),
    border: 0.6,
    highlight: 0.5,
  },
}
const noRemovedCss = moduleExports.buildCss(allGlassy)

/* ── 边栏（0.1.15 重写：sidebar + topbar 合并，膜+模糊落在 ::before 上） ──
 *
 * 这几条是本分区最容易回退的地方，逐条钉住：
 *   · 元素自身绝不能带 backdrop-filter —— 那会成了 position:fixed 的包含块，
 *     而设置弹窗就渲染在侧栏子树内部，弹窗会被锁进 280×807（0.1.7 的真实故障）。
 *   · 膜与模糊必须在同一个元素上（否则重演「模糊一层平膜等于没模糊」）。
 *   · 不需要 :has() 让位规则 —— 伪元素方案从结构上就不产生包含块。 */
check('边栏：膜与模糊都落在 ::before 上',
  /\] \.hHd-Xa_root::before,/.test(noRemovedCss) && /\] \.wSkVaW_header::before \{/.test(noRemovedCss))
check('边栏：伪元素同时带 background-color 与 backdrop-filter',
  /\.hHd-Xa_root::before,[\s\S]*?background-color: var\(--ds-ts-bars\)[\s\S]*?backdrop-filter: blur\(20px\)/.test(noRemovedCss))
check('边栏：元素自身没有 backdrop-filter（否则会困住设置弹窗）',
  !/\] \.(?:hHd-Xa_root|wSkVaW_header) \{[^}]*backdrop-filter/.test(noRemovedCss))
check('边栏：剥掉侧栏外侧那层实色（否则伪元素采到的是平色）',
  noRemovedCss.includes('.pI_x6G_sidebarCol { background: transparent !important; }'))
/* ★ 侧栏实色的第三个来源：会话列表底部的渐隐遮罩消费同一个 token（0.1.17）。 */
check('★ 边栏：sidebar-fill 在侧栏内被就地覆盖为透明，且没有写到全局',
  noRemovedCss.includes('] .hHd-Xa_root { --dsw-specific-sidebar-fill: transparent !important; }') &&
    !/body \{[^}]*--dsw-specific-sidebar-fill/.test(noRemovedCss))
check('边栏：没有 :has() 让位规则（伪元素方案不需要）',
  !noRemovedCss.includes(':has(.VOzbGW_overlay)'))
/* ★ 真实故障的回归点（0.1.16）：元素自身带 z-index 会创建层叠上下文，
 * 把内部的设置弹窗（z-index: 1000 的 fixed 元素）关起来，弹窗被对话界面盖住。 */
check('★ 边栏：元素自身不加 z-index，壁纸层改为 -2',
  !/\] \.(?:hHd-Xa_root|wSkVaW_header) \{[^}]*z-index/.test(noRemovedCss) &&
    noRemovedCss.includes('#dsh-theme-studio-bg { position: fixed; inset: 0; z-index: -2;'))
check('边栏：没有回到旧的 --ds-ts-topbar / --ds-ts-sidebar 变量命名',
  noRemovedCss.includes('--ds-ts-bars') && !noRemovedCss.includes('--ds-ts-topbar') &&
    !noRemovedCss.includes('--ds-ts-sidebar'))
check('边栏已覆盖 --dsw-specific-sidebar-fill 之外的路径（侧栏两层实色都剥掉）',
  noRemovedCss.includes('.pI_x6G_sidebarCol') && noRemovedCss.includes('.hHd-Xa_root'))

/* ── 对话区（0.1.13 删） ──
 * 它的两条选择器都是顶边栏的祖先，所以必须连中心列容器一起断言「不再被命中」——
 * 只看「表里没有 chat 这个键」是查不出「选择器挂到别的分区名下」的。 */
check('全部分区开到半透明时 CSS 仍不含 .pI_x6G_centerCol 选择器',
  !noRemovedCss.includes('.pI_x6G_centerCol'), (noRemovedCss.match(/\.pI_x6G_centerCol\S*/g) ?? []).join(',') || '(无)')
check('全部分区开到半透明时 CSS 仍不含 .wSkVaW_root 选择器',
  !noRemovedCss.includes('.wSkVaW_root'), (noRemovedCss.match(/\.wSkVaW_root\S*/g) ?? []).join(',') || '(无)')
check('不再生成顶边栏时代的老变量 --ds-ts-topbar', !noRemovedCss.includes('--ds-ts-topbar'))

/* ── 设置界面（0.1.14 删） ──
 * 除了元素选择器，它还绑过三条 token，一并断言。 */
check('全部分区开到半透明时 CSS 仍不含 .VOzbGW_panel / .VOzbGW_mask 选择器',
  !noRemovedCss.includes('.VOzbGW_panel') && !noRemovedCss.includes('.VOzbGW_mask'),
  (noRemovedCss.match(/\.VOzbGW_\S*/g) ?? []).join(',') || '(无)')
check('不再生成设置界面专用变量 --ds-ts-panel', !noRemovedCss.includes('--ds-ts-panel'))
check('不再接管设置遮罩的模糊 --dsw-mask-blur', !noRemovedCss.includes('--dsw-mask-blur'))
check('--dsw-alias-bg-layer-1 与 --dsw-alias-bg-overlay 已还给 DSH 原生',
  !/--dsw-alias-bg-layer-1\s*:/.test(noRemovedCss) && !/--dsw-alias-bg-overlay\s*:/.test(noRemovedCss))

/* ── 四个旧分区键都不该复活 ──
 * 注意 sidebar / topbar 也算「旧键」：0.1.15 的重写用的是全新的 `bars`。 */
for (const [key, zh] of [['sidebar', '侧边栏'], ['topbar', '顶边栏'], ['chat', '对话区'], ['panel', '设置界面']]) {
  check(`默认配置 glass 里没有旧键 ${key}`, !(key in defaults.glass), Object.keys(defaults.glass).join(','))
  check(`分区选择器表里没有旧键 ${key}`, !(key in moduleExports.REGION_SELECTORS),
    Object.keys(moduleExports.REGION_SELECTORS).join(','))
  check(`分区定义表里没有旧键 ${key}`, !moduleExports.REGIONS.some((region) => region.key === key),
    moduleExports.REGIONS.map((region) => region.key).join(','))
  check(`分区定义表里没有「${zh}」这个分区名`, !moduleExports.REGIONS.some((region) => region.zh === zh))
}

check('其余三个分区照旧收到模糊规则（不是把整块玻璃一起删了）',
  ['uV2eYG_card', 'Sixlwa_bubble', 'bRhRbq_panel']
    .every((cls) => noRemovedCss.includes(cls)))
/* allGlassy 是「所有分区都开到半透明」的最激进场景，这份 CSS 里也不该再出现 saturate()。 */
check('全部分区开到半透明时 backdrop-filter 里仍无 saturate()',
  !/backdrop-filter:[^;]*saturate\(/.test(noRemovedCss),
  noRemovedCss.match(/backdrop-filter:[^;]*/g)?.join(' | ') ?? '(无)')

/**
 * 渲染候选墙（空态）。
 *
 * 只做「整页能渲染」的冒烟；缩略图内部结构与事件隔离由下面直接调用 Thumb 的测试覆盖 ——
 * 往 state 桩里塞候选数据太脆（folders / gallery 的初始值都是 []，序号猜不准），
 * 而 Thumb 是纯展示组件，直接调用它既真实又稳定。
 */
function renderWallpaperTab() {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, groups: [], hiddenCount: 0 }) })
  try {
    stateOverride = { match: 'wallpaper', value: 'wallpaper' }
    const element = Section({ t: (key) => key })
    return { element, text: flatten(element, [], 0).join(' ') }
  } catch (error) {
    return { element: null, text: '', error: String(error?.message ?? error) }
  } finally {
    stateOverride = undefined
    globalThis.fetch = originalFetch
  }
}

const wallpaperTab = renderWallpaperTab()
check('候选墙空态渲染正常',
  wallpaperTab.element !== null && wallpaperTab.text.includes('壁纸候选'),
  wallpaperTab.error ?? 'ok')

/* ── 直接测试 Thumb：结构与事件隔离 ──────────────────────────────
 *
 * 真实事故回归：✕ 曾经嵌在可点击的缩略图容器里，点一次会同时删除并应用这张图
 * （表现为「删了但壁纸还是换成了它」）。靠 stopPropagation 拦不可靠，
 * 正确做法是让「选图」与「删除」成为并列的兄弟节点。
 * ─────────────────────────────────────────────────────────────── */

const Thumb = moduleExports.Thumb
check('导出 Thumb 组件', typeof Thumb === 'function')

const baseProps = {
  src: 'X:/候选/示例.jpg',
  name: '示例.jpg',
  active: false,
  kind: 'folder',
  label: '移出候选',
  onPick: () => {},
  onRemove: () => {},
}
const thumbTree = Thumb(baseProps)
check('Thumb 渲染两个子节点（选图 + 删除）', (thumbTree.children ?? []).length === 2,
  `children=${(thumbTree.children ?? []).length}`)

const pickChild = (thumbTree.children ?? []).find((child) => String(child?.props?.className ?? '').includes('ds-ts-thumb-pick'))
const delChild = (thumbTree.children ?? []).find((child) => String(child?.props?.className ?? '').includes('ds-ts-thumb-del'))
check('选图是独立按钮', pickChild !== undefined && pickChild.type === 'button')
check('删除是独立按钮', delChild !== undefined && delChild.type === 'button')
check('✕ 按钮里只有图标、没有文案',
  (delChild?.children ?? []).length === 1 && (delChild?.children ?? [])[0]?.children?.[0] === '✕')
check('✕ 用 aria-label 保留语义，且无 title、无气泡',
  delChild?.props?.['aria-label'] === '移出候选' && delChild?.props?.title === undefined)
check('选图按钮无 title，用 aria-label 承载名称',
  pickChild?.props?.title === undefined && pickChild?.props?.['aria-label'] === '示例.jpg')

/** 记录每个 handler 被调用了多少次，验证事件隔离。 */
const tally = { pick: 0, remove: 0 }
const isolated = Thumb({ ...baseProps, onPick: () => (tally.pick += 1), onRemove: () => (tally.remove += 1) })
const isolatedDel = (isolated.children ?? []).find((child) => String(child?.props?.className ?? '').includes('ds-ts-thumb-del'))
const isolatedPick = (isolated.children ?? []).find((child) => String(child?.props?.className ?? '').includes('ds-ts-thumb-pick'))
isolatedDel.props.onClick()
check('点 ✕ 只触发删除、不触发选图', tally.remove === 1 && tally.pick === 0, JSON.stringify(tally))
isolatedPick.props.onClick()
check('点缩略图只触发选图、不再触发删除', tally.pick === 1 && tally.remove === 1, JSON.stringify(tally))

/* ── 直接测试 DiagReport：截断与误报两个真实故障的回归点 ────────────
 *
 * 事故 1（截断）：整份报告原先挤在一条 `.ds-ts-mono` 里，而那条规则带
 *   white-space: nowrap + text-overflow: ellipsis（本是给「文件夹 / URL 列表」
 *   的一行一短路径用的），6 条选择器拼成的长串必然被省略号吃掉，
 *   用户看到的就是「后面似乎因为显示区域不够而被截断」。
 * 事故 2（误报）：「弹层菜单」被标成红色的「未命中」，而它的选择器全是条件渲染的浮层
 *   （在设置弹窗里跑自检，它们一个都不在 DOM 里），0 命中是必然的正常状态，不是故障。
 *   后来发现「气泡」是**同一类**：`.Sixlwa_bubble` 只在会话里有用户消息时才渲染，
 *   空会话里 0 命中同样是必然 —— 两个都归为「条件分区」，用中性色显示。
 * ─────────────────────────────────────────────────────────────── */

const DiagReport = moduleExports.DiagReport
check('导出 DiagReport 组件', typeof DiagReport === 'function')

/* 原型数据取真实形状：6 条 menu 选择器全部 0 命中；气泡也是条件分区。 */
const menuSelectors = ['\.bRhRbq_panel', '\.JObwrW_panel', '\.mufS8W_card', '\.Nqubda_panel', '\.ZKlsPq_menu', '[class*="_menu_"]']
const diagItems = [
  {
    region: 'bars', zh: '边栏', note: '', required: true, ok: true, matched: 2, total: 2, invalid: 0,
    hits: [
      { selector: '.hHd-Xa_root', count: 1, sample: 'div.hHd-Xa_root' },
      { selector: '.wSkVaW_header', count: 1, sample: 'header.wSkVaW_header' },
    ],
  },
  {
    // 条件分区之一：空会话里 0 命中（气泡只在会话有用户消息时才存在）
    region: 'bubble', zh: '气泡', note: '气泡只在当前会话里有你的消息时才存在。',
    required: false, ok: true, matched: 0, total: 2, invalid: 0,
    hits: [
      { selector: '.Sixlwa_bubble', count: 0, sample: '' },
      { selector: '.Sixlwa_fileCard', count: 0, sample: '' },
    ],
  },
  {
    // 条件分区之二：五条浮层都不在 DOM 里
    region: 'menu', zh: '弹层菜单', note: '本区主要靠令牌覆盖生效，元素规则只是条件。',
    required: false, ok: true, matched: 0, total: 6, invalid: 0,
    hits: menuSelectors.map((selector) => ({ selector, count: 0, sample: '' })),
  },
]

/**
 * 把一个 DiagReport 展开成纯文本。
 *
 * 必须「渲染 + 展开」在一次 stateOverride 生效期内完成：React 元素是惰性的，
 * `DiagReport(...)` 只是数据，`useState` 要等函数组件被**调用**时才跑 —— 而函数组件
 * 正是被 `flatten` 调用的。上一版先渲染再 flatten，覆盖早已清空，展开态根本没生效。
 * @param expandedRegions - 要展开的分区键列表。
 * @returns 报告全文。
 */
function renderDiag(expandedRegions) {
  const open = {}
  for (const key of expandedRegions) open[key] = true
  stateOverride = { match: {}, value: open }
  try {
    return flatten(DiagReport({ items: diagItems }), [], 0).join(' ')
  } finally {
    stateOverride = undefined
  }
}

const diagCollapsed = renderDiag([])
/* 判「文案」时不要数整段里「正常」出现了几次 —— 摘要里也有这两个字。
 * 精确断言改成逐行的 `命中数 / 总数 状态` 片段，等于把用户看到的那一行钉住。 */
check('★ 条件分区（气泡 / 弹层菜单）0 命中显示为「正常」而不是「未命中」',
  diagCollapsed.includes('气泡 0 / 2 正常') && diagCollapsed.includes('弹层菜单 0 / 6 正常') &&
    !diagCollapsed.includes('未命中'),
  diagCollapsed.slice(0, 150))
check('分区行显示 命中数 / 总数',
  diagCollapsed.includes('2 / 2') && diagCollapsed.includes('0 / 6'), diagCollapsed.slice(0, 90))

/* 「不标红」= 那一行的状态 span 带 data-tone=soft。直接查渲染出来的元素树。 */
stateOverride = { match: {}, value: {} }
const diagTree = DiagReport({ items: diagItems })
stateOverride = undefined
/**
 * 在渲染出来的元素树里按 className 找节点（递归，且**不调用**函数组件 —— 元素树是数据）。
 *
 * 必须递归：`h('div', props, A, B)` 会把可变参数原样收进 `children = [A, B]`，
 * 所以多子节点的那一层仍是数组，只扫一层会全部漏掉（这个坑刚踩过）。
 * @param node - 起点（元素树节点或它的 children 数组）。
 * @param className - 目标类名。
 * @returns 命中的节点数组。
 */
function findByClass(node, className) {
  const found = []
  if (node === null || node === undefined) return found
  if (Array.isArray(node)) {
    for (const child of node) found.push(...findByClass(child, className))
    return found
  }
  if (typeof node !== 'object') return found
  if (node.props?.className === className) found.push(node)
  found.push(...findByClass(node.children ?? [], className))
  return found
}

const diagRows = findByClass(diagTree, 'ds-ts-diag-row')
const toneOf = (row) => {
  const status = findByClass(row, 'ds-ts-diag-status')[0]
  return status?.props?.['data-tone']
}
check('★ 必需分区标绿、条件分区标灰（不标红）',
  diagRows.length === 3 && diagRows.map(toneOf).join(',') === 'ok,soft,soft',
  `rows=${diagRows.length} tones=${diagRows.map(toneOf).join(',')}`)

/* 展开必须真的看到**全部** 6 条选择器，一条都不能少（原先只显示得下前 5 条）。 */
const menuDetail = renderDiag(['menu'])
check('★ 展开后 6 条选择器一条不少（截断故障的回归点）',
  menuSelectors.every((selector) => menuDetail.includes(selector)),
  `缺：${menuSelectors.filter((selector) => !menuDetail.includes(selector)).join(' ') || '无'}`)
check('★ 未命中的选择器也照样列出来（不再只列命中的）',
  menuDetail.includes('.Nqubda_panel') && menuDetail.includes('.ZKlsPq_menu'))
check('展开后给出 0 命中的解释',
  menuDetail.includes('令牌覆盖'), menuDetail.slice(0, 140))
check('条件分区的解释也会显示（气泡那行）',
  renderDiag(['bubble']).includes('有你的消息'), renderDiag(['bubble']).slice(0, 150))
check('未展开的分区不显示明细（默认紧凑）',
  !renderDiag([]).includes('.bRhRbq_panel'))

/* 真故障（必需分区全失配 / 选择器非法）必须仍然报警，别把误报修成漏报。
 * 两种真故障分开测：合在一起时摘要只显示优先级更高的那条，会把另一条盖住。 */
const brokenDiag = (items) => {
  stateOverride = { match: {}, value: {} }
  const tree = DiagReport({ items })
  stateOverride = undefined
  return { tree, text: flatten(tree, [], 0).join(' '), tones: findByClass(tree, 'ds-ts-diag-row').map(toneOf) }
}

/* 场景 A：必需分区（边栏）选择器全部失配 —— 这是 DSH 升级换了类名的典型症状。 */
const lostRegion = brokenDiag([
  { ...diagItems[0], ok: false, matched: 0, hits: diagItems[0].hits.map((hit) => ({ ...hit, count: 0 })) },
  diagItems[1],
])
check('★ 必需分区全部失配时仍然报「未命中」并说明后果',
  lostRegion.text.includes('未命中') && lostRegion.text.includes('毛玻璃已失效'),
  lostRegion.text.slice(0, 170))
check('★ 必需分区失配时标红，条件分区照旧不标红',
  lostRegion.tones.join(',') === 'warn,soft', `tones=${lostRegion.tones.join(',')}`)

/* 场景 B：选择器语法非法 —— 这是**代码写错**，比失配更严重，摘要应优先报它。 */
const syntaxError = brokenDiag([
  diagItems[0],
  { ...diagItems[1], invalid: 1, hits: [...diagItems[1].hits.slice(1), { selector: ':(', count: -1, sample: '' }] },
])
check('★ 非法选择器单独报「选择器非法」并标红',
  syntaxError.text.includes('选择器非法') && syntaxError.tones.join(',') === 'ok,warn',
  `tones=${syntaxError.tones.join(',')}`)
check('选择器非法时摘要优先报它（比失配更严重）',
  syntaxError.text.includes('真故障'), syntaxError.text.slice(0, 90))

/* 截断的根因是那条 CSS 规则；自检明细不能再吃到它。 */
const panelStyleEl = head.children.find((child) => child?.dataset?.pluginCss === 'dsh-theme-studio/panel.css')
const panelCssText = String(panelStyleEl?.textContent ?? '')
check('★ 自检明细不再复用带 nowrap + ellipsis 的 .ds-ts-mono',
  /\.ds-ts-diag-sel\s*\{[^}]*overflow-wrap:\s*anywhere/.test(panelCssText),
  panelCssText === '' ? '未找到 panel.css 的 <style>' : 'ok')

console.log(process.exitCode === 1 ? '\nSMOKE FAILED' : '\nSMOKE OK')
