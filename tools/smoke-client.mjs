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

/**
 * 剔除注释后的源码投影（字符串与模板字符串的内容原样保留）。
 *
 * 静态断言必须基于它：文件里刻意保留了不少「旧实现已废弃」的历史说明
 * （例如 purgeCache 旧的 `await putConfig(before)`），直接搜 `source` 会让
 * 注释替代码背书 —— 旧断言正是这样在实现改掉之后仍然假通过的。
 *
 * 不能按行过滤：块注释里不以 `*` 开头的中间行会漏删（CSS 注释就在模板字符串里，
 * 中间行正是这种形状），行首恰好是 `*` 的代码行又会被误删。这里用一个无依赖的
 * 小扫描器逐字符识别 `//`、块注释、单/双引号字符串、模板字符串与 `${}` 插值，
 * 以及正则字面量（`/"/g` 这类正则里的引号不能把扫描器带偏）：
 *   · 字符串内容原样保留 —— 界面文案（例如 `tr('重置配置')`）本来就在里面；
 *   · 注释替换成换行，行结构不塌，`^` 锚点的正则仍然可靠；
 *   · `//` 只在代码态才算注释，`'http://x//y'` 这种 URL 不会被截断。
 *
 * @param {string} text - 原始源码。
 * @returns {string} 去掉注释的代码投影。
 */
function stripComments(text) {
  const out = []
  /** 模板/插值栈：template 表示模板正文，interp 表示 `${...}` 内部。 */
  const stack = []
  /** 上一个有效代码记号，用来区分除号与正则字面量起始的 `/`。 */
  let previous = null
  let index = 0

  /** 原样复制 count 个字符（越界时自动截断）。 */
  const copy = (count = 1) => {
    while (count > 0 && index < text.length) {
      out.push(text[index])
      index += 1
      count -= 1
    }
  }

  /** 这些关键字后面期待一个表达式，所以可以紧跟正则字面量。 */
  const REGEX_KEYWORDS = new Set([
    'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void',
    'instanceof', 'yield', 'await', 'do', 'else',
  ])

  /** `/` 是除号还是正则起始？`a / b`、`f() / 2`、`x[0] / 2` 都是除号。 */
  const regexCanStart = () => {
    if (previous === null) return true
    if (previous.kind === 'word') return REGEX_KEYWORDS.has(previous.value)
    if (previous.kind === 'value') return false
    return previous.value !== ')' && previous.value !== ']' && previous.value !== '}'
  }

  while (index < text.length) {
    const top = stack[stack.length - 1]

    // 模板字符串正文：除了转义、结尾反引号和 ${，其它字符（含 // 与 /*）都是数据。
    if (top?.kind === 'template') {
      const char = text[index]
      if (char === '\\') copy(2)
      else if (char === '`') {
        copy()
        stack.pop()
        previous = { kind: 'value' }
      } else if (char === '$' && text[index + 1] === '{') {
        copy(2)
        stack.push({ kind: 'interp', depth: 0 })
        previous = null
      } else copy()
      continue
    }

    // 代码态（顶层或 ${} 插值内）：先处理两种注释。
    if (text[index] === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue // 换行留给下一轮复制，行结构不变
    }
    if (text[index] === '/' && text[index + 1] === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        if (text[index] === '\n') out.push('\n') // 块注释换成等量空行
        index += 1
      }
      index = Math.min(index + 2, text.length)
      continue
    }

    const char = text[index]

    // 正则字面量整体复制，内部不再判注释 —— 否则 /"/g 里的引号会被当成字符串开头。
    if (char === '/' && regexCanStart()) {
      copy()
      let inClass = false
      while (index < text.length) {
        const current = text[index]
        if (current === '\\') {
          copy(2)
          continue
        }
        if (current === '[') inClass = true
        else if (current === ']') inClass = false
        else if (current === '/' && !inClass) {
          copy()
          break
        } else if (current === '\n') break // 非法正则，别吞掉后面的代码
        copy()
      }
      while (index < text.length && /[a-z]/i.test(text[index])) copy() // flags
      previous = { kind: 'value' }
      continue
    }

    if (char === "'" || char === '"') {
      const quote = char
      copy()
      while (index < text.length) {
        if (text[index] === '\\') {
          copy(2)
          continue
        }
        const current = text[index]
        copy()
        if (current === quote) break
      }
      previous = { kind: 'value' }
      continue
    }
    if (char === '`') {
      copy()
      stack.push({ kind: 'template' })
      continue
    }
    if (/[A-Za-z_$]/.test(char)) {
      let word = ''
      while (index < text.length && /[A-Za-z0-9_$]/.test(text[index])) {
        word += text[index]
        out.push(text[index])
        index += 1
      }
      previous = { kind: 'word', value: word }
      continue
    }
    if (/[0-9]/.test(char)) {
      while (index < text.length && /[0-9A-Za-z_.$]/.test(text[index])) {
        out.push(text[index])
        index += 1
      }
      previous = { kind: 'value' }
      continue
    }
    if (top?.kind === 'interp') {
      if (char === '{') {
        top.depth += 1
        copy()
        previous = { kind: 'punct', value: '{' }
        continue
      }
      if (char === '}') {
        if (top.depth === 0) {
          stack.pop()
          copy()
          previous = null // 回到模板正文，记号跟踪暂停
          continue
        }
        top.depth -= 1
        copy()
        previous = { kind: 'punct', value: '}' }
        continue
      }
    }
    copy()
    if (!/\s/.test(char)) previous = { kind: 'punct', value: char }
  }

  return out.join('')
}

const codeOnly = stripComments(source)

/**
 * 从 {@link codeOnly} 里截取一个顶层 `const X = ... => {` 的函数体。
 *
 * 边界取「下一个缩进不超过本声明的 const / let / var / return」：函数内部
 * 嵌套的 const 缩进更深，不会被误截。截不到返回 null —— 调用方必须显式失败，
 * 绝不能让 null 静默通过。
 *
 * @param text - 已剔除注释的源码投影。
 * @param declaration - 声明前缀，例如 `const purgeCache = async () => {`。
 * @returns 函数体文本；找不到声明或边界时返回 null。
 */
function sliceTopLevelBody(text, declaration) {
  const start = text.indexOf(declaration)
  if (start < 0) return null
  const lineStart = text.lastIndexOf('\n', start) + 1
  const indent = start - lineStart
  const rest = text.slice(start + declaration.length)
  const boundary = new RegExp(`\\n {0,${indent}}(?:const |let |var |return\\b)`).exec(rest)
  if (boundary === null) return null
  return rest.slice(0, boundary.index)
}

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
check('未启用壁纸时保留 DSH 框架底色，不无条件把 frame 改透明',
  !css.includes('.pI_x6G_frame { background: transparent'))
check('分区选择器表含五个分区（AI 回复独立于用户气泡）',
  Object.keys(moduleExports.REGION_SELECTORS).length === 5 &&
    ['bars', 'input', 'bubble', 'assistant', 'menu'].every((key) => key in moduleExports.REGION_SELECTORS),
  Object.keys(moduleExports.REGION_SELECTORS).join(','))
check('CSS 含暗色分支', css.includes('[data-ds-dark-theme]'))
check('CSS 括号配平', (css.match(/\{/g) ?? []).length === (css.match(/\}/g) ?? []).length,
  `${(css.match(/\{/g) ?? []).length} { vs ${(css.match(/\}/g) ?? []).length} }`)

/* 出厂默认必须是「不修改任何东西」：壁纸原样、界面原样。 */
check('出厂默认不产生任何模糊规则', !css.includes('backdrop-filter: blur'), '应为 0 条')
check('出厂默认壁纸遮罩为 0（不暗化）', /--ds-ts-bg-dim, 0\)/.test(css))
check('出厂默认暗角为 0', /--ds-ts-bg-vignette, 0\)/.test(css))
check('出厂默认输入框沿用 DSH 原生配色及阴影描边',
  css.includes('--ds-ts-input: var(--dsw-static-neutral-bluish-00)') &&
    !css.includes('--dsw-elevation-soft:') && !css.includes('box-shadow: var(--ds-ts-inset)'))
check('默认开启 AI 回复气泡但不模糊；可单独关闭',
  defaults.glass.assistant.enabled === true && defaults.glass.assistant.opacity === 1 &&
    defaults.glass.assistant.blur === 0 &&
    css.includes('background: var(--ds-ts-assistant);') &&
    !css.includes('backdrop-filter: blur('))

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

/* AI 提问与计划审批占用输入框的位置，背景已从输入框令牌获取不透明度；
 * 两张卡片的直接子 section 还须单独获得同一模糊参数，不能顺手覆盖原生阴影。 */
const inputTakeovers = ['[data-question-key] > section', '[data-plan-review-key] > section']
const ruleFor = (stylesheet, selector) => stylesheet.split('}').find((rule) => {
  const brace = rule.indexOf('{')
  return brace >= 0 && rule.slice(0, brace).includes(`] ${selector}`)
})?.split('{')[1] ?? ''
check('提问与计划审批卡片纳入输入框自检，而非弹层菜单分区',
  inputTakeovers.every((selector) => moduleExports.REGION_SELECTORS.input.includes(selector) &&
    !moduleExports.REGION_SELECTORS.menu.includes(selector)))
for (const selector of inputTakeovers) {
  const rule = ruleFor(glassy, selector)
  check(`${selector} 跟随输入框的 18px 模糊（含 WebKit）`,
    rule.includes('backdrop-filter: blur(18px);') && rule.includes('-webkit-backdrop-filter: blur(18px);'), rule)
  check(`${selector} 保留 DSH 自身的背景与阴影`,
    !/\bbackground(?:-color)?\s*:|\bbox-shadow\s*:/.test(rule), rule)
}

/* DSH assistant-step 的根容器渲染 AI 正文，工具行/用户消息不走该节点；
 * 只给回复（或未分组的助手输出）加左侧气泡，不把 reasoning 分组当成正文。 */
const assistantSelectors = moduleExports.REGION_SELECTORS.assistant
const assistantOnlyCss = moduleExports.buildCss({
  ...defaults,
  glass: { ...defaults.glass, assistant: { enabled: true, opacity: 0.42, blur: 27 } },
})
check('AI 回复分区使用 assistant-step 标记，覆盖原生与插槽包裹两种结构',
  assistantSelectors.length === 2 && assistantSelectors.every((selector) =>
    selector.startsWith('[data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"]) > ') &&
    selector.includes('[class*="_root"]:has(> [class*="_body"])')) &&
    assistantSelectors.some((selector) => selector.includes('[data-slot="conversation.chat.node"]')))
check('AI 气泡有独立浅色/深色底色、圆角和留白，且不裁切宽表格',
  assistantOnlyCss.includes('--ds-ts-assistant: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 42.0%, transparent)') &&
    assistantOnlyCss.includes('--ds-ts-assistant: color-mix(in srgb, var(--dsw-static-neutral-bluish-950) 42.0%, transparent)') &&
    assistantSelectors.every((selector) => {
      const rule = ruleFor(assistantOnlyCss, selector)
      return rule.includes('background: var(--ds-ts-assistant);') &&
        rule.includes('border-radius: var(--dsw-radius-xl);') &&
        rule.includes('padding: 10px 16px;') && !rule.includes('overflow: hidden')
    }))
check('AI 回复透明时只在助手容器上施加模糊（含 WebKit）',
  assistantSelectors.every((selector) => assistantOnlyCss.split('}').some((rule) =>
    rule.includes(`] ${selector}`) && rule.includes('backdrop-filter: blur(27px);') &&
    rule.includes('-webkit-backdrop-filter: blur(27px);'))))
const assistantOffCss = moduleExports.buildCss({
  ...defaults,
  glass: { ...defaults.glass, assistant: { enabled: false, opacity: 0.42, blur: 27 } },
})
check('关闭 AI 气泡即还原 DSH 原本的无气泡正文',
  !assistantOffCss.includes('--ds-ts-assistant') &&
    assistantSelectors.every((selector) => !assistantOffCss.includes(selector)))
const assistantOpaqueCss = moduleExports.buildCss({
  ...defaults,
  glass: { ...defaults.glass, assistant: { enabled: true, opacity: 1, blur: 27 } },
})
check('AI 气泡完全不透明时不生成模糊规则',
  !assistantOpaqueCss.includes('backdrop-filter: blur(27px)'))
check('只调 AI 回复时不改用户消息气泡令牌；用户气泡有独立参数',
  assistantOnlyCss.includes('--ds-ts-bubble: var(--dsw-static-deepseek-50)') &&
    !assistantOnlyCss.includes('--ds-ts-bubble: color-mix(') &&
    !moduleExports.REGION_SELECTORS.bubble.some((selector) =>
      assistantOnlyCss.split('}').some((rule) => rule.includes(`] ${selector}`) && rule.includes('blur(27px)'))))
const userOnlyCss = moduleExports.buildCss({
  ...defaults,
  glass: { ...defaults.glass, bubble: { enabled: true, opacity: 0.37, blur: 19 } },
})
check('只调用户消息时 AI 回复仍保持原不透明度且不模糊',
  userOnlyCss.includes('--ds-ts-assistant: var(--dsw-static-neutral-bluish-00)') &&
    assistantSelectors.every((selector) => !userOnlyCss.split('}').some((rule) =>
      rule.includes(`] ${selector}`) && rule.includes('blur(19px)'))))

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
check('输入框不透明时，提问与计划审批卡片都不浪费模糊开销',
  inputTakeovers.every((selector) => ruleFor(opaqueCss, selector) === ''))
const menuOnlyCss = moduleExports.buildCss({
  ...defaults,
  glass: {
    ...defaults.glass,
    input: { enabled: true, opacity: 1, blur: 18 },
    menu: { enabled: true, opacity: 0.5, blur: 33 },
  },
})
check('弹层菜单参数不会误控制 AI 提问卡片的模糊',
  inputTakeovers.every((selector) => ruleFor(menuOnlyCss, selector) === ''))
const disabledInputCss = moduleExports.buildCss({
  ...defaults,
  glass: { ...defaults.glass, input: { enabled: false, opacity: 0.5, blur: 18 } },
})
check('输入框分区关闭时，提问与计划审批卡片都还原原生效果',
  inputTakeovers.every((selector) => ruleFor(disabledInputCss, selector) === '') &&
    !disabledInputCss.includes('--dsw-specific-input-major:'))

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
  const seen = new Set()
  const walk = (node, depth) => {
    if (depth > 30 || node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    if (typeof node.type === 'function') {
      if (node.type.name === componentName) found.push({ ...(node.props ?? {}), render: node.type })
      if (seen.has(node.type)) return // 避免组件自递归
      seen.add(node.type)
      // React.createElement 的 children 在桩里单独存着；Card 的正文由 children
      // 参数传入，不补进 props 就只能看到标题、永远遍历不到里面的颜色控件。
      walk(node.type({ ...(node.props ?? {}), children: node.children, t: (key) => key }), depth + 1)
      seen.delete(node.type)
      return
    }
    for (const child of [].concat(node.children ?? [])) walk(child, depth + 1)
  }
  try { walk(root, 0) } finally { stateOverride = undefined }
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
check('玻璃页含五个分区名称（AI 回复与用户气泡分开）', ['边栏', '输入框', '气泡', 'AI 回复', '弹层菜单']
  .every((name) => texts.glass.includes(name)), texts.glass.slice(0, 120) || '(空)')
const dimColorRows = findComponentProps('wallpaper', 'WallpaperDimColor')
check('壁纸表现里遮罩暗化下方有独立的可展开选色入口',
  dimColorRows.length === 1 && dimColorRows[0].color === 'auto' &&
    typeof dimColorRows[0].onChange === 'function',
  `rows=${dimColorRows.length} color=${dimColorRows[0]?.color}`)
if (dimColorRows.length === 1) {
  const row = dimColorRows[0]
  const closed = row.render(row)
  const toggle = closed.children[0]
  check('选色默认收起；展开按钮可通过键盘和读屏识别',
    toggle.type === 'button' && toggle.props['aria-expanded'] === 'false' &&
      typeof toggle.props.onClick === 'function' &&
      toggle.children.some((child) => child === '自定义遮罩颜色') &&
      closed.children[1] === null)
  stateOverride = { match: false, value: true }
  const expanded = row.render(row)
  stateOverride = undefined
  const colorNode = expanded.children[1]?.children?.[0]
  check('展开后才显示黑色预览、选色和恢复默认入口',
    expanded.children[0].props['aria-expanded'] === 'true' &&
      expanded.children[0].props['aria-controls'] === expanded.children[1]?.props?.id &&
      colorNode?.type?.name === 'GlassColorRow' &&
      colorNode.props.fallback === '#000000' &&
      colorNode.props.defaultNote === '默认黑色')
  if (colorNode?.type?.name === 'GlassColorRow') {
    const chosen = []
    const rendered = colorNode.type({ ...colorNode.props, onChange: (value) => chosen.push(value) })
    const nativePicker = rendered.children[4].children[4].children[0]
    nativePicker.props.onChange({ target: { value: '#78a2cf' } })
    const custom = colorNode.type({ ...colorNode.props, color: '#78a2cf', onChange: (value) => chosen.push(value) })
    custom.children[3].props.onClick()
    check('选色写入十六进制 RGB，恢复默认写回 auto',
      rendered.children[1].props.type === 'button' &&
        nativePicker.props.type === 'color' && nativePicker.props.value === '#000000' &&
        rendered.children[4].children[2] === null &&
        rendered.children[3].props.disabled === true &&
        custom.children[3].props.disabled === false &&
        chosen.join(',') === '#78a2cf,auto')
  }
  const swatch = row.render({ color: '#78a2cf', onChange: row.onChange }).children[0].children[0]
  check('收起时按钮色点也反映当前自定义遮罩颜色', swatch.props.style.backgroundColor === '#78a2cf')
}
const colorRows = findComponentProps('glass', 'GlassColorRow')
check('五个不透明度分区各有独立的遮罩选色与恢复默认入口',
  colorRows.length === 5 && colorRows.every((row) =>
    row.label === '遮罩颜色' && row.color === 'auto' && /^#[0-9a-f]{6}$/.test(row.fallback) &&
    typeof row.onChange === 'function' && row.presets?.light?.length === 3 && row.presets?.dark?.length === 3) &&
    codeOnly.includes("popover: 'auto'") && codeOnly.includes("onClick: () => onChange('auto')") &&
    codeOnly.includes('默认（侧栏、顶栏各用 DSH 原生色）') &&
    codeOnly.includes('默认（沿用 DSH 原生半透明色，色块仅显示 RGB）') &&
    codeOnly.includes('默认（取 DSH 页面底色；原生 AI 回复没有气泡）'),
  `${colorRows.length} 个选色控件`)
check('默认色块 RGB 对应 DSH 原生浅色配色（AI 回复取页面底色，菜单保留原生 alpha）',
  colorRows.map((row) => row.fallback).join(',') === '#f9fafb,#ffffff,#edf3fe,#ffffff,#f8f9fa')
const hexOf = (rgb) => `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
check('五个分区的浅色和深色预设分别取 DSH 原生 RGB，不改自动模式',
  colorRows.map((row) => hexOf(row.presets.light)).join(',') === '#f9fafb,#ffffff,#edf3fe,#ffffff,#f8f9fa' &&
    colorRows.map((row) => hexOf(row.presets.dark)).join(',') === '#1b1b1c,#2c2c2e,#2c2c2e,#151517,#43454a' &&
    colorRows.every((row) => row.color === 'auto'))
const selectedPresets = colorRows.map((row) => {
  const selected = []
  const picker = row.render({ ...row, onChange: (value) => selected.push(value) })
  const buttons = picker.children[4].children[2]?.children[0]
  if (!Array.isArray(buttons)) return selected
  for (const button of buttons) button.props.onClick()
  return selected
})
check('每个分区首次点击浅色／深色预设都写入自己的固定颜色，不误写 auto',
  colorRows.length === 5 && selectedPresets.every((selected, index) =>
    selected.join(',') === [hexOf(colorRows[index].presets.light), hexOf(colorRows[index].presets.dark)].join(',')),
  selectedPresets.map((colors) => colors.join(' → ')).join(' | '))
if (colorRows.length > 0) {
  const picked = []
  const example = colorRows[0].render({ ...colorRows[0], color: '#aabbcc', onChange: (value) => picked.push(value) })
  const [, picker, status, restore, popup] = example.children
  const [field, hue, presetRow, rgbRow, nativeRow] = popup.children
  nativeRow.children[0].props.onChange({ target: { value: '#123456' } })
  restore.props.onClick()
  check('自定义取色框保留系统取色入口，选色/恢复默认分别提交颜色与 auto',
    picker.props.type === 'button' && popup.props.popover === 'auto' &&
      nativeRow.children[0].props.type === 'color' && nativeRow.children[0].props.value === '#aabbcc' &&
      picker.props['aria-labelledby'] && picker.props['aria-describedby'] === status.props.id &&
      picker.props['aria-controls'] === popup.props.id &&
      !restore.props.disabled &&
      JSON.stringify(picked) === '["#123456","auto"]', JSON.stringify(picked))
  const twoPresets = presetRow.children[0]
  twoPresets[0].props.onClick()
  twoPresets[1].props.onClick()
  check('预设色块紧接色相条下方；点浅色/深色会写入固定 RGB，而不是 auto',
    presetRow.props.className === 'ds-ts-color-presets' && hue.props.className === 'ds-ts-color-hue' &&
      twoPresets.length === 2 && twoPresets[0].props['aria-label'].includes('#f9fafb') &&
      twoPresets[1].props['aria-label'].includes('#1b1b1c') &&
      picked.slice(-2).join(',') === '#f9fafb,#1b1b1c')
  rgbRow.children[0][0].children[0].props.onChange({ target: { value: '128' } })
  check('RGB 数字输入仍可手调任意颜色，颜色方块支持拖动和键盘',
    picked.at(-1) === '#80bbcc' && field.props.role === 'slider' &&
      typeof field.props.onPointerDown === 'function' && typeof field.props.onKeyDown === 'function' &&
      hue.props.type === 'range')
  const defaultPicker = colorRows[0].render(colorRows[0]).children
  check('默认色取当前主题配色，恢复默认按钮在默认状态不可误点',
    defaultPicker[1].children[0].props.style.backgroundColor === colorRows[0].fallback &&
      defaultPicker[3].props.disabled === true &&
      defaultPicker[4].children[2].children[0].every((button) => button.props['data-active'] === false))
}

const previewCss = head.children.find((tag) => tag.dataset.pluginCss === 'dsh-theme-studio/panel.css')?.textContent ?? ''
check('预览 CSS 仅在本插件卡片拖动期间去掉 DSH 弹窗遮罩与模糊',
  previewCss.includes('.VOzbGW_overlay:has(.ds-ts-page[data-ds-ts-preview]) .VOzbGW_mask { background: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }') &&
    !previewCss.includes('--dsw-alias-bg-mask-1: transparent'))
check('预览保留当前整张卡片，不改布局或移除其他卡片',
  previewCss.includes('.ds-ts-page > :not(.ds-ts-tabpanel),') &&
    previewCss.includes('.ds-ts-tabpanel > :not(.ds-ts-card[data-ds-ts-preview-card]) { visibility: hidden !important; }') &&
    previewCss.includes('.VOzbGW_panel { background: transparent !important; box-shadow: none !important; }') &&
    !previewCss.includes('.ds-ts-page > * { visibility: hidden !important; }') &&
    !previewCss.includes('scrollbar-color: transparent transparent') &&
    !previewCss.includes('display: none !important'))

const previewRow = findComponentProps('glass', 'SliderRow').find((row) => row.label === '不透明度')
if (previewRow !== undefined) {
  const listeners = new Map()
  const frames = new Map()
  let nextFrame = 0
  const oldAdd = window.addEventListener
  const oldRemove = window.removeEventListener
  const oldFrame = window.requestAnimationFrame
  const oldCancelFrame = window.cancelAnimationFrame
  window.addEventListener = (name, handler) => listeners.set(name, handler)
  window.removeEventListener = (name, handler) => {
    if (listeners.get(name) === handler) listeners.delete(name)
  }
  window.requestAnimationFrame = (callback) => {
    nextFrame += 1
    frames.set(nextFrame, callback)
    return nextFrame
  }
  window.cancelAnimationFrame = (id) => frames.delete(id)
  const advanceFrame = () => {
    const current = [...frames.values()]
    frames.clear()
    for (const callback of current) callback()
  }
  const marked = () => {
    const attrs = new Set()
    return {
      setAttribute: (name) => attrs.add(name),
      removeAttribute: (name) => attrs.delete(name),
      hasAttribute: (name) => attrs.has(name),
    }
  }
  const overlay = {}
  const page = { ...marked(), closest: (selector) => selector === '.VOzbGW_overlay' ? overlay : null }
  const card = { ...marked(), closest: (selector) => selector === '.ds-ts-page' ? page : null }
  const slider = { closest: (selector) => selector === '.ds-ts-card' ? card : null }
  const values = []
  const input = previewRow.render({ ...previewRow, onChange: (value) => values.push(value) }).children[1]
  const previewActive = () => page.hasAttribute('data-ds-ts-preview') && card.hasAttribute('data-ds-ts-preview-card')
  const previewOff = () => !page.hasAttribute('data-ds-ts-preview') && !card.hasAttribute('data-ds-ts-preview-card')
  input.props.onPointerDown({ currentTarget: slider, button: 2, pointerId: 8 })
  check('右键滑条不进入预览', previewOff())
  input.props.onPointerDown({ currentTarget: slider, button: 0, pointerId: 8 })
  check('第一次按下先保持控件原位，等待浏览器完成指针捕获', previewOff() && frames.size === 1)
  input.props.onPointerUp({ currentTarget: slider, pointerId: 8 })
  advanceFrame()
  check('短点后松手会取消待执行的预览，不会留下透明设置界面', previewOff() && frames.size === 0 && listeners.size === 0)
  input.props.onPointerDown({ currentTarget: slider, button: 0, pointerId: 8 })
  input.props.onChange({ currentTarget: slider, target: { value: '0.24' } })
  check('首次快速调整先于动画帧发生时，也在第一次变值时显示预览',
    previewActive() && frames.size === 0 && values.at(-1) === 0.24)
  input.props.onPointerUp({ currentTarget: slider, pointerId: 8 })
  input.props.onPointerDown({ currentTarget: slider, button: 0, pointerId: 8 })
  input.props.onBlur({ currentTarget: slider })
  advanceFrame()
  input.props.onChange({ currentTarget: slider, target: { value: '0.27' } })
  check('首次拖动即预览当前整张卡片；初次焦点切换不打断预览，值仍实时更新',
    previewActive() && values.at(-1) === 0.27 && listeners.has('pointerup'))
  listeners.get('pointerup')?.({ pointerId: 9 })
  check('其它触点抬起不影响正在拖动的卡片', previewActive())
  listeners.get('pointerup')?.({ pointerId: 8 })
  check('拖动松手立即恢复，并清理临时窗口监听', previewOff() && listeners.size === 0)
  input.props.onPointerDown({ currentTarget: slider, button: 0, pointerId: 10 })
  advanceFrame()
  input.props.onPointerCancel({ currentTarget: slider, pointerId: 10 })
  check('触控取消能恢复完整设置界面', previewOff() && listeners.size === 0)
  input.props.onKeyDown({ currentTarget: slider, key: 'ArrowRight' })
  check('键盘调整滑条期间也进入预览', previewActive())
  input.props.onKeyUp({ currentTarget: slider, key: 'ArrowRight' })
  check('键盘松键后恢复设置界面', previewOff() && listeners.size === 0)
  input.props.onKeyDown({ currentTarget: slider, key: 'Home' })
  listeners.get('blur')?.()
  check('失去窗口焦点后不会留下透明弹窗', previewOff() && listeners.size === 0)
  input.props.onKeyDown({ currentTarget: slider, key: 'End' })
  input.props.onKeyDown({ currentTarget: slider, key: 'Escape' })
  check('Escape 退出预览并允许 DSH 继续处理关闭弹窗', previewOff() && listeners.size === 0)
  const detachedSlider = { closest: (selector) => selector === '.ds-ts-card' ? {
    closest: (parent) => parent === '.ds-ts-page' ? { closest: () => null } : null,
  } : null }
  input.props.onPointerDown({ currentTarget: detachedSlider, button: 0, pointerId: 11 })
  check('不在主题工作室弹窗内的滑条不会隐藏其它 DSH 设置', previewOff() && listeners.size === 0)
  window.addEventListener = oldAdd
  window.removeEventListener = oldRemove
  window.requestAnimationFrame = oldFrame
  window.cancelAnimationFrame = oldCancelFrame
}
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
/* 这两条都基于 codeOnly + 函数体截取：旧版断言用的是含注释的 `source`，
 * 而注释里恰好留着旧实现 `await putConfig(before)` —— 实现改成 purge-cache 之后
 * 它仍然「通过」，属于注释替代码背书。 */
const resetBody = sliceTopLevelBody(codeOnly, 'const resetConfig = async () => {')
check('★ 重置走宿主 POST /api/reset，并用返回的出厂配置覆盖本地',
  resetBody !== null && /fetch\(`\$\{API\}\/reset`/.test(resetBody) &&
    resetBody.includes("method: 'POST'") && resetBody.includes('purgeFiles') &&
    /const fresh = result\.body\.config \?\? defaultConfig\(\)/.test(resetBody) &&
    resetBody.includes('runtime.apply(fresh)') && resetBody.includes('setConfig(fresh)'),
  resetBody === null ? '未截到 resetConfig 函数体' : `len=${resetBody.length}`)
/* 0.2.5 用户要求：卡片里**只留功能**，别把解释性描述塞进界面。
 * 同时「清理本地缓存」收窄为**只清缓存** —— 旧实现复用 `/api/reset?purgeFiles=true`，
 * 而那个端点会顺带把配置写回出厂；新实现改走专用 `/api/purge-cache`。 */
check('★ 重置卡片只留功能按钮，没有解释性描述段落',
  !codeOnly.includes('这一项不是「卸载插件」') && !codeOnly.includes('关闭只是把效果撤掉、配置留着') &&
    !codeOnly.includes("tr('重置并清理数据文件')") && !codeOnly.includes("tr('重置并删除插件文件')"))
check('★ 两个按钮是「重置配置」与「清理本地缓存」',
  codeOnly.includes("tr('重置配置')") && codeOnly.includes("tr('清理本地缓存')"))

const purgeBody = sliceTopLevelBody(codeOnly, 'const purgeCache = async () => {')
const purgeDanglingAt = purgeBody === null ? -1 : purgeBody.indexOf('if (dangling)')
const purgeBeforeDangling = purgeDanglingAt < 0 ? '' : purgeBody.slice(0, purgeDanglingAt)
const purgeAfterDangling = purgeDanglingAt < 0 ? '' : purgeBody.slice(purgeDanglingAt)
/* 当前实现：POST /purge-cache 清副本；唯一会碰配置的分支是「当前/固定壁纸指向
 * 已被删掉的上传副本」——那时只 patch wallpaper 的 source/current/fixed 三项，
 * 绝不把清理前的快照整份写回。所以负向断言钉的是「不得整份回写」而不是
 * 「一个字节都不许写」：后者会与真实实现（悬挂选择的局部 persist）冲突。 */
check('★ 「清理本地缓存」走 POST /api/purge-cache，不再借道 /api/reset 或 purgeFiles',
  purgeBody !== null && /fetch\(`\$\{API\}\/purge-cache`/.test(purgeBody) &&
    purgeBody.includes("method: 'POST'") &&
    !purgeBody.includes('${API}/reset') && !purgeBody.includes('purgeFiles'),
  purgeBody === null ? '未截到 purgeCache 函数体' : `len=${purgeBody.length}`)
check('★ 「清理本地缓存」不得把配置快照整份写回（只在悬挂选择时做局部清理）',
  purgeBody !== null && !purgeBody.includes('putConfig') &&
    !/(?:putConfig|setConfig|persist|flushConfig|replaceConfig)\(\s*(?:\.\.\.)?before\b/.test(purgeBody) &&
    !/runtime\.config\s*=\s*before\b/.test(purgeBody) &&
    !/putConfig|setConfig|persist|flushConfig|replaceConfig/.test(purgeBeforeDangling) &&
    purgeAfterDangling.includes('persist({ wallpaper:'),
  purgeBody === null
    ? '未截到 purgeCache 函数体'
    : `悬挂前写入=${(purgeBeforeDangling.match(/[^\n]*(?:putConfig|setConfig|persist|flushConfig|replaceConfig)[^\n]*/g) ?? []).join(' | ') || '(无)'}；悬挂后 persist=${purgeAfterDangling.includes('persist({ wallpaper:')}`)
check('★ 非 JSON 响应要能翻译成人话（本轮报障的回归点）',
  codeOnly.includes('async function readJsonResponse') && codeOnly.includes('function describeHostFailure') &&
    !/await response\.json\(\)/.test(codeOnly))
check('★ 404（宿主还没重启）的提示里要说清「重启 dsh web」',
  codeOnly.includes('宿主没有这个接口') && codeOnly.includes('重启 dsh web'))
check('面板不含英文界面词', !/\b(Wallpaper|Glass|Theme color|Master switch|Source|Opacity|Enable)\b/.test(
  Object.values(texts).join(' '),
))

/* 静态检查：控件确实在源码里被使用、且文案是中文。
   这里刻意不逐个数渲染出的控件数量 —— 那依赖 state 桩的精确行为，
   假失败会掩盖真问题；要抓的是「整块渲染抛错」这类致命问题，上面的渲染断言已经覆盖。
   注意：静态断言一律读文件开头构造的 `codeOnly`（已剔除注释的代码投影）。它保留
   字符串与模板字符串里的界面文案，但不再接受注释里的字样 —— 注释不能替代码背书。 */
check('候选缩略图带悬停删除按钮', codeOnly.includes('ds-ts-thumb-del') && codeOnly.includes("'✕'"))
/* 0.2.0：删除语义按来源分三种，aria-label 必须给出真实语义。
 * ⚠️ 这条断言读的是 **codeOnly（剔除注释后的代码投影）** —— 上一版曾让注释里
 * 出现的同款文案替代码「作证」，属于假通过；改后只认代码里的字符串字面量。 */
check('删除文案按来源区分：上传的图是真删、登记目录里的原图只移出视图',
  codeOnly.includes("tr('删除这张上传的图')") && codeOnly.includes("tr('从候选墙移除')") &&
    !codeOnly.includes("tr('移出候选')") && !codeOnly.includes("tr('恢复已移除')"))
check('三个分区都有滑块控件', ['不透明度', '模糊'].every((label) => codeOnly.includes(`tr('${label}')`)))
check('R/G/B 滑块标签存在', codeOnly.includes("['R 红', 'G 绿', 'B 蓝']"))

/* 回归（0.1.11）：设置界面上不再有「画质档位」，也不再有每分区的「饱和度」滑块。
 * 注意两点：
 *   ·「饱和度」三个字在壁纸页仍然合法（那是给壁纸本身调色的），所以只断言**玻璃路径**；
 *   · 注释里刻意留着「已移除」的历史说明，因此判定统一用文件开头构造的 `codeOnly`。 */

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
check('缩略图不再使用原生 title 提示', !/'title':/.test(codeOnly) && !/^\s*title: name/m.test(codeOnly))
check('删除按钮不再使用原生 title 提示', !/title: label/.test(codeOnly))
/* 用户明确要求：悬停 ✕ 时不显示任何文字，所以自绘气泡也一并去掉。 */
check('删除按钮悬停不再显示文字气泡', !codeOnly.includes('ds-ts-thumb-tip') && !/role: 'tooltip'/.test(codeOnly))
/* 回归：删除按钮里不能再塞文案 —— 缩略图的 overflow:hidden 会把它裁掉（实测只剩「移」）。 */
check('删除按钮内不放文案', !codeOnly.includes('ds-ts-thumb-del-text'))
/* 回归：文件名角标必须用专属类名。写通配的 `.ds-ts-thumb span` 会把删除按钮内部的
   文案 span 一起拉成整行，文字溢出、按钮看起来「偏出去」。
   判定方式：在 codeOnly（JS 注释已剔除）上只认「真的是一条 CSS 规则」的行
   （同一行里出现 { 且以 } 结束）。CSS 写在模板字符串里，那段注释属于字符串内容，
   所以还要这层行形状过滤，修复说明里引用的旧选择器才不会自指误报。 */
const cssRuleLines = codeOnly.split('\n').filter((line) => line.includes('{') && line.trimEnd().endsWith('}'))
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
check('顶边栏单独隔离负层玻璃膜，侧栏不隔离以免困住设置弹窗',
  noRemovedCss.includes('] .wSkVaW_header { isolation: isolate; }') &&
    !noRemovedCss.includes('] .hHd-Xa_root { isolation: isolate; }'))
check('边栏：伪元素同时带 background-color 与 backdrop-filter',
  /\.hHd-Xa_root::before,[\s\S]*?background-color: var\(--ds-ts-bars\)[\s\S]*?backdrop-filter: blur\(20px\)/.test(noRemovedCss))
check('边栏：元素自身没有 backdrop-filter（否则会困住设置弹窗）',
  !/\] \.(?:hHd-Xa_root|wSkVaW_header) \{[^}]*backdrop-filter/.test(noRemovedCss))
check('无壁纸时侧栏外层直接绘制遮罩，避免负层伪元素被框架白底遮住',
  noRemovedCss.includes('.pI_x6G_sidebarCol { background: var(--ds-ts-bars) !important; }'))
/* ★ 侧栏实色的第三个来源：会话列表底部的渐隐遮罩消费同一个 token（0.1.17）。 */
check('★ 边栏：sidebar-fill 在侧栏内被就地覆盖为透明，且没有写到全局',
  noRemovedCss.includes('] .hHd-Xa_root { --dsw-specific-sidebar-fill: transparent !important; }') &&
    !/body \{[^}]*--dsw-specific-sidebar-fill\s*:/.test(noRemovedCss))
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
check('边栏已覆盖 --dsw-specific-sidebar-fill 之外的路径（外层及内层都受控）',
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
 * 当前菜单规则会在 :not() 中引用设置面板与浮层以排除其子树；引用不等于命中。
 * 断言设置界面只以排除条件出现，不复活设置分区或设置遮罩的规则。 */
const panelRules = [...noRemovedCss.matchAll(/([^{}]+)\{[^{}]*\}/g)]
  .map(([, selector]) => selector.trim())
  .filter((selector) => selector.includes('.VOzbGW_panel'))
check('全部分区半透明时设置面板仅在菜单排除条件里出现，遮罩不被接管',
  panelRules.length > 0 && panelRules.every((selector) =>
    selector.includes(':not(.VOzbGW_panel *, .VOzbGW_overlay *)') &&
      !selector.includes('] .VOzbGW_panel') && !selector.includes('] .VOzbGW_overlay')) &&
    !noRemovedCss.includes('.VOzbGW_mask'),
  panelRules.map((selector) => selector.slice(0, 120)).join(' | ') || '(无)')
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
