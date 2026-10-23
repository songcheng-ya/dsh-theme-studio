/**
 * 客户端单测：壁纸解析稳定性 / 清空语义 / 死配置清理 / CSS 语义 /
 * 配置清洗与缓存一致性（audit P1-10、P1-11、P1-17、P1-18、P3-9）。
 *
 * 为什么值得单独一个脚本：
 *   · `smoke-client.mjs` 只验「能加载、能渲染、CSS 形状」，不碰运行时状态；
 *   · 而「任意 patch 都重抽壁纸」「点清空反而换一张」「宿主写回不 apply」
 *     这些 bug 都只在**多次 apply / 面板闭包真的被调用**时才出现，
 *     静态检查一条都抓不到。
 *
 * 区块：
 *   a) ~ e)  壁纸解析、清空语义、死配置（C1）
 *   C2       样式语义与 CSS 字符串安全
 *   C3       配置清洗 / 缓存版本化 / putConfig 与 clearIfActive 的状态一致性
 *   C4       保存管线：persist 合并语义（不丢写入）与卸载安全（不写盘 / 不 setState）
 *   C6       i18n 接线：导航标签走 locale 字典、面板正文明确只维护中文
 *            （audit P3-3、P1-17 的 tr 第二参数）
 *
 * 用法：node tools/check-client.mjs
 */

import { readFileSync } from 'node:fs'

import { createHookRenderer, createLocaleStub, installFakeTimers, loadClient, mountPanel } from './lib/client-harness.mjs'

const {
  client, dom, requests, resetRequests, storage, setFetchHandler,
  setContextValue, setStateOverride, clearStateOverride,
} = await loadClient()
const { ThemeRuntime, defaultConfig } = client

let passed = 0
let failed = 0

/**
 * 打一条断言。
 * @param label - 断言描述。
 * @param ok - 是否通过。
 * @param detail - 附加信息（失败时尤其有用）。
 */
function check(label, ok, detail) {
  if (ok) passed += 1
  else failed += 1
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 造一个「来源=folder、候选池非空、fixed/current 都为空」的运行时。
 *
 * 这正是出厂默认状态，也是 P1-10 的复现条件：没有 fixed/current 时，
 * 旧实现的 apply() 每次都会从池里 `Math.random()` 重抽一张。
 * @param options - `{ wallpapers, wallpaper }`：候选池与 wallpaper 覆盖项。
 * @returns 已 apply 过一次的 ThemeRuntime。
 */
function makeRuntime(options = {}) {
  const runtime = new ThemeRuntime()
  runtime.wallpapers = [...(options.wallpapers ?? ['D:\\壁纸\\a.jpg', 'D:\\壁纸\\b.jpg', 'D:\\壁纸\\c.jpg'])]
  const base = defaultConfig()
  runtime.config = {
    ...base,
    wallpaper: { ...base.wallpaper, source: 'folder', ...(options.wallpaper ?? {}) },
  }
  runtime.apply(runtime.config)
  return runtime
}

/* ═══════════════════════════════════════════════════════════════════
 * a) 同一份配置连续 apply 两次，resolved 相同
 * ═══════════════════════════════════════════════════════════════════ */

const stable = makeRuntime()
const firstPick = stable.resolved
check(
  'a) 前置条件：候选池非空、fixed/current 为空时能解析出一张',
  firstPick !== '' && stable.wallpapers.includes(firstPick),
  `resolved=${firstPick}`,
)

stable.apply(stable.config)
check('a) 同一份配置连续 apply 两次，resolved 相同', stable.resolved === firstPick, `${firstPick} → ${stable.resolved}`)

/* 再连续 apply 多次、每次换一份内容相同但对象是新的配置：
 * 既不能依赖对象引用，也不能因为 apply 的调用次数而变化。
 * 多跑几次是刻意的 —— 旧实现每次 `Math.random()`，3 张候选里连中 8 次的概率
 * 只有 0.015%，这样这条断言才**真的**能抓住 P1-10，而不是靠运气通过。 */
const stablePicks = new Set([firstPick])
for (let index = 0; index < 7; index += 1) {
  stable.apply({ ...stable.config, wallpaper: { ...stable.config.wallpaper } })
  stablePicks.add(stable.resolved)
}
check('a) 连续 apply 8 次，resolved 始终是同一张', stablePicks.size === 1, [...stablePicks].join(' | '))

/* ═══════════════════════════════════════════════════════════════════
 * a2) pendingWallpaper 的「一次性」语义必须保留
 * ═══════════════════════════════════════════════════════════════════ */

const pending = makeRuntime({
  wallpaper: { fixed: 'D:\\壁纸\\a.jpg', current: 'D:\\壁纸\\a.jpg' },
})
pending.pendingWallpaper = 'D:\\壁纸\\c.jpg'
pending.apply(pending.config)
check(
  'a2) pendingWallpaper 优先于 fixed，且被 apply() 取走后清空',
  pending.resolved === 'D:\\壁纸\\c.jpg' && pending.pendingWallpaper === '',
  `resolved=${pending.resolved} pending=${JSON.stringify(pending.pendingWallpaper)}`,
)
pending.apply(pending.config)
check('a2) pendingWallpaper 只顶一次：下一次 apply 回到 fixed', pending.resolved === 'D:\\壁纸\\a.jpg', pending.resolved)

/* ═══════════════════════════════════════════════════════════════════
 * b) 与壁纸无关的配置变化（glass / accent / 观感项）不允许换壁纸
 * ═══════════════════════════════════════════════════════════════════ */

const unrelated = makeRuntime()
const beforeUnrelated = unrelated.resolved
/* 一次改一项、每项都走一次 apply —— 旧实现每改一项就有 2/3 概率换一张，
 * 6 项全都不换的概率只有 0.14%，所以这条断言不会假通过。 */
for (const [path, value] of [
  ['glass.border', 0.14],
  ['glass.input.blur', 22],
  ['accent.rgb', [232, 106, 148]],
  ['accent.enabled', true],
  ['wallpaper.dim', 0.33],
  ['wallpaper.fit', 'contain'],
]) {
  unrelated.patch(path, value)
}
check(
  'b) 改 6 项与候选池无关的配置后 resolved 不变（这才是 P1-10 的回归点）',
  unrelated.resolved === beforeUnrelated,
  `${beforeUnrelated} → ${unrelated.resolved}`,
)

/* ═══════════════════════════════════════════════════════════════════
 * c) 候选池真的变了才允许重抽，且新值必须属于新池
 * ═══════════════════════════════════════════════════════════════════ */

const growing = makeRuntime()
const oldPick = growing.resolved
growing.wallpapers = [...growing.wallpapers.filter((item) => item !== oldPick), 'D:\\壁纸\\d.jpg']
growing.apply(growing.config)
check(
  'c) 候选池增删后 apply：resolved 非空且属于新池',
  growing.resolved !== '' && growing.wallpapers.includes(growing.resolved),
  `old=${oldPick} new=${growing.resolved} pool=${growing.wallpapers.join('|')}`,
)

/* 只删除的极端场景：池从 2 → 1，必须落到剩下那张，不能继续用已被删掉的值。
 * 这条同时守住「删掉当前壁纸后背景还挂着旧图」的老故障。 */
const shrinking = makeRuntime({ wallpapers: ['D:\\壁纸\\e.jpg', 'D:\\壁纸\\f.jpg'] })
const shrinkPick = shrinking.resolved
const survivor = shrinking.wallpapers.find((item) => item !== shrinkPick)
shrinking.wallpapers = [survivor]
shrinking.apply(shrinking.config)
check(
  'c) 池从 2 → 1 时重抽到剩下的那张（不会返回已删掉的值）',
  shrinking.resolved === survivor,
  `${shrinkPick} → ${shrinking.resolved}，期望 ${survivor}`,
)

/* ═══════════════════════════════════════════════════════════════════
 * 面板动作：把真正的组件渲染出来，点按钮 / 改 Select
 *
 * 这些动作（清空、换一张、切来源）都闭包在 ThemeStudioSection 内部，
 * 只有渲染面板才能走到。注册项是 `h(Provider, …, h(ThemeStudioSection, props))`
 * 的外壳，桩里的 Provider 为空，所以直接取 children[0] 调用即可。
 * ═══════════════════════════════════════════════════════════════════ */

const registrations = []
client.apply({
  effect: (fn) => {
    fn()
    return () => {}
  },
  locale: { register: () => () => {} },
  slots: {
    inject: (name, fn) => {
      fn()
      return () => {}
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
})
const registration = registrations.find((item) => item.options?.id === 'theme-studio')
check('面板注册项存在（清空 / 切来源 / 重选都走它的闭包）', registration !== undefined)

/**
 * 渲染设置面板的某个标签页。
 * @param runtime - 塞进 React context 的运行时。
 * @param tab - 'wallpaper' | 'glass' | 'accent' | 'misc'。
 * @returns React 元素树（函数组件是惰性的，需要时由调用方自己展开）。
 */
function renderPanel(runtime, tab = 'wallpaper') {
  setContextValue(runtime)
  setStateOverride('wallpaper', tab)
  try {
    const wrapper = registration.component({ t: (key) => key })
    const section = [].concat(wrapper.children ?? []).find((child) => typeof child?.type === 'function')
    return section.type(section.props)
  } finally {
    clearStateOverride()
  }
}

/**
 * 深度优先遍历元素树（**只走 children**，不调用函数组件）。
 *
 * 调用函数组件会重新执行闭包、重新创建按钮的 onClick，等于测了另一套对象；
 * 而这里要找的按钮本身是宿主元素，闭包就在当前这棵树里。
 * @param node - 元素树节点或 children 数组。
 * @param visit - 每遇到一个元素节点调用一次。
 */
function walkElements(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walkElements(child, visit)
    return
  }
  visit(node)
  for (const child of [].concat(node.children ?? [])) walkElements(child, visit)
}

/** 按按钮文案找按钮元素（文案只认直接的字符串子节点）。 */
function findButton(tree, label) {
  let found = null
  walkElements(tree, (node) => {
    if (found !== null || node.type !== 'button') return
    const text = [].concat(node.children ?? []).filter((child) => typeof child === 'string').join('')
    if (text === label) found = node
  })
  return found
}

/** 找出所有指定名字的函数组件元素（不展开它们）。 */
function findComponents(tree, name) {
  const found = []
  walkElements(tree, (node) => {
    if (typeof node.type === 'function' && node.type.name === name) found.push(node)
  })
  return found
}

/** 在（已展开的）元素树里找第一个宿主标签。 */
function findHost(tree, tag) {
  let found = null
  walkElements(tree, (node) => {
    if (found === null && node.type === tag) found = node
  })
  return found
}

/** 取「来源」那一行的 <select>（SelectRow 是函数组件，要展开一次）。 */
function findSourceSelect(tree) {
  const row = findComponents(tree, 'SelectRow').find((node) => node.props?.label === '来源')
  if (row === undefined) return undefined
  return findHost(row.type(row.props), 'select')
}

/** 只统计对宿主配置的写入，用来验证「一次提交」。 */
const configPuts = () => requests.filter((request) => request.method === 'PUT' && request.url.includes('/theme-studio/api/config'))

/* ═══════════════════════════════════════════════════════════════════
 * d) 清空壁纸 = 不使用壁纸（不是「再随机抽一张」）
 * ═══════════════════════════════════════════════════════════════════ */

const clearing = makeRuntime({
  wallpapers: ['D:\\壁纸\\a.jpg', 'D:\\壁纸\\b.jpg'],
  wallpaper: { fixed: 'D:\\壁纸\\a.jpg', current: 'D:\\壁纸\\a.jpg' },
})
const backgroundElement = clearing.background.element
check(
  'd) 前置条件：清空前背景层存在、壁纸指向 fixed',
  backgroundElement !== null && clearing.resolved === 'D:\\壁纸\\a.jpg',
  `resolved=${clearing.resolved}`,
)

const clearButton = findButton(renderPanel(clearing, 'wallpaper'), '清空当前壁纸')
check('d) 找到「清空当前壁纸」按钮', clearButton !== undefined)
resetRequests()
clearButton?.props?.onClick?.()
// 等过 persist 的 350ms 防抖：要验证「一次 patch + 一次 persist」只发一笔。
await wait(500)

check('d) 清空后 resolved === ""', clearing.resolved === '', `resolved=${JSON.stringify(clearing.resolved)}`)
check('d) 清空后 wallpaper.source === "none"', clearing.config.wallpaper.source === 'none', String(clearing.config.wallpaper.source))
check(
  'd) 清空后 current / fixed 都被清空',
  clearing.config.wallpaper.current === '' && clearing.config.wallpaper.fixed === '',
  `current=${JSON.stringify(clearing.config.wallpaper.current)} fixed=${JSON.stringify(clearing.config.wallpaper.fixed)}`,
)
check(
  'd) 清空后背景层销毁（对象置空、DOM 里也摘掉了）',
  clearing.background.element === null && backgroundElement.isConnected === false && !dom.html.children.includes(backgroundElement),
  `element=${String(clearing.background.element)} connected=${backgroundElement.isConnected}`,
)
clearing.apply(clearing.config)
check('d) 清空后再 apply 仍然是空（不会从候选池重抽）', clearing.resolved === '', `resolved=${JSON.stringify(clearing.resolved)}`)

const clearPuts = configPuts()
check('d) 清空只提交一笔配置（一次 patch + 一次 persist）', clearPuts.length === 1, `${clearPuts.length} 笔 PUT`)
const clearPayload = clearPuts.length === 1 ? JSON.parse(clearPuts[0].body) : null
check(
  'd) 提交载荷里 source=none 且 current/fixed 为空',
  clearPayload?.wallpaper?.source === 'none' && clearPayload.wallpaper.current === '' && clearPayload.wallpaper.fixed === '',
  JSON.stringify(clearPayload?.wallpaper),
)

/* ═══════════════════════════════════════════════════════════════════
 * 额外：切换来源时必须把「旧来源形态的值」一起清掉（一次提交）
 * ═══════════════════════════════════════════════════════════════════ */

const toUrl = makeRuntime({
  wallpaper: { fixed: 'D:\\壁纸\\a.jpg', current: 'D:\\壁纸\\a.jpg' },
})
const toUrlSelect = findSourceSelect(renderPanel(toUrl, 'wallpaper'))
check('来源 Select 已渲染', toUrlSelect !== undefined)
resetRequests()
toUrlSelect?.props?.onChange?.({ target: { value: 'url' } })
await wait(500)
check('切到 url：source 已更新', toUrl.config.wallpaper.source === 'url', String(toUrl.config.wallpaper.source))
check(
  '切到 url：本地路径的 current / fixed 被一并清空',
  toUrl.config.wallpaper.current === '' && toUrl.config.wallpaper.fixed === '',
  `current=${JSON.stringify(toUrl.config.wallpaper.current)} fixed=${JSON.stringify(toUrl.config.wallpaper.fixed)}`,
)
const toUrlPuts = configPuts()
check('切来源只提交一笔配置', toUrlPuts.length === 1, `${toUrlPuts.length} 笔 PUT`)
const toUrlPayload = toUrlPuts.length === 1 ? JSON.parse(toUrlPuts[0].body) : null
check(
  '切来源的载荷里同时带上了 source 与清空后的 current/fixed',
  toUrlPayload?.wallpaper?.source === 'url' && toUrlPayload.wallpaper.current === '' && toUrlPayload.wallpaper.fixed === '',
  JSON.stringify(toUrlPayload?.wallpaper),
)

const toFolder = makeRuntime({
  wallpaper: {
    source: 'url',
    urls: ['https://example.com/a.jpg'],
    fixed: 'https://example.com/a.jpg',
    current: 'https://example.com/a.jpg',
  },
})
const toFolderSelect = findSourceSelect(renderPanel(toFolder, 'wallpaper'))
resetRequests()
toFolderSelect?.props?.onChange?.({ target: { value: 'folder' } })
await wait(500)
check(
  '从 url 切到 folder：http 链接的 current / fixed 被清空',
  toFolder.config.wallpaper.source === 'folder' &&
    toFolder.config.wallpaper.current === '' &&
    toFolder.config.wallpaper.fixed === '',
  `source=${toFolder.config.wallpaper.source} current=${JSON.stringify(toFolder.config.wallpaper.current)}`,
)

/* ═══════════════════════════════════════════════════════════════════
 * 额外：「重选随机壁纸」必须落盘，且池里没别的图时不能静默改状态
 * ═══════════════════════════════════════════════════════════════════ */

const reroll = makeRuntime({
  wallpapers: ['D:\\壁纸\\a.jpg', 'D:\\壁纸\\b.jpg'],
  wallpaper: { fixed: 'D:\\壁纸\\a.jpg', current: 'D:\\壁纸\\a.jpg' },
})
const rerollButton = findButton(renderPanel(reroll, 'misc'), '重选随机壁纸')
check('找到「重选随机壁纸」按钮', rerollButton !== undefined)
resetRequests()
rerollButton?.props?.onClick?.()
await wait(500)
check(
  '重选随机壁纸排除了当前那张，并真正写进配置',
  reroll.config.wallpaper.fixed === 'D:\\壁纸\\b.jpg' && reroll.resolved === 'D:\\壁纸\\b.jpg',
  `fixed=${JSON.stringify(reroll.config.wallpaper.fixed)} resolved=${JSON.stringify(reroll.resolved)}`,
)
check('重选随机壁纸会落盘（旧实现只改内存）', configPuts().length === 1, `${configPuts().length} 笔 PUT`)

const single = makeRuntime({
  wallpapers: ['D:\\壁纸\\only.jpg'],
  wallpaper: { fixed: 'D:\\壁纸\\only.jpg', current: 'D:\\壁纸\\only.jpg' },
})
const singleButton = findButton(renderPanel(single, 'misc'), '重选随机壁纸')
resetRequests()
singleButton?.props?.onClick?.()
await wait(500)
check(
  '池里只有当前这张时不做任何改动（只给状态提示，不再静默无效）',
  single.config.wallpaper.fixed === 'D:\\壁纸\\only.jpg' &&
    single.resolved === 'D:\\壁纸\\only.jpg' &&
    configPuts().length === 0,
  `fixed=${JSON.stringify(single.config.wallpaper.fixed)} puts=${configPuts().length}`,
)

/* ═══════════════════════════════════════════════════════════════════
 * e) 客户端 defaultConfig 里不再有死配置
 * ═══════════════════════════════════════════════════════════════════ */

const defaults = defaultConfig()
check('e) 客户端 defaultConfig 不再有顶层 scope', !Object.hasOwn(defaults, 'scope'), Object.keys(defaults).join(','))
check(
  'e) 客户端 defaultConfig.wallpaper 不再有 rotate',
  !Object.hasOwn(defaults.wallpaper, 'rotate'),
  Object.keys(defaults.wallpaper).join(','),
)

/* ═══════════════════════════════════════════════════════════════════
 * C2：样式语义与数值 / CSS 字符串安全（audit P1-12、P1-13、P3-9）
 *
 * 这一组只测纯函数输出（buildCss / toCssUrl / cleanCssUrl）与背景层的
 * 数值写入，不碰壁纸解析状态，因此不会干扰上面 a) ~ e) 的用例。
 * ═══════════════════════════════════════════════════════════════════ */

const designBase = defaultConfig()
const defaultCss = client.buildCss(designBase)
check('原生遮罩令牌在 body 上求值，不能在 html 上提前引用 DSH 的 body 令牌',
  /html\[data-dsh-theme-studio\] body \{\s*--ds-ts-bars: var\(--dsw-specific-sidebar-fill\)/.test(defaultCss) &&
    /html\[data-dsh-theme-studio\] body\[data-ds-dark-theme\] \{\s*--ds-ts-bars: var\(--dsw-specific-sidebar-fill\)/.test(defaultCss) &&
    !/html\[data-dsh-theme-studio\] \{\s*--ds-ts-bars:/.test(defaultCss))
/**
 * 「外壳透明」那条规则的精确形态。
 *
 * 注意不能笼统地断言 CSS 里没有 `background: transparent !important`：
 * 边栏关掉自身底色、输入框玻璃、`.pI_x6G_frame`（玻璃的前提）都合法地包含
 * 这个短语。这里要钉住的是**只作用于 html/body 的那一条**。
 */
const SHELL_RULE =
  'html[data-dsh-theme-studio], html[data-dsh-theme-studio] body { background: transparent !important; }'

/* ── 1) 关闭分区 = 完整还原 DSH 原生 ─────────────────────────────── */

const inputOffCss = client.buildCss({
  ...designBase,
  glass: { ...designBase.glass, input: { enabled: false, opacity: 0.5, blur: 20 } },
})
check(
  '1) input 关闭后没有变量或覆盖令牌；附件卡仍可读取 DSH 原生输入底色',
  !inputOffCss.includes('--ds-ts-input') &&
    !inputOffCss.includes('--dsw-specific-input-major:') &&
    !inputOffCss.includes('.uV2eYG_card'),
  `--ds-ts-input=${inputOffCss.includes('--ds-ts-input')} token=${inputOffCss.includes('--dsw-specific-input-major')} rule=${inputOffCss.includes('.uV2eYG_card')}`,
)
check(
  '1) 关闭 input 不影响其余分区的变量与令牌',
  ['--ds-ts-bars', '--ds-ts-bubble', '--ds-ts-menu', '--dsw-specific-bubble'].every(
    (token) => inputOffCss.includes(token),
  ),
  ['--ds-ts-bars', '--ds-ts-bubble', '--ds-ts-menu', '--dsw-specific-bubble']
    .filter((token) => !inputOffCss.includes(token))
    .join(',') || 'ok',
)

/* 菜单和设置弹窗消费同一组 DSH 背景令牌。如果令牌写在 body，设置面板即使没有
 * 命中任何菜单选择器，也会继承菜单的半透明底色；必须只在设置弹窗外的菜单上覆盖。 */
const menuGlassCss = client.buildCss({
  ...designBase,
  glass: { ...designBase.glass, menu: { enabled: true, opacity: 0.45, blur: 23 } },
})
const cssRules = [...menuGlassCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, declarations]) => ({ selector: selector.trim(), declarations }))
const sharedMenuTokens = [
  '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3',
  '--dsw-specific-tip', '--dsw-specific-selector', '--dsw-specific-menu',
]
const menuTokenRules = cssRules.filter(({ declarations }) =>
  sharedMenuTokens.some((token) => declarations.includes(`${token}:`)))
const scopedMenuSelectors = client.REGION_SELECTORS.menu
  .map((selector) => `html[data-dsh-theme-studio] ${selector}:not(.VOzbGW_panel *, .VOzbGW_overlay *)`)
check('1a) 菜单的共享背景令牌只在菜单表面覆盖，不再污染整个 body/设置面板',
  menuTokenRules.length === 1 &&
    scopedMenuSelectors.every((selector) => menuTokenRules[0].selector.includes(selector)) &&
    ['--dsw-specific-menu: var(--ds-ts-menu) !important;',
      '--dsw-alias-bg-layer-2: var(--ds-ts-menu-layer-2) !important;',
      '--dsw-alias-bg-layer-3: var(--ds-ts-menu-layer-3) !important;',
      '--dsw-specific-tip: var(--ds-ts-menu-tip) !important;',
      '--dsw-specific-selector: var(--ds-ts-menu-tip) !important;'].every((token) =>
      menuTokenRules[0].declarations.includes(token)) &&
    !cssRules.some(({ selector, declarations }) => selector.endsWith(' body') &&
      sharedMenuTokens.some((token) => declarations.includes(`${token}:`))),
  menuTokenRules.map((rule) => rule.selector).join(' | '))
const menuBlurRule = cssRules.find(({ declarations }) => declarations.includes('backdrop-filter: blur(23px);'))
check('1a) 普通弹层仍有 23px 模糊，且设置面板/浮层内的菜单不受影响',
  menuBlurRule !== undefined && scopedMenuSelectors.every((selector) => menuBlurRule.selector.includes(selector)) &&
    !menuBlurRule.selector.includes('] .VOzbGW_panel,'),
  menuBlurRule?.selector ?? '(无)')
check('1a) 插件设置卡片保留 DSH 原生 bg-layer-2，不再继承菜单底色',
  cssRules.every(({ selector, declarations }) =>
    !selector.endsWith(' body') || !declarations.includes('--dsw-alias-bg-layer-2:')) &&
    !cssRules.some(({ selector }) => selector.includes('] .VOzbGW_panel {')))

/* 自定义颜色只替换各分区玻璃膜的 RGB；alpha 仍来自该分区不透明度，
 * menu 的共享 token 必须维持在设置面板外，不能因新增选色再次写回 body。 */
const customGlass = {
  ...designBase,
  glass: {
    ...designBase.glass,
    bars: { enabled: true, opacity: 0.21, blur: 10, color: '#a1b2c3' },
    input: { enabled: true, opacity: 0.32, blur: 12, color: '#224466' },
    bubble: { enabled: true, opacity: 0.43, blur: 14, color: '#eeaa55' },
    assistant: { enabled: true, opacity: 0.54, blur: 16, color: '#112233' },
    menu: { enabled: true, opacity: 0.65, blur: 18, color: '#ff0080' },
  },
}
const customGlassCss = client.buildCss(customGlass)
const defaultColors = [
  ['bars', 'sidebar-fill', 'sidebar-fill'],
  ['bars-head', '00', '950'],
  ['input', '00', '850'],
  ['bubble', 'deepseek-50', '850'],
  ['bubble-file', '00', '850'],
  ['assistant', '00', '950'],
]
check('1b) 默认色使用 DSH 原生明暗令牌；侧栏/顶栏及气泡/附件卡保留各自底色',
  defaultColors.every(([key, light, dark]) => {
    const token = (shade) => shade === 'sidebar-fill' ? '--dsw-specific-sidebar-fill' :
      shade === 'deepseek-50' ? '--dsw-static-deepseek-50' : `--dsw-static-neutral-bluish-${shade}`
    return defaultCss.includes(`--ds-ts-${key}: var(${token(light)})`) &&
      defaultCss.includes(`--ds-ts-${key}: var(${token(dark)})`)
  }) &&
  defaultCss.includes('--ds-ts-menu: var(--dsw-specific-menu)') &&
  !defaultCss.includes('--dsw-specific-menu:') &&
  !defaultCss.includes('--dsw-elevation-soft:'))
check('1b) 无壁纸时左侧整列实际绘制原生遮罩，自定义颜色也复用同一入口',
  defaultCss.includes('.pI_x6G_sidebarCol { background: var(--ds-ts-bars) !important; }') &&
    customGlassCss.includes('.pI_x6G_sidebarCol { background: var(--ds-ts-bars) !important; }') &&
    customGlassCss.includes('--ds-ts-bars: rgb(161 178 195 / 0.210)') &&
    !defaultCss.includes('.pI_x6G_frame { background: transparent !important; }'))
const halfNative = client.buildCss({ ...designBase, glass: {
  ...designBase.glass,
  bars: { enabled: true, opacity: 0.5, blur: 20, color: 'auto' },
  input: { enabled: true, opacity: 0.5, blur: 20, color: 'auto' },
  bubble: { enabled: true, opacity: 0.5, blur: 20, color: 'auto' },
  assistant: { enabled: true, opacity: 0.5, blur: 20, color: 'auto' },
  menu: { enabled: true, opacity: 0.5, blur: 20, color: 'auto' },
} })
check('1b) 自动遮罩降低 opacity 时仍从原生底色取色，不硬编码近似白/蓝/灰',
  halfNative.includes('--ds-ts-bars: color-mix(in srgb, var(--dsw-specific-sidebar-fill) 50.0%, transparent)') &&
    halfNative.includes('--ds-ts-bars-head: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 50.0%, transparent)') &&
    halfNative.includes('--ds-ts-input: color-mix(in srgb, var(--dsw-static-neutral-bluish-850) 50.0%, transparent)') &&
    halfNative.includes('--ds-ts-bubble: color-mix(in srgb, var(--dsw-static-deepseek-50) 50.0%, transparent)') &&
    halfNative.includes('--ds-ts-bubble-file: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 50.0%, transparent)') &&
    halfNative.includes('--ds-ts-assistant: color-mix(in srgb, var(--dsw-static-neutral-bluish-950) 50.0%, transparent)') &&
    halfNative.includes('--ds-ts-menu: color-mix(in srgb, var(--dsw-specific-menu) 50.0%, transparent)'))
check('1b) 半透明输入卡与菜单仍沿用 DSH 的描边及阴影，不叠加插件白边',
  !halfNative.includes('--dsw-elevation-soft:') &&
    !halfNative.includes('box-shadow: var(--ds-ts-inset)') &&
    !halfNative.includes('--ds-ts-edge:'))
check('1b) 默认菜单不覆盖原生有 alpha 的令牌；半透明菜单分别保留 layer、tip 的原生色系',
  !defaultCss.includes('--dsw-specific-menu:') &&
    halfNative.includes('--dsw-alias-bg-layer-2: var(--ds-ts-menu-layer-2) !important;') &&
    halfNative.includes('--dsw-specific-tip: var(--ds-ts-menu-tip) !important;') &&
    halfNative.includes('--ds-ts-menu-layer-2: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 50.0%, transparent)') &&
    halfNative.includes('--ds-ts-menu-layer-3: color-mix(in srgb, var(--dsw-alias-bg-layer-3) 50.0%, transparent)') &&
    halfNative.includes('--ds-ts-menu-tip: color-mix(in srgb, var(--dsw-specific-tip) 50.0%, transparent)'))
const customInputNativeBubbleCss = client.buildCss({
  ...designBase,
  glass: { ...designBase.glass, input: { ...designBase.glass.input, color: '#224466' } },
})
check('1b) 用户气泡附件卡取原生输入底色，不被输入框分区的自定义色串改',
  customInputNativeBubbleCss.includes('--ds-ts-input: rgb(34 68 102 / 1.000)') &&
    customInputNativeBubbleCss.includes('--ds-ts-bubble-file: var(--dsw-static-neutral-bluish-00)') &&
    customInputNativeBubbleCss.includes('--ds-ts-bubble-file: var(--dsw-static-neutral-bluish-850)') &&
    !customInputNativeBubbleCss.includes('--ds-ts-bubble-file: var(--dsw-specific-input-major)'))
const adjustedBorder = client.buildCss({ ...designBase, glass: { ...designBase.glass, border: 0.9 } })
check('1b) 用户主动调整描边滑块时仍可启用增强描边；默认滑块不接管原生描边',
  adjustedBorder.includes('--dsw-elevation-soft: var(--ds-ts-edge) !important;') &&
    !defaultCss.includes('--dsw-elevation-soft:'))
const colorExpectations = [
  ['bars', '161 178 195 / 0.210'],
  ['input', '34 68 102 / 0.320'],
  ['bubble', '238 170 85 / 0.430'],
  ['assistant', '17 34 51 / 0.540'],
  ['menu', '255 0 128 / 0.650'],
]
check('1b) 每个分区的遮罩颜色和自身不透明度共同生成 RGB / alpha（明暗主题相同）',
  colorExpectations.every(([key, rgb]) =>
    customGlassCss.split(`--ds-ts-${key}: rgb(${rgb})`).length - 1 === 2),
  colorExpectations.filter(([key, rgb]) =>
    customGlassCss.split(`--ds-ts-${key}: rgb(${rgb})`).length - 1 !== 2).map(([key]) => key).join(',') || '均正确')
check('1b) 自定义边栏颜色对侧栏/顶栏相同，默认色分别来自原生侧栏/顶栏',
  customGlassCss.split('--ds-ts-bars-head: rgb(161 178 195 / 0.210)').length - 1 === 2 &&
    defaultCss.includes('--ds-ts-bars: var(--dsw-specific-sidebar-fill)') &&
    defaultCss.includes('--ds-ts-bars-head: var(--dsw-static-neutral-bluish-00)'))
check('1b) 自定义菜单遮罩仍只作用于设置界面外，不把菜单令牌写回 body',
  !/body\s*\{[^}]*--dsw-alias-bg-layer-2:/.test(customGlassCss) &&
    customGlassCss.includes(':not(.VOzbGW_panel *, .VOzbGW_overlay *)') &&
    customGlassCss.includes('--dsw-specific-menu: var(--ds-ts-menu) !important;'))
const invalidGlassCss = client.buildCss({
  ...designBase,
  glass: { ...designBase.glass, bubble: { enabled: true, opacity: 0.4, blur: 0, color: '#fff); color:red' } },
})
check('1b) 直接生成 CSS 时非法遮罩颜色仍回退原配色，不允许注入声明',
  invalidGlassCss.includes('--ds-ts-bubble: color-mix(in srgb, var(--dsw-static-deepseek-50) 40.0%, transparent)') &&
    !invalidGlassCss.includes('color:red'))
const onlyBubbleColorCss = client.buildCss({
  ...designBase,
  glass: { ...designBase.glass, bubble: { ...designBase.glass.bubble, color: '#112233' } },
})
check('1b) 只改用户气泡颜色不改变 AI 回复及其它分区的默认颜色/不透明度',
  onlyBubbleColorCss.includes('--ds-ts-bubble: rgb(17 34 51 / 1.000)') &&
    onlyBubbleColorCss.includes('--ds-ts-assistant: var(--dsw-static-neutral-bluish-00)') &&
    onlyBubbleColorCss.includes('--ds-ts-input: var(--dsw-static-neutral-bluish-00)') &&
    onlyBubbleColorCss.includes('--ds-ts-assistant: var(--dsw-static-neutral-bluish-950)'))
const bubbleColorOffCss = client.buildCss({
  ...designBase,
  glass: { ...designBase.glass, bubble: { enabled: false, opacity: 0.4, blur: 12, color: '#112233' } },
})
check('1b) 分区关闭后自定义颜色也不产生变量和元素覆盖',
  !bubbleColorOffCss.includes('--ds-ts-bubble') && !bubbleColorOffCss.includes('--dsw-specific-bubble'))

/* ── 2) source=none 时不允许强制外壳透明 ─────────────────────────── */

check(
  '2) 出厂默认（source=none）不输出外壳透明规则、不覆盖 --dsw-alias-bg-base',
  !defaultCss.includes(SHELL_RULE) && !defaultCss.includes('--dsw-alias-bg-base'),
  `shell=${defaultCss.includes(SHELL_RULE)} bg-base=${defaultCss.includes('--dsw-alias-bg-base')}`,
)

/* ── 3) 有壁纸来源且真正解析到图时上述两条才出现 ─────────────────── */

const folderCss = client.buildCss(
  {
    ...designBase,
    wallpaper: { ...designBase.wallpaper, source: 'folder' },
  },
  'D:\\壁纸\\a.jpg',
)
check(
  '3) source=folder 且 resolved 有效时才输出外壳透明与 --dsw-alias-bg-base',
  folderCss.includes(SHELL_RULE) && folderCss.includes('--dsw-alias-bg-base'),
  `shell=${folderCss.includes(SHELL_RULE)} bg-base=${folderCss.includes('--dsw-alias-bg-base')}`,
)

/* ── 4) 主题色通道规范化 ─────────────────────────────────────────── */

const accentCss = client.buildCss({
  ...designBase,
  accent: { enabled: true, rgb: [999, -5, 12.7], preset: 'deepseek' },
})
const accentChannels = [...accentCss.matchAll(/rgb\((\d+) (\d+) (\d+)\)/g)].map((match) => [
  Number(match[1]),
  Number(match[2]),
  Number(match[3]),
])
check(
  '4) 主题色 [999, -5, 12.7] 规范成 255 / 0 / 13，且没有 NaN',
  accentCss.includes('--dsw-static-deepseek-500: rgb(255 0 13)') &&
    !accentCss.includes('NaN') &&
    accentChannels.length > 0 &&
    accentChannels.every((channels) => channels.every((value) => value >= 0 && value <= 255)),
  `channels=${accentChannels.map((channels) => channels.join('/')).join(',')} NaN=${accentCss.includes('NaN')}`,
)

/* ── 5) 非数字参数不得产生 NaN ───────────────────────────────────── */

const nanCss = client.buildCss({
  ...designBase,
  glass: { ...designBase.glass, input: { enabled: true, opacity: Number('x'), blur: 20 } },
  wallpaper: { ...designBase.wallpaper, dim: NaN },
})
check(
  '5) glass.input.opacity=NaN 时 buildCss 安全回落到默认不透明度，输出无 NaN',
  !nanCss.includes('NaN') && nanCss.includes('--ds-ts-input: var(--dsw-static-neutral-bluish-00)'),
  `NaN=${nanCss.includes('NaN')} tokens=${(nanCss.match(/--ds-ts-input[^;]*/g) ?? []).join(' | ')}`,
)

/* 真正写进背景层变量的路径也顺带钉一遍：buildCss 根本不消费 wallpaper.dim，
 * 只测它等于没测。这里通过 patch() 触发一次真实 apply。 */
const nanRuntime = makeRuntime({ wallpapers: ['D:\\壁纸\\nan.jpg'] })
nanRuntime.patch('wallpaper.dim', NaN)
const nanBgStyle = nanRuntime.background.element?.style ?? {}
const numericBgVars = [
  '--ds-ts-bg-blur',
  '--ds-ts-bg-brightness',
  '--ds-ts-bg-saturate',
  '--ds-ts-bg-dim',
  '--ds-ts-bg-vignette',
  '--ds-ts-bg-noise',
]
const badBgVars = numericBgVars.filter(
  (key) => typeof nanBgStyle[key] !== 'string' || nanBgStyle[key].includes('NaN'),
)
check(
  '5) wallpaper.dim=NaN 时写进背景层的变量同样不含 NaN',
  badBgVars.length === 0,
  badBgVars.length === 0 ? 'ok' : `异常变量：${badBgVars.map((key) => `${key}=${nanBgStyle[key]}`).join(', ')}`,
)

const alignmentRuntime = makeRuntime({ wallpaper: { fixed: 'D:\\壁纸\\align.jpg', fit: 'cover' } })
const alignmentSource = alignmentRuntime.resolved
const alignmentCss = client.buildCss(alignmentRuntime.config, alignmentSource)
const imageRule = /\.ds-ts-bg-image\s*\{([^}]+)\}/.exec(alignmentCss)?.[1] ?? ''
const alignmentResults = ['center', 'top', 'bottom', 'left', 'right'].map((position) => {
  alignmentRuntime.patch('wallpaper.position', position)
  return alignmentRuntime.config.wallpaper.position === position &&
    alignmentRuntime.background.element?.style['--ds-ts-bg-position'] === position &&
    alignmentRuntime.background.element?.style['--ds-ts-bg-size'] === 'cover' &&
    alignmentRuntime.background.element?.style['--ds-ts-bg-scale'] === undefined &&
    alignmentRuntime.background.imageEl?.style['background-position'] === position &&
    alignmentRuntime.background.imageEl?.style['transform-origin'] === undefined &&
    alignmentRuntime.resolved === alignmentSource
})
check('5b) cover 五个对齐选项只改变图片的 background-position，不换壁纸或放大图层',
  alignmentResults.every(Boolean) &&
    imageRule.includes('background-size: var(--ds-ts-bg-size, cover)') &&
    imageRule.includes('background-position: var(--ds-ts-bg-position, center)') &&
    !/\btransform(?:-origin)?\s*:/.test(imageRule),
  alignmentResults.join(','))

// CSS cover 等比例缩放后，background-position 仅分配多出的宽/高；这里用明确的裁切范围
// 约束预期语义。和上面的无 transform 断言配对，防止再靠放大图层制造「假对齐」。
function coverCrop(imageWidth, imageHeight, viewportWidth, viewportHeight, position) {
  const scale = Math.max(viewportWidth / imageWidth, viewportHeight / imageHeight)
  const overflowX = imageWidth * scale - viewportWidth
  const overflowY = imageHeight * scale - viewportHeight
  const cropX = (position === 'right' ? overflowX : position === 'left' ? 0 : overflowX / 2) / scale
  const cropY = (position === 'bottom' ? overflowY : position === 'top' ? 0 : overflowY / 2) / scale
  return { left: cropX, right: cropX + viewportWidth / scale, top: cropY, bottom: cropY + viewportHeight / scale }
}
const landscapeRight = coverCrop(2100, 900, 1600, 900, 'right')
const landscapeCenter = coverCrop(2100, 900, 1600, 900, 'center')
const landscapeLeft = coverCrop(2100, 900, 1600, 900, 'left')
check('5b) 21:9 图片放入 16:9 窗口：右对齐保留右边缘，从左侧裁掉 500px',
  landscapeRight.left === 500 && landscapeRight.right === 2100 &&
    landscapeCenter.left === 250 && landscapeLeft.left === 0,
  `left=${JSON.stringify(landscapeLeft)} center=${JSON.stringify(landscapeCenter)} right=${JSON.stringify(landscapeRight)}`)
const portraitTop = coverCrop(900, 2100, 900, 1600, 'top')
const portraitBottom = coverCrop(900, 2100, 900, 1600, 'bottom')
check('5b) 高图放入矮窗口：顶部/底部对齐分别裁掉下方/上方 500px',
  portraitTop.top === 0 && portraitTop.bottom === 1600 &&
    portraitBottom.top === 500 && portraitBottom.bottom === 2100,
  `top=${JSON.stringify(portraitTop)} bottom=${JSON.stringify(portraitBottom)}`)
check('5b) 图片与窗口宽高比相同，没有多余画面时所有方向不额外裁切',
  ['center', 'top', 'bottom', 'left', 'right'].every((position) => {
    const crop = coverCrop(1600, 900, 1600, 900, position)
    return crop.left === 0 && crop.right === 1600 && crop.top === 0 && crop.bottom === 900
  }))
alignmentRuntime.patch('wallpaper.fit', 'contain')
check('5b) 完整显示保留 contain 与右侧对齐，不继承额外放大',
  alignmentRuntime.background.element?.style['--ds-ts-bg-size'] === 'contain' &&
    alignmentRuntime.background.element?.style['--ds-ts-bg-scale'] === undefined &&
    alignmentRuntime.background.imageEl?.style['background-position'] === 'right' &&
    alignmentRuntime.config.wallpaper.position === 'right')
alignmentRuntime.patch('wallpaper.fit', 'repeat')
check('5b) 平铺仍使用原始尺寸和右侧对齐，不放大图层',
  alignmentRuntime.background.element?.style['--ds-ts-bg-size'] === 'auto' &&
    alignmentRuntime.background.element?.style['--ds-ts-bg-repeat'] === 'repeat' &&
    alignmentRuntime.background.element?.style['--ds-ts-bg-scale'] === undefined &&
    alignmentRuntime.background.imageEl?.style['background-position'] === 'right')
alignmentRuntime.patch('wallpaper.fit', 'cover')
check('5b) 切回 cover 后右侧对齐仍生效，且不制造额外裁切',
  alignmentRuntime.background.element?.style['--ds-ts-bg-size'] === 'cover' &&
    alignmentRuntime.background.element?.style['--ds-ts-bg-scale'] === undefined &&
    alignmentRuntime.background.imageEl?.style['background-position'] === 'right')

const tintedRuntime = makeRuntime({ wallpaper: { dim: 0.4 } })
check('5a) 旧配置未指定颜色时背景遮罩仍是黑色，暗化强度保持原值',
  tintedRuntime.background.element?.style['--ds-ts-bg-dim-rgb'] === '0 0 0' &&
    tintedRuntime.background.element?.style['--ds-ts-bg-dim'] === '0.4')
tintedRuntime.patch('wallpaper.dimColor', '#1a80e6')
check('5a) 自定义颜色只改变遮罩 RGB，不改变暗化强度和壁纸来源',
  tintedRuntime.background.element?.style['--ds-ts-bg-dim-rgb'] === '26 128 230' &&
    tintedRuntime.background.element?.style['--ds-ts-bg-dim'] === '0.4' &&
    tintedRuntime.config.wallpaper.dimColor === '#1a80e6' &&
    tintedRuntime.config.wallpaper.source === 'folder')
tintedRuntime.patch('wallpaper.dim', 0)
check('5a) 遮罩强度为 0 时自定义颜色仍保留、但不会显示遮罩',
  tintedRuntime.background.element?.style['--ds-ts-bg-dim'] === '0' &&
    tintedRuntime.background.element?.style['--ds-ts-bg-dim-rgb'] === '26 128 230')
tintedRuntime.patch('wallpaper.dimColor', 'auto')
check('5a) 恢复默认只改回黑色，保持滑块强度为 0',
  tintedRuntime.background.element?.style['--ds-ts-bg-dim-rgb'] === '0 0 0' &&
    tintedRuntime.config.wallpaper.dim === 0)
const sanitizedDimColor = client.sanitizeConfig({ wallpaper: { dimColor: 'red; background:lime' } })
check('5a) 非法颜色回退 auto，不允许配置文本注入背景 CSS',
  sanitizedDimColor.wallpaper.dimColor === 'auto' &&
    client.sanitizeConfig({ wallpaper: { dimColor: '#AbC' } }).wallpaper.dimColor === '#aabbcc' &&
    client.buildCss(defaultConfig()).includes('rgb(var(--ds-ts-bg-dim-rgb, 0 0 0) / var(--ds-ts-bg-dim, 0))') &&
    client.buildCss(defaultConfig()).includes('calc(var(--ds-ts-bg-dim, 0) * .7)'))

/* ── 6) CSS 字符串 / URL 安全 ────────────────────────────────────── */

const { toCssUrl, cleanCssUrl } = client

const quotedPath = toCssUrl('folder', 'D:\\壁纸\\a"b.jpg')
/* POSIX 绝对路径也测一次：旧实现把以 `/` 开头的值当「同源地址」原样塞进 url()，
 * 引号会直接闭合字符串 —— 这正是 CSS 注入面。新实现统一走 /api/image 并编码。 */
const posixQuotedPath = toCssUrl('folder', '/home/a"b.jpg')
check(
  '6) 本地路径（Windows / POSIX 绝对路径）里的引号被编码成 %22，url() 不会被提前闭合',
  quotedPath.startsWith('url("') &&
    quotedPath.endsWith('")') &&
    quotedPath.includes('%22') &&
    quotedPath.split('"').length === 3 &&
    posixQuotedPath.includes('%22') &&
    posixQuotedPath.split('"').length === 3,
  `${quotedPath} | ${posixQuotedPath}`,
)

const escapedSameOrigin = toCssUrl('url', '/theme-studio/a"b.jpg')
check(
  '6) 同源路径里的引号被 CSS 转义（\\"），换行/反斜杠也不会裸奔',
  escapedSameOrigin === 'url("/theme-studio/a\\"b.jpg")' &&
    !toCssUrl('url', '/theme-studio/a\nb.jpg').includes('\n') &&
    toCssUrl('url', '/theme-studio/a\\b.jpg').includes('\\\\'),
  escapedSameOrigin,
)
check(
  '6) cleanCssUrl 能还原 CSS 转义（正则解析，不再靠 slice 硬切）',
  cleanCssUrl(toCssUrl('url', '/theme-studio/a"b.jpg')) === '/theme-studio/a"b.jpg' &&
    cleanCssUrl(toCssUrl('folder', 'D:\\壁纸\\a"b.jpg')) ===
      `/theme-studio/api/image?path=${encodeURIComponent('D:\\壁纸\\a"b.jpg')}`,
  cleanCssUrl(toCssUrl('url', '/theme-studio/a"b.jpg')),
)
check(
  '6) cleanCssUrl 对非 url() 形态安全返回空串（不会切出畸形地址）',
  cleanCssUrl('not-a-css-url') === '' && cleanCssUrl(null) === '' && cleanCssUrl(undefined) === '',
  JSON.stringify([cleanCssUrl('not-a-css-url'), cleanCssUrl(null), cleanCssUrl(undefined)]),
)

const rejectedUrls = [
  toCssUrl('url', 'javascript:alert(1)'),
  toCssUrl('url', 'JaVaScRiPt:alert(1)'),
  toCssUrl('upload', 'vbscript:msgbox(1)'),
  toCssUrl('folder', 'data:image/png;base64,AAAA'),
  toCssUrl('url', 'data:image/svg+xml,<svg onload="x">'),
]
check(
  '6) javascript: / vbscript: / 不可信 data: 一律返回 none',
  rejectedUrls.every((item) => item === 'none'),
  rejectedUrls.join(' | '),
)
check(
  '6) 已存配置里的干净 data: 仍然可用（不误伤正常壁纸）',
  toCssUrl('url', 'data:image/png;base64,AAAA') === 'url("data:image/png;base64,AAAA")',
  toCssUrl('url', 'data:image/png;base64,AAAA'),
)

/* ── 7) 五个分区全关：一条分区规则都不留 ─────────────────────────── */

const allOffConfig = {
  ...designBase,
  glass: {
    ...designBase.glass,
    bars: { enabled: false, opacity: 0.5, blur: 20 },
    input: { enabled: false, opacity: 0.5, blur: 20 },
    bubble: { enabled: false, opacity: 0.5, blur: 20 },
    assistant: { enabled: false, opacity: 0.5, blur: 20 },
    menu: { enabled: false, opacity: 0.5, blur: 20 },
  },
}
const allOffCss = client.buildCss(allOffConfig)
const regionTokens = [
  '--ds-ts-bars',
  '--ds-ts-input',
  '--ds-ts-bubble',
  '--ds-ts-assistant',
  '--ds-ts-menu',
  '--dsw-specific-input-major',
  '--dsw-specific-bubble',
  '--dsw-specific-menu',
  '--dsw-specific-tip',
  '--dsw-specific-selector',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
]
const allRegionSelectors = Object.values(client.REGION_SELECTORS).flat()
check(
  '7) 五个分区全关时没有任何分区变量与对应 --dsw-* 覆盖',
  regionTokens.every((token) => !allOffCss.includes(token)),
  regionTokens.filter((token) => allOffCss.includes(token)).join(',') || 'none',
)
check(
  '7) 五个分区全关时连元素规则也不输出（完整还原 DSH 原生）',
  allRegionSelectors.every((selector) => !allOffCss.includes(selector)),
  allRegionSelectors.filter((selector) => allOffCss.includes(selector)).join(',') || 'none',
)
check(
  '7) 分区全关 + source=none 时外壳变量也不输出',
  !allOffCss.includes('--ds-ts-frame') && !allOffCss.includes('--dsw-alias-bg-base'),
  `frame=${allOffCss.includes('--ds-ts-frame')} bg-base=${allOffCss.includes('--dsw-alias-bg-base')}`,
)

/* ═══════════════════════════════════════════════════════════════════
 * C3：客户端配置清理 / 缓存版本化 / 运行时状态一致性
 *（audit P1-18「客户端缓存永远不清理废弃键」、
 *   audit P3-9「putConfig 不 apply、clearIfActive 用旧快照」）
 *
 * 为什么放在最后：这一组会替换 fetch 桩、预置 localStorage、再调用一次
 * `client.apply()`。放在前面会破坏 a) ~ e) 对「默认 fetch / 同一个运行时」的假设；
 * 而 C2 只碰纯函数，所以插在它后面是安全的。
 * ═══════════════════════════════════════════════════════════════════ */

const sanitizeConfig = client.sanitizeConfig
const c3Defaults = defaultConfig()

/** 造一个与 `readJsonResponse` 契约一致的响应桩。 */
const c3Json = (body, status = 200) => ({ status, text: async () => JSON.stringify(body) })

/** 造一个最小客户端 ctx（与文件开头那份等价），用于再次调用 `client.apply()`。 */
function c3Context() {
  return {
    effect: (fn) => {
      fn()
      return () => {}
    },
    locale: { register: () => () => {} },
    slots: {
      inject: (name, fn) => {
        fn()
        return () => {}
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
}

/** 取最近一次 `apply()` 创建出来的 ThemeRuntime（注册组件包在 Provider 里）。 */
function c3Runtime() {
  const wrapper = registrations[registrations.length - 1].component({ t: (key) => key })
  return wrapper.props.value
}

check('C3 前置：sanitizeConfig 已导出', typeof sanitizeConfig === 'function')
check('C3) 未选颜色的旧配置自动补 auto；五个分区默认随明暗主题',
  ['bars', 'input', 'bubble', 'assistant', 'menu'].every((key) =>
    sanitizeConfig({ glass: { [key]: { opacity: 0.5 } } }).glass[key].color === 'auto'))
const cleanedGlassColors = sanitizeConfig({ glass: {
  input: { color: '#f0a' }, bubble: { color: 'rgb(300, 8, 23)' },
  assistant: { color: '#111111; background:red' }, menu: { color: ['#ff0000'] },
} }).glass
check('C3) 颜色清洗为安全的 #rrggbb；无效值回退 auto',
  cleanedGlassColors.input.color === '#ff00aa' &&
    cleanedGlassColors.bubble.color === '#ff0817' &&
    cleanedGlassColors.assistant.color === 'auto' && cleanedGlassColors.menu.color === 'auto')
const assistantSaved = sanitizeConfig({ glass: { assistant: { enabled: true, opacity: 0.36, blur: 28, saturation: 2 } } })
check('C3) AI 回复的独立参数能保存且废弃的 saturation 不会回流',
  assistantSaved.glass.assistant.enabled === true &&
    assistantSaved.glass.assistant.opacity === 0.36 &&
    assistantSaved.glass.assistant.blur === 28 &&
    !Object.hasOwn(assistantSaved.glass.assistant, 'saturation'))
check('C3) 旧配置没有 AI 回复键时自动补充默认开关和中立参数',
  JSON.stringify(sanitizeConfig({ glass: { bubble: { enabled: false, opacity: 0.3, blur: 10 } } }).glass.assistant) ===
    JSON.stringify(c3Defaults.glass.assistant))

/* ── 1) 退役键与未知键全部剔除 ─────────────────────────────────── */

const c3Retired = {
  ...c3Defaults,
  perf: { level: 'high' },
  scope: 'app',
  unknownRoot: { keep: false },
  wallpaper: {
    ...c3Defaults.wallpaper,
    hidden: ['D:\\私有\\secret.jpg'],
    rotate: 'daily',
    unknownWallpaper: true,
  },
  glass: {
    ...c3Defaults.glass,
    sidebar: { enabled: true, opacity: 0.2, blur: 12 },
    topbar: { enabled: true, opacity: 0.3, blur: 14 },
    chat: { enabled: true, opacity: 0.4, blur: 16, saturation: 2 },
    panel: { enabled: true, opacity: 0.5, blur: 18 },
    bars: { ...c3Defaults.glass.bars, saturation: 2.4, unknownRegion: 1 },
    input: { ...c3Defaults.glass.input, saturation: 1.1 },
    unknownGlass: {},
  },
  accent: { ...c3Defaults.accent, unknownAccent: 'x' },
}
const c3Clean = sanitizeConfig(c3Retired)

check(
  'C3-1) 退役顶层键 perf / scope 与未知顶层键被剔除',
  !Object.hasOwn(c3Clean, 'perf') && !Object.hasOwn(c3Clean, 'scope') && !Object.hasOwn(c3Clean, 'unknownRoot'),
  Object.keys(c3Clean).join(','),
)
check(
  'C3-1) wallpaper.hidden / rotate 与未知 wallpaper 键被剔除',
  !Object.hasOwn(c3Clean.wallpaper, 'hidden') &&
    !Object.hasOwn(c3Clean.wallpaper, 'rotate') &&
    !Object.hasOwn(c3Clean.wallpaper, 'unknownWallpaper'),
  Object.keys(c3Clean.wallpaper).join(','),
)
const c3BadGlassRegions = ['sidebar', 'topbar', 'chat', 'panel', 'unknownGlass'].filter((key) => Object.hasOwn(c3Clean.glass, key))
check(
  'C3-1) glass 旧分区 sidebar / topbar / chat / panel 与未知分区被剔除',
  c3BadGlassRegions.length === 0,
  c3BadGlassRegions.join(',') || 'none',
)
const c3Saturations = ['bars', 'input', 'bubble', 'assistant', 'menu'].filter((key) => Object.hasOwn(c3Clean.glass[key], 'saturation'))
check(
  'C3-1) 每个 glass 分区的 saturation 被剔除，未知分区键也不留',
  c3Saturations.length === 0 &&
    !Object.hasOwn(c3Clean.glass.bars, 'unknownRegion') &&
    !Object.hasOwn(c3Clean.accent, 'unknownAccent'),
  `saturation=${c3Saturations.join(',') || 'none'}`,
)
check(
  'C3-1) 清洗结果只保留默认配置里的 glass 键',
  Object.keys(c3Clean.glass).join(',') === 'bars,input,bubble,assistant,menu,border,highlight',
  Object.keys(c3Clean.glass).join(','),
)

/* ── 2) 类型与范围：非法值回退默认，合法值夹紧 ──────────────────── */

const c3Wild = sanitizeConfig({
  ...c3Defaults,
  enabled: 'yes',
  version: 'not-a-number',
  wallpaper: {
    ...c3Defaults.wallpaper,
    blur: 'x',
    brightness: 999,
    folders: ['a', '', 3, 'a'],
    urls: ['https://a.example/a.jpg', 'https://a.example/a.jpg', null],
    fit: 'weird',
    dim: -5,
    noise: 9,
  },
  glass: {
    ...c3Defaults.glass,
    input: { ...c3Defaults.glass.input, opacity: NaN },
    border: 5,
    highlight: -1,
  },
  accent: { ...c3Defaults.accent, rgb: [999, -1, 'x'] },
})

check(
  'C3-2) blur:"x" 回退 0、brightness:999 夹到 2',
  c3Wild.wallpaper.blur === 0 && c3Wild.wallpaper.brightness === 2,
  `blur=${c3Wild.wallpaper.blur} brightness=${c3Wild.wallpaper.brightness}`,
)
check(
  'C3-2) folders 去空 / 去重 / 丢弃非字符串',
  JSON.stringify(c3Wild.wallpaper.folders) === JSON.stringify(['a']),
  JSON.stringify(c3Wild.wallpaper.folders),
)
check(
  'C3-2) urls 同样去重并丢弃非字符串',
  JSON.stringify(c3Wild.wallpaper.urls) === JSON.stringify(['https://a.example/a.jpg']),
  JSON.stringify(c3Wild.wallpaper.urls),
)
check(
  'C3-2) fit:"weird" 回退 cover',
  c3Wild.wallpaper.fit === 'cover',
  String(c3Wild.wallpaper.fit),
)
check(
  'C3-2) glass.input.opacity=NaN 回退默认 1（不会写成 NaN）',
  c3Wild.glass.input.opacity === 1,
  String(c3Wild.glass.input.opacity),
)
check(
  'C3-2) rgb:[999,-1,"x"] 回退为 3 个 0–255 整数',
  Array.isArray(c3Wild.accent.rgb) &&
    c3Wild.accent.rgb.length === 3 &&
    c3Wild.accent.rgb.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255),
  JSON.stringify(c3Wild.accent.rgb),
)
check(
  'C3-2) dim / noise 夹到范围内，border / highlight 夹到 0–1',
  c3Wild.wallpaper.dim === 0 &&
    c3Wild.wallpaper.noise === 0.2 &&
    c3Wild.glass.border === 1 &&
    c3Wild.glass.highlight === 0,
  `dim=${c3Wild.wallpaper.dim} noise=${c3Wild.wallpaper.noise} border=${c3Wild.glass.border} highlight=${c3Wild.glass.highlight}`,
)
check(
  'C3-2) 非布尔 enabled 回退默认 true、非数字 version 回退默认 2',
  c3Wild.enabled === true && c3Wild.version === c3Defaults.version,
  `enabled=${c3Wild.enabled} version=${c3Wild.version}`,
)

/* ── 3) load() 拿到宿主配置后走 sanitizeConfig ───────────────────── */

const c3DirtyHost = {
  version: 'x',
  enabled: 'yes',
  perf: { level: 'high' },
  scope: 'app',
  accent: { enabled: 'yes', rgb: [999, -1, 'x'], preset: 42, junk: 1 },
  wallpaper: {
    source: 'weird',
    folders: ['D:\\壁纸', '', 3, 'D:\\壁纸'],
    urls: 'nope',
    hidden: ['x'],
    rotate: 'daily',
    fit: 'weird',
    position: 'nowhere',
    blur: 'x',
    brightness: 999,
    dim: -1,
    noise: 9,
    unknown: 1,
  },
  glass: {
    sidebar: { enabled: true, opacity: 0.2, blur: 10 },
    chat: { enabled: true, opacity: 0.2, blur: 10 },
    bars: { enabled: 'yes', opacity: NaN, blur: 999, saturation: 2 },
    input: { enabled: false, opacity: 0.42, blur: 12 },
    border: 5,
    highlight: -1,
    junk: {},
  },
  unknownTop: 1,
}

setFetchHandler((request) => {
  if (request.url.includes('/theme-studio/api/config')) return c3Json({ ok: true, config: c3DirtyHost })
  return c3Json({ ok: true, groups: [] })
})
const c3Loaded = new client.ThemeRuntime()
await c3Loaded.load()
setFetchHandler(null)

check(
  'C3-3) load() 清洗宿主配置：退役键 / 未知键不进入 runtime.config',
  !Object.hasOwn(c3Loaded.config, 'perf') &&
    !Object.hasOwn(c3Loaded.config, 'scope') &&
    !Object.hasOwn(c3Loaded.config, 'unknownTop') &&
    !Object.hasOwn(c3Loaded.config.wallpaper, 'hidden') &&
    !Object.hasOwn(c3Loaded.config.wallpaper, 'rotate') &&
    !Object.hasOwn(c3Loaded.config.glass, 'sidebar') &&
    !Object.hasOwn(c3Loaded.config.glass, 'chat') &&
    !Object.hasOwn(c3Loaded.config.glass, 'junk'),
  Object.keys(c3Loaded.config).join(','),
)
check(
  'C3-3) load() 清洗垃圾值：source / fit / position / folders / urls',
  c3Loaded.config.wallpaper.source === 'none' &&
    c3Loaded.config.wallpaper.fit === 'cover' &&
    c3Loaded.config.wallpaper.position === 'center' &&
    JSON.stringify(c3Loaded.config.wallpaper.folders) === JSON.stringify(['D:\\壁纸']) &&
    Array.isArray(c3Loaded.config.wallpaper.urls) &&
    c3Loaded.config.wallpaper.urls.length === 0,
  JSON.stringify(c3Loaded.config.wallpaper),
)
check(
  'C3-3) load() 清洗数值：blur / brightness / dim / noise / border / highlight',
  c3Loaded.config.wallpaper.blur === 0 &&
    c3Loaded.config.wallpaper.brightness === 2 &&
    c3Loaded.config.wallpaper.dim === 0 &&
    c3Loaded.config.wallpaper.noise === 0.2 &&
    c3Loaded.config.glass.border === 1 &&
    c3Loaded.config.glass.highlight === 0,
  `blur=${c3Loaded.config.wallpaper.blur} brightness=${c3Loaded.config.wallpaper.brightness}`,
)
check(
  'C3-3) load() 清洗 glass 分区：bars 回退 / input 合法值保留 / 无 saturation',
  c3Loaded.config.glass.bars.enabled === true &&
    c3Loaded.config.glass.bars.opacity === 1 &&
    c3Loaded.config.glass.bars.blur === 100 &&
    c3Loaded.config.glass.input.enabled === false &&
    c3Loaded.config.glass.input.opacity === 0.42 &&
    c3Loaded.config.glass.input.blur === 12 &&
    !Object.hasOwn(c3Loaded.config.glass.input, 'saturation'),
  JSON.stringify(c3Loaded.config.glass),
)
check(
  'C3-3) load() 清洗主题色：非布尔 enabled 回退、异常 rgb 回退',
  c3Loaded.config.accent.enabled === false &&
    JSON.stringify(c3Loaded.config.accent.rgb) === JSON.stringify([65, 118, 230]) &&
    c3Loaded.config.accent.preset === 'deepseek',
  JSON.stringify(c3Loaded.config.accent),
)

/* ── 4) putConfig 成功后必须 apply（不能只改内存） ───────────────── */

const c3ServerConfig = { ...c3Defaults, enabled: false }
setFetchHandler((request) => {
  if (request.method === 'PUT' && request.url.includes('/theme-studio/api/config')) {
    return c3Json({ ok: true, config: c3ServerConfig })
  }
  return c3Json({ ok: true, groups: [] })
})
const c3AfterPut = makeRuntime({
  wallpapers: ['D:\\壁纸\\a.jpg'],
  wallpaper: { fixed: 'D:\\壁纸\\a.jpg', current: 'D:\\壁纸\\a.jpg' },
})
check('C3-4) 前置：putConfig 之前根属性存在', Object.hasOwn(dom.html, 'data-dsh-theme-studio'))
const c3ClearButton = findButton(renderPanel(c3AfterPut, 'wallpaper'), '清空当前壁纸')
resetRequests()
c3ClearButton?.props?.onClick?.()
// 等过 persist 的 350ms 防抖 + 一次 microtask PUT。
await wait(600)
check(
  'C3-4) putConfig 成功后调用了 apply（host 返回 enabled:false → 根属性被移除）',
  !Object.hasOwn(dom.html, 'data-dsh-theme-studio'),
  `attr=${String(dom.html['data-dsh-theme-studio'])}`,
)
check(
  'C3-4) runtime.config 与宿主返回值一致（且已清洗）',
  JSON.stringify(c3AfterPut.config) === JSON.stringify(sanitizeConfig(c3ServerConfig)),
  JSON.stringify(c3AfterPut.config),
)
check('C3-4) 确实只发了一笔 PUT', configPuts().length === 1, `${configPuts().length} 笔`)
setFetchHandler(null)

/* ── 5) localStorage 缓存版本化 ─────────────────────────────────── */

const c3CacheKey = 'dsh-theme-studio:config:1.0'
const c3LegacyKey = 'dsh-theme-studio:config'

// 场景 A：旧键垃圾 + 新键不是 JSON → 启动时删旧键、忽略新键、稍后重写成合法负载。
storage.set(c3LegacyKey, JSON.stringify({ perf: { level: 'high' }, wallpaper: { hidden: ['x'] } }))
storage.set(c3CacheKey, '{ this is not json')
client.apply(c3Context())
const c3BadCacheRuntime = c3Runtime()
check('C3-5) 旧的无版本缓存键在启动时被删除（迁移）', !storage.has(c3LegacyKey))
check(
  'C3-5) 解析失败的缓存被忽略：运行时仍是默认 enabled / 不透明度 1',
  c3BadCacheRuntime.config.enabled === true && c3BadCacheRuntime.config.glass.input.opacity === 1,
  `enabled=${c3BadCacheRuntime.config.enabled} opacity=${c3BadCacheRuntime.config.glass.input.opacity}`,
)
await wait(40)
let c3Payload = null
try {
  c3Payload = JSON.parse(storage.get(c3CacheKey))
} catch {
  c3Payload = null
}
check(
  'C3-5) 新缓存键名为 dsh-theme-studio:config:1.0 且负载带 version:1.0',
  c3Payload !== null && c3Payload.version === '1.0' && typeof c3Payload.config === 'object',
  c3Payload === null ? '无法解析新缓存' : `version=${c3Payload.version}`,
)
check(
  'C3-5) 回写缓存的是清洗后的配置（没有退役键 / 未知键）',
  c3Payload !== null &&
    !Object.hasOwn(c3Payload.config, 'perf') &&
    !Object.hasOwn(c3Payload.config, 'scope') &&
    !Object.hasOwn(c3Payload.config.wallpaper, 'hidden') &&
    !Object.hasOwn(c3Payload.config.glass, 'sidebar'),
  c3Payload === null ? '无负载' : Object.keys(c3Payload.config).join(','),
)

// 场景 B：版本号不匹配 → 忽略并删除，绝不把旧结构当新配置用。
storage.set(c3CacheKey, JSON.stringify({
  version: '0.0',
  config: { ...c3Defaults, enabled: false },
}))
client.apply(c3Context())
const c3MismatchRuntime = c3Runtime()
check(
  'C3-5) 版本不匹配的缓存被忽略（不会把 enabled:false 带进运行时）',
  c3MismatchRuntime.config.enabled === true,
  `enabled=${c3MismatchRuntime.config.enabled}`,
)
await wait(40)

// 场景 C：版本正确但内容脏 → 读取后必须走 sanitizeConfig。
const c3DirtyCache = {
  ...c3Defaults,
  perf: { level: 'high' },
  unknownCache: true,
  wallpaper: {
    ...c3Defaults.wallpaper,
    source: 'folder',
    folders: ['D:\\壁纸', '', 'D:\\壁纸', 7],
    blur: 'x',
  },
  glass: {
    ...c3Defaults.glass,
    sidebar: { enabled: true, opacity: 0.2, blur: 10 },
    input: { ...c3Defaults.glass.input, opacity: 0.3, blur: 10, saturation: 2 },
  },
}
storage.set(c3CacheKey, JSON.stringify({ version: '1.0', config: c3DirtyCache }))
client.apply(c3Context())
const c3CachedRuntime = c3Runtime()
check(
  'C3-5) 带版本的缓存读取后同样走 sanitizeConfig',
  !Object.hasOwn(c3CachedRuntime.config, 'perf') &&
    !Object.hasOwn(c3CachedRuntime.config, 'unknownCache') &&
    !Object.hasOwn(c3CachedRuntime.config.glass, 'sidebar') &&
    !Object.hasOwn(c3CachedRuntime.config.glass.input, 'saturation') &&
    c3CachedRuntime.config.glass.input.opacity === 0.3 &&
    c3CachedRuntime.config.glass.input.blur === 10 &&
    c3CachedRuntime.config.wallpaper.folders.length === 1 &&
    c3CachedRuntime.config.wallpaper.blur === 0,
  JSON.stringify({
    glass: c3CachedRuntime.config.glass.input,
    folders: c3CachedRuntime.config.wallpaper.folders,
    blur: c3CachedRuntime.config.wallpaper.blur,
  }),
)
await wait(40)
const c3Rewritten = JSON.parse(storage.get(c3CacheKey))
check(
  'C3-5) 缓存回写的是清洗后的配置（脏键不会回流）',
  c3Rewritten.version === '1.0' &&
    !Object.hasOwn(c3Rewritten.config, 'perf') &&
    !Object.hasOwn(c3Rewritten.config, 'unknownCache') &&
    !Object.hasOwn(c3Rewritten.config.glass, 'sidebar') &&
    !Object.hasOwn(c3Rewritten.config.glass.input, 'saturation'),
  Object.keys(c3Rewritten.config).join(','),
)

/* ── 6) clearIfActive 读 runtime.config，而不是渲染期快照 ────────── */

const c3Stale = makeRuntime({ wallpapers: ['D:\\壁纸\\a.jpg'] })
check(
  'C3-6) 前置：渲染前 fixed 为空（渲染快照会记住这个旧值）',
  c3Stale.config.wallpaper.fixed === '',
  JSON.stringify(c3Stale.config.wallpaper.fixed),
)

/* 渲染面板时把 gallery 预置成一张候选：gallery 与 folders 的初始值都是 []，
 * 用谓词 + 第 2 次命中精确定位到 gallery（第 1 次是 folders）。 */
setContextValue(c3Stale)
setStateOverride((value) => Array.isArray(value) && value.length === 0, ['D:\\壁纸\\a.jpg'], 2)
let c3StaleTree = null
try {
  const c3Wrapper = registration.component({ t: (key) => key })
  const c3Section = [].concat(c3Wrapper.children ?? []).find((child) => typeof child?.type === 'function')
  c3StaleTree = c3Section.type(c3Section.props)
} finally {
  clearStateOverride()
}
const c3Thumbs = findComponents(c3StaleTree, 'Thumb')
check('C3-6) 渲染出候选缩略图（删除走公开路径）', c3Thumbs.length === 1, `${c3Thumbs.length} 张`)

/* 渲染之后模拟「配置被别的路径更新」：runtime.config 指向新值，
 * 而组件在**渲染时闭包里的** wallpaper（fixed 为空）仍是旧值。
 * 异步删除动作（等宿主响应）正好会遇到这种场景，所以必须读权威值。 */
c3Stale.config = {
  ...c3Stale.config,
  wallpaper: { ...c3Stale.config.wallpaper, fixed: 'D:\\壁纸\\a.jpg', current: 'D:\\壁纸\\a.jpg' },
}
resetRequests()
await c3Thumbs[0]?.props?.onRemove?.()
/* clearIfActive 的**同步**效果是 `patch('wallpaper.fixed', '')`；
 * current 的清空在持久化载荷里（等宿主回写后才进入 runtime.config）。
 * 读渲染期闭包（fixed 仍为空）会整段跳过，所以 fixed 这一条就足以钉住回归点。 */
check(
  'C3-6) 删除当前壁纸时依据 runtime.config 清空 fixed（旧快照会整段跳过）',
  c3Stale.config.wallpaper.fixed === '',
  `fixed=${JSON.stringify(c3Stale.config.wallpaper.fixed)}`,
)
await wait(500)
const c3ClearActivePut = configPuts()[0]
const c3ClearActiveBody = c3ClearActivePut === undefined ? null : JSON.parse(c3ClearActivePut.body)
check(
  'C3-6) 清空动作的持久化载荷同时带上 current:""（避免留下悬空值）',
  c3ClearActiveBody?.wallpaper?.fixed === '' && c3ClearActiveBody?.wallpaper?.current === '',
  JSON.stringify(c3ClearActiveBody?.wallpaper),
)

/* ═══════════════════════════════════════════════════════════════════
 * C4：保存管线的合并语义与卸载安全
 *（audit P3-7「persist 后一笔取消前一笔，静默丢写入」、
 *   audit P3-9「saveTimer 卸载不清理 / 异步回调写已卸载组件」）
 *
 * 这一组与上面所有用例隔开：它会安装假定时器、挂载真正运行 effect 的面板，
 * 结束时恢复 fetch 桩与定时器，不影响前面 80 条对真实定时器的假设。
 * ═══════════════════════════════════════════════════════════════════ */

const c4MergePatch = client.mergePatch
check('C4-1) 前置：mergePatch 已导出（persist 的合并规则可单测）', typeof c4MergePatch === 'function')

/* ── 1) 合并规则（纯函数）───────────────────────────────────────── */

const c4BasePatch = {
  wallpaper: { folders: ['a'], urls: ['u'] },
  glass: { border: 0.3, input: { blur: 10 } },
}
const c4NextPatch = {
  wallpaper: { folders: ['b'] },
  glass: { input: { opacity: 0.4 } },
}
const c4Merged = c4MergePatch(c4BasePatch, c4NextPatch)

check(
  'C4-1) 对象递归合并：两边不同的键都保留',
  c4Merged.glass.border === 0.3 && c4Merged.glass.input.blur === 10 && c4Merged.glass.input.opacity === 0.4,
  JSON.stringify(c4Merged.glass),
)
check(
  'C4-1) 数组整体替换：folders ["a"] → ["b"]，不会拼成 ["a","b"]',
  JSON.stringify(c4Merged.wallpaper.folders) === JSON.stringify(['b']) &&
    JSON.stringify(c4Merged.wallpaper.urls) === JSON.stringify(['u']),
  `folders=${JSON.stringify(c4Merged.wallpaper.folders)} urls=${JSON.stringify(c4Merged.wallpaper.urls)}`,
)
check(
  'C4-1) 类型冲突时新值胜出（对象 → 标量、标量 → 对象）',
  c4MergePatch({ glass: { border: 0.3 } }, { glass: 0.7 }).glass === 0.7 &&
    c4MergePatch({ enabled: false }, { enabled: { nested: true } }).enabled.nested === true,
  'glass 0.3 → 0.7 / enabled false → 对象',
)
check(
  'C4-1) 不同顶层字段（glass + accent）合并后两边都在',
  c4MergePatch({ glass: { border: 0.3 } }, { accent: { rgb: [1, 2, 3] } }).glass.border === 0.3 &&
    JSON.stringify(c4MergePatch({ glass: { border: 0.3 } }, { accent: { rgb: [1, 2, 3] } }).accent.rgb) ===
      JSON.stringify([1, 2, 3]),
  'glass + accent',
)
check(
  'C4-1) mergePatch 不修改入参（排队中的 pendingPatch 不会被就地改写）',
  JSON.stringify(c4BasePatch.wallpaper.folders) === JSON.stringify(['a']) && c4BasePatch.glass.border === 0.3,
  JSON.stringify(c4BasePatch),
)

/* ── 面板挂载 / 假定时器辅助 ────────────────────────────────────── */

/** 渲染并**挂载**面板：effect 会真的跑（默认的直接渲染路径仍然是 no-op）。 */
function c4Mount(runtime, tab = 'wallpaper') {
  return mountPanel(() => {
    const wrapper = registration.component({ t: (key) => key })
    const section = [].concat(wrapper.children ?? []).find((child) => typeof child?.type === 'function')
    return section.type(section.props)
  }, { runtime, tab })
}

/** 与 readJsonResponse 契约一致的响应桩。 */
const c4Json = (body, status = 200) => ({ status, text: async () => JSON.stringify(body) })

/** 跑完当前微任务 + 一个宏任务，让 async fetch 回调落地。 */
const c4Flush = () => new Promise((resolve) => setImmediate(resolve))

/** 连续冲刷：reloadFolders → refreshWallpapers 是两段式请求。 */
async function c4Settle(times = 4) {
  for (let index = 0; index < times; index += 1) await c4Flush()
}

/** 按 label 取 SliderRow 的 onChange（SliderRow 的 onChange 就是面板传入的原函数）。 */
function c4Slider(tree, label) {
  const row = findComponents(tree, 'SliderRow').find((node) => node.props?.label === label)
  return row?.props?.onChange
}

/* fetch 桩：
 *   · /folders 默认立即成功；测试 5 会把 c4FoldersGate 换成手动 resolve 的 promise；
 *   · PUT /config 回 { ok: true }（不带 config），避免宿主回写覆盖被测运行时。 */
let c4FoldersGate = null
setFetchHandler((request) => {
  if (request.url.includes('/theme-studio/api/folders')) {
    if (c4FoldersGate !== null) {
      const gate = c4FoldersGate
      c4FoldersGate = null
      return gate
    }
    return c4Json({ ok: true, groups: [] })
  }
  if (request.method === 'PUT' && request.url.includes('/theme-studio/api/config')) {
    return c4Json({ ok: true })
  }
  return c4Json({ ok: true, groups: [] })
})

/* ── 2) 同一窗口内不同字段：只发一笔 PUT，body 同时包含两边 ──────── */

const c4SaveTarget = makeRuntime({
  wallpapers: ['D:\\壁纸\\a.jpg', 'D:\\壁纸\\b.jpg'],
  wallpaper: { fixed: 'D:\\壁纸\\a.jpg', current: 'D:\\壁纸\\a.jpg' },
})
const c4Timers = installFakeTimers()
const c4DebugLogs = []
const c4OriginalDebug = console.debug
let c4Panel = null
try {
  c4Panel = c4Mount(c4SaveTarget, 'wallpaper')
  await c4Settle(3)
  resetRequests()

  // ① 总开关（顶层标量 enabled）；② / ③ 两个 wallpaper 子字段（嵌套对象）。
  const c4TotalSwitch = findComponents(c4Panel.tree, 'Switch')[0]
  c4TotalSwitch?.props?.onChange?.(false)
  c4Slider(c4Panel.tree, '遮罩暗化')?.(0.31)
  c4Slider(c4Panel.tree, '噪点')?.(0.07)

  check('C4-2) 连续三笔 persist 只排一个定时器', c4Timers.pending() === 1, `${c4Timers.pending()} 个`)
  c4Timers.advance(349)
  check('C4-2) 未满 350ms 不发 PUT（防抖仍然生效）', configPuts().length === 0, `${configPuts().length} 笔`)

  console.debug = (...args) => c4DebugLogs.push(args.map((item) => String(item)).join(' '))
  c4Timers.advance(1)
  await c4Settle(2)

  const c4Puts = configPuts()
  check('C4-2) 同一窗口内三笔 persist 合并成一笔 PUT', c4Puts.length === 1, `${c4Puts.length} 笔`)
  const c4Body = c4Puts.length === 1 ? JSON.parse(c4Puts[0].body) : null
  check(
    'C4-2) 合并载荷同时含 enabled / wallpaper.dim / wallpaper.noise（没有一笔被取消）',
    c4Body?.enabled === false && c4Body?.wallpaper?.dim === 0.31 && c4Body?.wallpaper?.noise === 0.07,
    JSON.stringify(c4Body),
  )
  check(
    'C4-2) 只打一条「合并了 3 笔」日志（不每帧刷屏）',
    c4DebugLogs.filter((line) => line.includes('合并了 3 笔')).length === 1,
    JSON.stringify(c4DebugLogs),
  )
} finally {
  console.debug = c4OriginalDebug
  c4Panel?.unmount()
  c4Timers.restore()
}

/* ── 3) 同一字段连续两笔：后值胜出 ──────────────────────────────── */

const c4LaterTarget = makeRuntime({ wallpapers: ['D:\\壁纸\\a.jpg'] })
const c4Timers2 = installFakeTimers()
let c4Panel2 = null
try {
  c4Panel2 = c4Mount(c4LaterTarget, 'wallpaper')
  await c4Settle(3)
  resetRequests()
  const c4SetDim = c4Slider(c4Panel2.tree, '遮罩暗化')
  c4SetDim?.(0.2)
  c4SetDim?.(0.55)
  c4Timers2.advance(360)
  await c4Settle(2)
  const c4LaterPuts = configPuts()
  check(
    'C4-3) 同一字段连续两笔：后值胜出（0.2 → 0.55）',
    c4LaterPuts.length === 1 && JSON.parse(c4LaterPuts[0].body)?.wallpaper?.dim === 0.55,
    c4LaterPuts.length === 1 ? c4LaterPuts[0].body : `${c4LaterPuts.length} 笔`,
  )
} finally {
  c4Panel2?.unmount()
  c4Timers2.restore()
}

/* ── 4) 卸载后推进定时器：不再发 PUT ────────────────────────────── */

const c4UnmountTarget = makeRuntime({
  wallpapers: ['D:\\壁纸\\a.jpg'],
  wallpaper: { fixed: 'D:\\壁纸\\a.jpg', current: 'D:\\壁纸\\a.jpg' },
})
const c4Timers3 = installFakeTimers()
let c4Panel3 = null
const c4PreviewListeners = new Map()
const c4DocumentListeners = new Map()
const c4Frames = new Map()
const c4OriginalAdd = window.addEventListener
const c4OriginalRemove = window.removeEventListener
const c4OriginalDocumentAdd = document.addEventListener
const c4OriginalDocumentRemove = document.removeEventListener
const c4OriginalFrame = window.requestAnimationFrame
const c4OriginalCancelFrame = window.cancelAnimationFrame
let c4FrameId = 0
try {
  window.addEventListener = (name, handler) => c4PreviewListeners.set(name, handler)
  window.removeEventListener = (name, handler) => {
    if (c4PreviewListeners.get(name) === handler) c4PreviewListeners.delete(name)
  }
  document.addEventListener = (name, handler, capture) => c4DocumentListeners.set(name, { handler, capture })
  document.removeEventListener = (name, handler) => {
    if (c4DocumentListeners.get(name)?.handler === handler) c4DocumentListeners.delete(name)
  }
  window.requestAnimationFrame = (callback) => {
    c4FrameId += 1
    c4Frames.set(c4FrameId, callback)
    return c4FrameId
  }
  window.cancelAnimationFrame = (id) => c4Frames.delete(id)
  c4Panel3 = c4Mount(c4UnmountTarget, 'wallpaper')
  check('C4-4) 面板挂载时注册原生 document 捕获监听',
    c4DocumentListeners.get('pointerdown')?.capture === true)
  await c4Settle(3)
  resetRequests()
  findButton(c4Panel3.tree, '清空当前壁纸')?.props?.onClick?.()
  check('C4-4) 前置：卸载前确实排了一笔待写', c4Timers3.pending() === 1, `${c4Timers3.pending()} 个`)
  const c4PageAttrs = new Set()
  const c4CardAttrs = new Set()
  const c4Overlay = {}
  const c4Page = {
    closest: (selector) => selector === '.VOzbGW_overlay' ? c4Overlay : null,
    setAttribute: (name) => c4PageAttrs.add(name),
    removeAttribute: (name) => c4PageAttrs.delete(name),
  }
  const c4Card = {
    closest: (selector) => selector === '.ds-ts-page' ? c4Page : null,
    setAttribute: (name) => c4CardAttrs.add(name),
    removeAttribute: (name) => c4CardAttrs.delete(name),
  }
  const c4SliderNode = { closest: (selector) => {
    if (selector === 'input.ds-ts-slider') return c4SliderNode
    return selector === '.ds-ts-card' ? c4Card : null
  } }
  const c4SliderComponent = findComponents(c4Panel3.tree, 'SliderRow').find((node) => node.props?.label === '遮罩暗化')
  const c4Input = c4SliderComponent && findHost(c4SliderComponent.type(c4SliderComponent.props), 'input')
  const c4PointerDown = c4DocumentListeners.get('pointerdown')?.handler
  c4PointerDown?.({ target: c4SliderNode, button: 2, pointerId: 20 })
  c4PointerDown?.({ target: { closest: () => null }, button: 0, pointerId: 20 })
  check('C4-4) 右键与无关控件不会进入预览', c4PreviewListeners.size === 0 && c4Frames.size === 0)
  c4PointerDown?.({ target: c4SliderNode, button: 0, pointerId: 20 })
  const c4InitialFrame = [...c4Frames.values()][0]
  check('C4-4) 滑条首次原生按下即安排预览，不等待 React 回调',
    c4PreviewListeners.has('pointerup') && c4Frames.size === 1 && c4PageAttrs.size === 0)
  c4Input?.props?.onPointerDown?.({ currentTarget: c4SliderNode, button: 0, pointerId: 20 })
  check('C4-4) React 控件回调不会重复安排预览',
    c4Frames.size === 1 && [...c4Frames.values()][0] === c4InitialFrame)
  c4InitialFrame?.()
  c4Frames.clear()
  check('C4-4) 首次按下的下一帧标记当前整张卡片',
    c4PageAttrs.has('data-ds-ts-preview') && c4CardAttrs.has('data-ds-ts-preview-card'))
  c4PreviewListeners.get('pointerup')?.({ pointerId: 20 })
  check('C4-4) 松手立即恢复，原生首轮入口可供下次拖动复用',
    c4PageAttrs.size === 0 && c4CardAttrs.size === 0 && c4PreviewListeners.size === 0 &&
      c4DocumentListeners.has('pointerdown'))
  const c4SecondCardAttrs = new Set()
  const c4SecondCard = {
    closest: (selector) => selector === '.ds-ts-page' ? c4Page : null,
    setAttribute: (name) => c4SecondCardAttrs.add(name),
    removeAttribute: (name) => c4SecondCardAttrs.delete(name),
  }
  const c4SecondSlider = { closest: (selector) => {
    if (selector === 'input.ds-ts-slider') return c4SecondSlider
    return selector === '.ds-ts-card' ? c4SecondCard : null
  } }
  c4PointerDown?.({ target: c4SecondSlider, button: 0, pointerId: 21 })
  check('C4-4) 另一个滑条首次按下也直接安排其所属卡片的预览',
    c4Frames.size === 1 && c4PreviewListeners.has('pointerup') && c4CardAttrs.size === 0)
  const c4SecondFrame = [...c4Frames.values()][0]
  c4SecondFrame?.()
  c4Frames.clear()
  check('C4-4) 第二个滑条只保留它自己的卡片',
    c4PageAttrs.has('data-ds-ts-preview') && c4SecondCardAttrs.has('data-ds-ts-preview-card') && c4CardAttrs.size === 0)
  c4PreviewListeners.get('pointerup')?.({ pointerId: 21 })
  c4PointerDown?.({ target: c4SecondSlider, button: 0, pointerId: 22 })
  c4Panel3.unmount()
  check('C4-4) 关闭设置时强制恢复遮罩与其它控件并移除事件监听',
    c4PageAttrs.size === 0 && c4CardAttrs.size === 0 && c4SecondCardAttrs.size === 0 && c4PreviewListeners.size === 0 &&
      c4DocumentListeners.size === 0 && c4Frames.size === 0)
  check('C4-4) 卸载 cleanup 清掉了 saveTimer', c4Timers3.pending() === 0, `${c4Timers3.pending()} 个`)
  c4Timers3.advance(2000)
  await c4Settle(2)
  check(
    'C4-4) 卸载后推进定时器不再发 PUT（关面板不写盘）',
    configPuts().length === 0,
    `${configPuts().length} 笔`,
  )
} finally {
  c4Panel3?.unmount()
  window.addEventListener = c4OriginalAdd
  window.removeEventListener = c4OriginalRemove
  document.addEventListener = c4OriginalDocumentAdd
  document.removeEventListener = c4OriginalDocumentRemove
  window.requestAnimationFrame = c4OriginalFrame
  window.cancelAnimationFrame = c4OriginalCancelFrame
  c4Timers3.restore()
}

/* ── 5) 卸载后到达的 fetch 响应：不再 setState ──────────────────── */

const c4LateTarget = makeRuntime({ wallpapers: ['D:\\壁纸\\a.jpg'] })
const c4Timers4 = installFakeTimers()
let c4Panel4 = null
try {
  c4Panel4 = c4Mount(c4LateTarget, 'wallpaper')
  await c4Settle(3)
  resetRequests()
  let c4ResolveFolders = null
  c4FoldersGate = new Promise((resolve) => {
    c4ResolveFolders = resolve
  })
  /* 「重新扫描」按钮在 Card 的 `right` 属性里，不在 children 中；
   * walkElements 只走 children，所以先从「壁纸候选」这张 Card 里取出 right 子树。 */
  const c4CandidateCard = findComponents(c4Panel4.tree, 'Card')
    .find((node) => node.props?.title === '壁纸候选')
  const c4Rescan = findButton(c4CandidateCard?.props?.right, '重新扫描')
  check('C4-5) 找到「重新扫描」按钮（卸载时有一个在途请求）', c4Rescan !== null)
  c4Rescan?.props?.onClick?.()
  await c4Flush()
  c4Panel4.unmount()
  const c4StateBefore = c4Panel4.setStateCalls
  c4ResolveFolders(c4Json({ ok: true, groups: [{ items: [{ path: 'D:\\壁纸\\late.jpg' }] }] }))
  await c4Settle(5)
  check(
    'C4-5) 卸载后到达的 fetch 响应不再 setState（计数不增长）',
    c4Panel4.setStateCalls === c4StateBefore,
    `卸载时 ${c4StateBefore} 次 → 响应后 ${c4Panel4.setStateCalls} 次`,
  )
  check(
    'C4-5) 前置：那次响应确实回来了（/folders 请求已发出）',
    requests.some((request) => request.url.includes('/theme-studio/api/folders')),
    `${requests.length} 个请求`,
  )
} finally {
  c4Panel4?.unmount()
  c4FoldersGate = null
  c4Timers4.restore()
}

// 收尾：恢复默认 fetch 桩与 context，避免后续（若有）用例受这组影响。
setFetchHandler(null)
setContextValue(undefined)

/* ═══════════════════════════════════════════════════════════════════
 * C6：i18n 接线
 *（audit P3-3「i18n 是装饰性的」、audit P1-17「tr 的第二个参数全丢」）
 *
 * 这一组只守「机制是真的」这件事：
 *   · 导航标签必须经 ctx.locale.bind() 读字典，切语言必须真的变；
 *   · 面板正文明确只维护中文，常量里不再留装饰性的 `en`；
 *   · 源码里不再出现双参数 tr(...)（第二参数没有读取点）；
 *   · 面板正文仍然显示中文 —— 删英文参数不能把界面改成英文。
 * 不为面板正文新造英文翻译（那是另一个工程）。
 * ═══════════════════════════════════════════════════════════════════ */

/* ── 1) apply(ctx)：导航标签真的走 locale 字典 ──────────────────── */

const c6Locale = createLocaleStub('zh')
const c6Registrations = []
client.apply({
  effect: (fn) => {
    fn()
    return () => {}
  },
  locale: c6Locale,
  slots: {
    inject: (name, fn) => {
      fn()
      return () => {}
    },
    register: (options, component) => {
      c6Registrations.push({ options, component })
      return () => {}
    },
  },
})

const c6Section = c6Registrations.find((item) => item.options?.id === 'theme-studio')
check('C6-1) 前置：apply 注册了 theme-studio 设置分区', c6Section !== undefined)

const c6ZhLabel = c6Section?.options?.label?.()
c6Locale.setActive('en')
const c6EnLabel = c6Section?.options?.label?.()

check(
  'C6-1) zh 下导航标签来自字典：主题工作室',
  c6ZhLabel === '主题工作室',
  String(c6ZhLabel),
)
check(
  'C6-1) en 下导航标签来自字典：Theme Studio',
  c6EnLabel === 'Theme Studio',
  String(c6EnLabel),
)
check(
  'C6-1) label 确实经 ctx.locale.bind("theme-studio") 读取（不是硬编码）',
  c6Locale.boundNamespaces.includes('theme-studio') && c6ZhLabel !== c6EnLabel,
  `bound=${c6Locale.boundNamespaces.join(',')} zh=${c6ZhLabel} en=${c6EnLabel}`,
)

const c6Dictionary = c6Locale.dictionary('theme-studio')
const c6Languages = c6Locale.languages('theme-studio')
check(
  'C6-1) locale 字典注册了 zh / en 两份 nav',
  c6Languages.includes('zh') &&
    c6Languages.includes('en') &&
    c6Dictionary?.zh?.nav === '主题工作室' &&
    c6Dictionary?.en?.nav === 'Theme Studio',
  `${JSON.stringify(c6Languages)} ${JSON.stringify(c6Dictionary)}`,
)

/* ── 2) 装饰性常量已删除：REGIONS / ACCENT_PRESETS 不再有 en ─────── */

const c6Regions = client.REGIONS ?? []
check(
  'C6-2) REGIONS 每项都没有只写不读的 en 字段',
  c6Regions.length > 0 && c6Regions.every((region) => !Object.hasOwn(region, 'en')),
  c6Regions.map((region) => Object.keys(region).join('+')).join(' | '),
)

const c6Presets = client.ACCENT_PRESETS
check(
  'C6-2) ACCENT_PRESETS 已导出且每项都没有 en 字段',
  Array.isArray(c6Presets) &&
    c6Presets.length > 0 &&
    c6Presets.every((preset) => !Object.hasOwn(preset, 'en')),
  Array.isArray(c6Presets) ? c6Presets.map((preset) => Object.keys(preset).join('+')).join(' | ') : String(c6Presets),
)

/* ── 3) 静态：lib/client.js 里不存在双参数 tr(...) 调用 ────────────── */

/**
 * 把注释、字符串与模板字面量的**文本部分**替换成空格（保留换行）。
 *
 * 只服务于下面的扫描：不能让注释里「解释为什么删掉 tr(zh, en)」的文字
 * 或字符串里的样本文案被当成真调用。两处容易写错、这里特意处理：
 *   · 模板字面量里的 `${...}` 是**代码**，必须保留 —— 面板文案就常写成
 *     `` `${tr('地址')}：…` ``，把整段模板都屏蔽掉会漏掉真实调用；
 *   · 正则字面量里可能出现引号（`lib/client.js` 里就有 `/"/g`），
 *     不按正则跳过会被误当作字符串起点、把后面的代码一起吃掉。
 * @param source - 源码。
 * @returns 等长、但注释/字符串/模板文本已变空格的文本。
 */
function c6MaskCommentsAndStrings(source) {
  const chars = source.split('')
  /** 把 [start, end) 区间里的非换行字符替换成空格。 */
  const blank = (start, end) => {
    for (let index = start; index < end; index += 1) {
      if (chars[index] !== '\n' && chars[index] !== '\r') chars[index] = ' '
    }
  }
  /** 用前一个有效字符粗略判断「这里的 / 是正则还是除号」。 */
  const regexAllowed = (previous) => previous === '' || '([{,;:=!&|?+-*%^~<>'.includes(previous)
  /* 模板嵌套栈：'template' 表示模板文本，'expression' 表示 ${...} 里的代码
   * （depth 记录该表达式内部的花括号层数）。 */
  const stack = []
  let previous = ''
  let index = 0
  while (index < source.length) {
    const top = stack[stack.length - 1]
    const char = source[index]
    const next = source[index + 1]

    /* 模板文本：屏蔽到 ` 或 ${ 为止；${ 之后切回代码模式。 */
    if (top?.kind === 'template') {
      if (char === '\\') {
        blank(index, index + 2)
        index += 2
        continue
      }
      if (char === '`') {
        blank(index, index + 1)
        stack.pop()
        previous = '`'
        index += 1
        continue
      }
      if (char === '$' && next === '{') {
        blank(index, index + 2)
        stack.push({ kind: 'expression', depth: 0 })
        previous = '{'
        index += 2
        continue
      }
      blank(index, index + 1)
      index += 1
      continue
    }

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index + 2)
      const stop = end === -1 ? source.length : end
      blank(index, stop)
      index = stop
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end === -1 ? source.length : end + 2
      blank(index, stop)
      index = stop
      continue
    }

    /* 普通字符串不能跨行；万一扫描器被正则里的引号骗到，也只会吃到行尾。 */
    if (char === '"' || char === "'") {
      let cursor = index + 1
      while (cursor < source.length && source[cursor] !== '\n') {
        if (source[cursor] === '\\') {
          cursor += 2
          continue
        }
        if (source[cursor] === char) {
          cursor += 1
          break
        }
        cursor += 1
      }
      blank(index, cursor)
      previous = char
      index = cursor
      continue
    }

    if (char === '`') {
      blank(index, index + 1)
      stack.push({ kind: 'template' })
      index += 1
      continue
    }

    if (char === '/' && regexAllowed(previous)) {
      let cursor = index + 1
      let inClass = false
      let closed = false
      while (cursor < source.length && source[cursor] !== '\n') {
        const current = source[cursor]
        if (current === '\\') {
          cursor += 2
          continue
        }
        if (current === '[') inClass = true
        else if (current === ']') inClass = false
        else if (current === '/' && !inClass) {
          closed = true
          cursor += 1
          break
        }
        cursor += 1
      }
      /* 同一行内没闭合就按除号处理，避免把后面的代码整段吃掉。 */
      if (closed) {
        blank(index, cursor)
        previous = '/'
        index = cursor
        continue
      }
    }

    /* ${...} 里遇到未配对的 } 就是插值结束，回到模板文本模式。 */
    if (top?.kind === 'expression') {
      if (char === '{') top.depth += 1
      else if (char === '}') {
        if (top.depth === 0) {
          blank(index, index + 1)
          stack.pop()
          previous = '}'
          index += 1
          continue
        }
        top.depth -= 1
      }
    }

    if (!/\s/.test(char)) previous = char
    index += 1
  }
  return chars.join('')
}

/**
 * 找出所有 tr(...) 调用，并标出参数列表「最外层是否带逗号」。
 *
 * 为什么不用正则：`tr('包含, 逗号的中文')` 的逗号在字符串里、
 * `tr(fn(a, b))` 的逗号在嵌套调用里、`tr({ a: 1, b: 2 })` 的逗号在对象里 ——
 * 正则无法可靠区分；而中文文案本来就可能出现逗号。这里先屏蔽注释/字符串，
 * 再用括号配平扫描参数列表。
 * @param source - 源码。
 * @returns `[{ line, hasComma }]`。
 */
function c6TrCallLines(source) {
  const masked = c6MaskCommentsAndStrings(source)
  const calls = []
  const pattern = /\btr\s*\(/g
  let match
  while ((match = pattern.exec(masked)) !== null) {
    const open = match.index + match[0].length - 1
    let depth = 0
    let hasComma = false
    for (let index = open; index < masked.length; index += 1) {
      const char = masked[index]
      if (char === '(' || char === '[' || char === '{') depth += 1
      else if (char === ')' || char === ']' || char === '}') {
        depth -= 1
        if (depth === 0) break
      } else if (char === ',' && depth === 1) hasComma = true
    }
    calls.push({ line: masked.slice(0, match.index).split('\n').length, hasComma })
  }
  return calls
}

/**
 * 双参数 tr(...) 调用的起始行号（空数组 = 全部单参数）。
 * @param source - 源码。
 * @returns 行号数组。
 */
function c6TwoArgTrLines(source) {
  return c6TrCallLines(source)
    .filter((call) => call.hasComma)
    .map((call) => call.line)
}

/* 先验证扫描器本身：它必须能分清单参/双参/嵌套逗号/字符串/注释。
 * 没有这一步，扫描器写错时会「恒返回空数组」，让真实源码的断言假通过。 */
const c6ScannerFixtures = [
  { source: "tr('单参')", expected: [] },
  { source: "tr('中文', 'English')", expected: [1] },
  { source: "tr(fn('a', 'b'))", expected: [] },
  { source: "tr({ a: 1, b: 2 })", expected: [] },
  { source: "tr(',')", expected: [] },
  { source: "// tr('中文', 'English')", expected: [] },
  { source: "/* tr('中文', 'English') */", expected: [] },
  { source: 'const text = "tr(\'中文\', \'English\')"', expected: [] },
  { source: "tr(\n  '中文',\n  'English',\n)", expected: [1] },
  /* 模板：文本部分不屏蔽，但 ${...} 里的代码必须照常扫描。 */
  { source: "const text = `前缀 tr('中文', 'English') 后缀`", expected: [] },
  { source: "const text = `${tr('中文', 'English')}`", expected: [1] },
  { source: 'const text = `${fn(tr(\'中文\', \'English\'))}`', expected: [1] },
  /* 正则里的引号不能把同一行后面的真实调用吃掉。 */
  { source: 'const re = /"/; tr(\'中文\', \'English\')', expected: [1] },
]
const c6ScannerFailures = c6ScannerFixtures.filter((fixture) => {
  const actual = c6TwoArgTrLines(fixture.source)
  return JSON.stringify(actual) !== JSON.stringify(fixture.expected)
})
check(
  'C6-3) 扫描器自检：单参/双参/嵌套逗号/字符串/注释/模板插值/正则都能区分',
  c6ScannerFailures.length === 0,
  c6ScannerFailures.map((fixture) => `${JSON.stringify(fixture.source)} → ${JSON.stringify(c6TwoArgTrLines(fixture.source))}`).join(' ; ') || 'ok',
)

const c6ClientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const c6TwoArgCalls = c6TwoArgTrLines(c6ClientSource)
check(
  'C6-3) lib/client.js 里没有双参数 tr(...) 调用（第二参数已无读取点）',
  c6TwoArgCalls.length === 0,
  c6TwoArgCalls.length === 0 ? '0 处' : `行 ${c6TwoArgCalls.join(', ')}`,
)

/* 再验证扫描器在**真实源码**上没把代码整段吃掉：挑三个位置不同的调用，
 * 其中一个是模板插值里的（`${tr('地址')}`），一个在正则字面量之后（`tr('色值')`）。
 * 没有这条，屏蔽逻辑写坏时上面那条「0 处」仍会假通过。 */
const c6LineOf = (needle) => {
  const at = c6ClientSource.indexOf(needle)
  return at === -1 ? -1 : c6ClientSource.slice(0, at).split('\n').length
}
const c6AllCallLines = c6TrCallLines(c6ClientSource).map((call) => call.line)
const c6ProbeLines = [
  c6LineOf("tr('清空当前壁纸')"),
  c6LineOf("tr('地址')"),
  c6LineOf("tr('色值')"),
]
check(
  'C6-3) 扫描器在真实源码上覆盖普通调用 / 模板插值 / 正则之后的调用',
  c6ProbeLines.every((line) => line > 0 && c6AllCallLines.includes(line)),
  `期望行 ${c6ProbeLines.join(',')}，实际找到 ${c6AllCallLines.length} 处 tr 调用`,
)

/* ── 4) 面板正文仍然是中文（删英文参数不等于改成英文） ───────────── */

/** 收集元素树里的文本节点（只走 children，不展开函数组件）。 */
function c6CollectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const item of node) c6CollectText(item, out)
    return out
  }
  if (typeof node !== 'object') return out
  for (const child of [].concat(node.children ?? [])) c6CollectText(child, out)
  return out
}

const c6Runtime = new ThemeRuntime()
c6Runtime.config = defaultConfig()
const c6GlassTree = renderPanel(c6Runtime, 'glass')
const c6PanelText = c6CollectText(c6GlassTree)
check(
  'C6-4) 面板标题仍是中文「主题工作室」',
  c6PanelText.includes('主题工作室'),
  c6PanelText.slice(0, 8).join(' | '),
)

const c6CardTitles = findComponents(c6GlassTree, 'Card').map((node) => node.props?.title)
check(
  'C6-4) 毛玻璃分区名仍是中文（边栏 / 输入框）',
  c6CardTitles.includes('边栏') && c6CardTitles.includes('输入框'),
  c6CardTitles.filter(Boolean).join(' | '),
)

/* ═══════════════════════════════════════════════════════════════════
 * C8：面板可访问性语义（audit P3-8）
 *
 * 为什么必须遍历元素树、而不是 grep 源码里有没有 `aria-labelledby`：
 *   写没写是一回事，**它指到的那个 id 是不是本行的名称文本**是另一回事。
 *   只有真的展开组件、按 id 找回节点、再比对文本，「标签关联」才算被证明；
 *   tab / tabpanel 的双向指向、status 的 live region 同理。
 *
 * 本节新增三个小工具：
 *   · c8Hosts：只在树里找**宿主**节点（函数组件不展开，需要时由调用方自己展开）；
 *   · c8ById / c8Text：把 aria-labelledby / aria-controls 解析成真实节点并取文本；
 *   · createHookRenderer：让 useState 真的保存状态，才能验证「点击后翻转」。
 * ═══════════════════════════════════════════════════════════════════ */

/** 收集（展开后的）树里满足条件的宿主节点。 */
function c8Hosts(tree, predicate) {
  const found = []
  walkElements(tree, (node) => {
    if (typeof node.type === 'string' && predicate(node)) found.push(node)
  })
  return found
}

/** 拼接节点下的全部文本（只走 children，与 React 的文本内容语义一致）。 */
function c8Text(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(c8Text).join('')
  if (typeof node !== 'object') return ''
  return [].concat(node.children ?? []).map(c8Text).join('')
}

/** 按 props.id 找宿主节点（再交给调用方断言「恰好一个」）。 */
function c8ById(tree, id) {
  if (typeof id !== 'string' || id === '') return []
  return c8Hosts(tree, (node) => node.props?.id === id)
}

/** 面板源码：用于验证 tabpanel 的包裹方式确实没有引入布局盒子。 */
const c8ClientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/* ── 1) SliderRow / SelectRow / SwitchRow 的名称关联 ──────────────── */

const c8Runtime = new ThemeRuntime()
c8Runtime.config = defaultConfig()
const c8WallpaperTree = renderPanel(c8Runtime, 'wallpaper')
const c8GlassTree = renderPanel(c8Runtime, 'glass')

/* 「不透明度」「模糊」在毛玻璃页每个分区各一行，「壁纸模糊」在壁纸页 —— 正好三种来源。 */
const c8SliderRows = [
  ...findComponents(c8WallpaperTree, 'SliderRow'),
  ...findComponents(c8GlassTree, 'SliderRow'),
]
const c8SliderFailures = []
const c8SliderValueFailures = []
const c8SliderHiddenFailures = []
const c8SliderIds = []
const c8SpokenSamples = []
for (const row of c8SliderRows) {
  // 函数组件是惰性的：展开它才拿得到真正的 label / input 宿主节点。
  const rowTree = row.type(row.props)
  const input = c8Hosts(rowTree, (node) => node.type === 'input' && node.props?.type === 'range')[0]
  const labelledBy = input?.props?.['aria-labelledby']
  const labelNodes = c8ById(rowTree, labelledBy)
  // 关键：id 必须解析到**恰好一个**节点，且该节点的文本就是这一行的 label。
  const labelText = labelNodes.length === 1 ? c8Text(labelNodes[0]) : ''
  if (input === undefined || labelNodes.length !== 1 || labelText !== row.props.label) {
    c8SliderFailures.push(`${row.props.label}: labelledby=${String(labelledBy)} nodes=${labelNodes.length} text=${JSON.stringify(labelText)}`)
  }
  c8SliderIds.push(labelledBy)

  const rounded = typeof row.props.value === 'number' ? Math.round(row.props.value * 100) / 100 : row.props.value
  const expectedSpoken = row.props.unit === undefined ? String(rounded) : `${rounded} ${row.props.unit}`
  const spoken = input?.props?.['aria-valuetext']
  if (spoken !== expectedSpoken) {
    c8SliderValueFailures.push(`${row.props.label}: ${JSON.stringify(spoken)} ≠ ${JSON.stringify(expectedSpoken)}`)
  }
  if (c8SpokenSamples.length < 2) c8SpokenSamples.push(`${row.props.label} → ${JSON.stringify(spoken)}`)

  // 可见的数值文本必须逐字符保持原样（视觉不变），同时不能重复朗读。
  const valueNode = c8Hosts(rowTree, (node) => node.props?.className === 'ds-ts-val')[0]
  const expectedDisplay = `${rounded}${row.props.unit ?? ''}`
  if (valueNode === undefined || valueNode.props?.['aria-hidden'] !== 'true' || c8Text(valueNode) !== expectedDisplay) {
    c8SliderHiddenFailures.push(`${row.props.label}: aria-hidden=${String(valueNode?.props?.['aria-hidden'])} text=${JSON.stringify(c8Text(valueNode))} 期望 ${JSON.stringify(expectedDisplay)}`)
  }
}

check(
  'C8-1) 每个 SliderRow 的名称节点都能被 range 的 aria-labelledby 指到，且文本等于该行 label',
  c8SliderRows.length >= 3 && c8SliderFailures.length === 0,
  c8SliderFailures.slice(0, 3).join(' ; ') || `${c8SliderRows.length} 行全部关联`,
)

const c8SliderLabels = new Set(c8SliderRows.map((row) => row.props.label))
const c8SliderSpotChecks = ['壁纸模糊', '不透明度', '模糊']
check(
  'C8-1) 抽查「壁纸模糊 / 不透明度 / 模糊」三行都在且已正确关联',
  c8SliderSpotChecks.every((label) => c8SliderLabels.has(label)) &&
    c8SliderSpotChecks.every((label) => !c8SliderFailures.some((failure) => failure.startsWith(`${label}:`))),
  c8SliderSpotChecks.map((label) => `${label}:${c8SliderLabels.has(label) ? '在' : '缺失'}`).join(' '),
)

check(
  'C8-1) 每行 label id 互不相同（硬编码同一个 id 会让关联指错行）',
  new Set(c8SliderIds).size === c8SliderRows.length,
  `${new Set(c8SliderIds).size} 个不同 id / ${c8SliderRows.length} 行`,
)

check(
  'C8-2) range 的 aria-valuetext 带单位或数值，且与可见值一致（如 "N px" / "N"）',
  c8SliderValueFailures.length === 0,
  c8SliderValueFailures.slice(0, 3).join(' ; ') || c8SpokenSamples.join(' | '),
)

check(
  'C8-2) 数值显示仍是原文案（视觉不变），并对读屏 aria-hidden（避免重复朗读）',
  c8SliderHiddenFailures.length === 0,
  c8SliderHiddenFailures.slice(0, 3).join(' ; ') || '全部一致',
)

/* SelectRow：select 是原生控件，只需要名称关联；选项数量顺带守一下，避免改坏。 */
const c8SelectRow = findComponents(c8WallpaperTree, 'SelectRow').find((row) => row.props?.label === '来源')
const c8SelectTree = c8SelectRow === undefined ? null : c8SelectRow.type(c8SelectRow.props)
const c8Select = c8SelectTree === null ? undefined : c8Hosts(c8SelectTree, (node) => node.type === 'select')[0]
const c8SelectLabel = c8SelectTree === null ? [] : c8ById(c8SelectTree, c8Select?.props?.['aria-labelledby'])
check(
  'C8-2) SelectRow 的 select 用 aria-labelledby 指向「来源」名称，选项一个不少',
  c8Select !== undefined && c8SelectLabel.length === 1 && c8Text(c8SelectLabel[0]) === '来源' &&
    c8Hosts(c8SelectTree, (node) => node.type === 'option').length === 3,
  JSON.stringify({ select: c8Select !== undefined, label: c8Text(c8SelectLabel[0]), options: c8SelectTree === null ? 0 : c8Hosts(c8SelectTree, (node) => node.type === 'option').length }),
)

/* SwitchRow：开关是组件（primitives.Switch），名称只能靠 aria-labelledby 传进去。 */
const c8SwitchRow = findComponents(c8WallpaperTree, 'SwitchRow').find((row) => row.props?.label === '扫描子目录')
const c8SwitchTree = c8SwitchRow === undefined ? null : c8SwitchRow.type(c8SwitchRow.props)
const c8SwitchName = c8SwitchTree === null ? undefined : c8Hosts(c8SwitchTree, (node) => node.props?.className === 'ds-ts-name')[0]
let c8SwitchControl = null
if (c8SwitchTree !== null) {
  walkElements(c8SwitchTree, (node) => {
    if (c8SwitchControl === null && typeof node.type === 'function') c8SwitchControl = node
  })
}
check(
  'C8-3) SwitchRow 把名称 id 作为 aria-labelledby 传给开关（primitives.Switch 路径）',
  c8SwitchName !== undefined && c8Text(c8SwitchName) === '扫描子目录' &&
    typeof c8SwitchName.props?.id === 'string' &&
    c8SwitchControl !== null && c8SwitchControl.props?.['aria-labelledby'] === c8SwitchName.props?.id,
  JSON.stringify({ name: c8Text(c8SwitchName), labelledby: c8SwitchControl?.props?.['aria-labelledby'] }),
)

/* ── 2) tabs ↔ tabpanel 的双向关联 ───────────────────────────────── */

/** 取出某棵树里的 tab / tablist / tabpanel。 */
function c8TabsOf(tree) {
  return {
    buttons: c8Hosts(tree, (node) => node.type === 'button' && node.props?.role === 'tab'),
    tablist: c8Hosts(tree, (node) => node.props?.role === 'tablist'),
    tabpanel: c8Hosts(tree, (node) => node.props?.role === 'tabpanel'),
  }
}

const c8Tabs = c8TabsOf(c8WallpaperTree)
check(
  'C8-3) 四个标签按钮都是 role="tab"，且都挂在唯一的 role="tablist" 里',
  c8Tabs.buttons.length === 4 && c8Tabs.tablist.length === 1 &&
    c8Text(c8Tabs.tablist[0]) === '壁纸毛玻璃主题色其他',
  `tabs=${c8Tabs.buttons.length} tablists=${c8Tabs.tablist.length}`,
)

const c8SelectedTabs = c8Tabs.buttons.filter((node) => node.props?.['aria-selected'] === true)
const c8TabIds = c8Tabs.buttons.map((node) => node.props?.id)
check(
  'C8-3) aria-selected 是布尔值，且只有当前页（壁纸）为 true',
  c8Tabs.buttons.every((node) => typeof node.props?.['aria-selected'] === 'boolean') &&
    c8SelectedTabs.length === 1 && c8Text(c8SelectedTabs[0]) === '壁纸',
  c8Tabs.buttons.map((node) => `${c8Text(node)}=${String(node.props?.['aria-selected'])}`).join(' | '),
)

const c8Panel = c8Tabs.tabpanel[0]
check(
  'C8-3) tabpanel 存在，且与当前 tab 的 id / aria-controls 双向对应',
  c8Tabs.tabpanel.length === 1 &&
    typeof c8Panel?.props?.id === 'string' &&
    c8Panel?.props?.['aria-labelledby'] === c8SelectedTabs[0]?.props?.id &&
    c8Tabs.buttons.every((node) => node.props?.['aria-controls'] === c8Panel?.props?.id) &&
    new Set(c8TabIds).size === 4,
  `panel=${String(c8Panel?.props?.id)} labelledby=${String(c8Panel?.props?.['aria-labelledby'])}`,
)

check(
  'C8-3) tabpanel 用 display:contents 包裹层，不改变原 flex 布局（卡片间距仍由父级 gap 提供）',
  String(c8Panel?.props?.className ?? '') === 'ds-ts-tabpanel' &&
    /\.ds-ts-tabpanel\s*\{[^}]*display:\s*contents/.test(c8ClientSource),
  String(c8Panel?.props?.className ?? '(无类名)'),
)

/* 切到毛玻璃页：aria-selected 与 tabpanel 的 aria-labelledby 必须一起跟着走，
 * 否则「选中的是壁纸、面板却报毛玻璃」—— 那比没有 role 更糟。 */
const c8GlassTabs = c8TabsOf(c8GlassTree)
const c8GlassSelected = c8GlassTabs.buttons.filter((node) => node.props?.['aria-selected'] === true)
check(
  'C8-3) 切到毛玻璃页后 aria-selected 跟着走，tabpanel 的 aria-labelledby 同步更新',
  c8GlassSelected.length === 1 && c8Text(c8GlassSelected[0]) === '毛玻璃' &&
    c8GlassTabs.tabpanel.length === 1 &&
    c8GlassTabs.tabpanel[0].props?.['aria-labelledby'] === c8GlassSelected[0]?.props?.id,
  `selected=${c8SelectedTabs.length === 1 ? c8Text(c8SelectedTabs[0]) : '?'} → ${c8GlassSelected.length === 1 ? c8Text(c8GlassSelected[0]) : '?'}`,
)

/* ── 3) status：异步提示的 live region ───────────────────────────── */

/**
 * 渲染一份「带初始状态提示」的面板。
 *
 * status 是 ThemeStudioSection 里第 2 个初始值为 null 的 useState（第 1 个是 browse），
 * 所以用谓词 + nth 精确定位它。不能用 'wallpaper' 覆盖：覆盖位只有一个，会被
 * 标签页先用掉（而且这里不需要换页，默认就是壁纸页）。
 */
function c8RenderWithStatus(kind, text) {
  const runtime = new ThemeRuntime()
  runtime.config = defaultConfig()
  setContextValue(runtime)
  setStateOverride((value) => value === null, { kind, text }, 2)
  try {
    const wrapper = registration.component({ t: (key) => key })
    const section = [].concat(wrapper.children ?? []).find((child) => typeof child?.type === 'function')
    return section.type(section.props)
  } finally {
    clearStateOverride()
  }
}

/** 取出状态提示节点（有 role=status / role=alert 的那个宿主 div）。 */
function c8StatusOf(tree) {
  return c8Hosts(tree, (node) => node.type === 'div' && (node.props?.role === 'status' || node.props?.role === 'alert'))
}

const c8OkStatus = c8StatusOf(c8RenderWithStatus('ok', '已保存'))
check(
  'C8-4) 普通提示是 role="status" + aria-live="polite"，且保留 ds-ts-ok 配色类与原文案',
  c8OkStatus.length === 1 && c8OkStatus[0].props?.role === 'status' &&
    c8OkStatus[0].props?.['aria-live'] === 'polite' &&
    c8OkStatus[0].props?.className === 'ds-ts-ok' &&
    c8Text(c8OkStatus[0]) === '已保存',
  JSON.stringify({ role: c8OkStatus[0]?.props?.role, live: c8OkStatus[0]?.props?.['aria-live'], className: c8OkStatus[0]?.props?.className }),
)

const c8ErrStatus = c8StatusOf(c8RenderWithStatus('err', '保存失败：磁盘只读'))
check(
  'C8-4) 错误提示是 role="alert" + aria-live="assertive"（断言性播报），且保留 ds-ts-err 配色类',
  c8ErrStatus.length === 1 && c8ErrStatus[0].props?.role === 'alert' &&
    c8ErrStatus[0].props?.['aria-live'] === 'assertive' &&
    c8ErrStatus[0].props?.className === 'ds-ts-err' &&
    c8Text(c8ErrStatus[0]) === '保存失败：磁盘只读',
  JSON.stringify({ role: c8ErrStatus[0]?.props?.role, live: c8ErrStatus[0]?.props?.['aria-live'], className: c8ErrStatus[0]?.props?.className }),
)

const c8WarnStatus = c8StatusOf(c8RenderWithStatus('warn', '候选池里没有别的图片可换'))
check(
  'C8-4) 警告提示仍是 polite（不打断朗读），保留 ds-ts-warn 配色类',
  c8WarnStatus.length === 1 && c8WarnStatus[0].props?.role === 'status' &&
    c8WarnStatus[0].props?.['aria-live'] === 'polite' &&
    c8WarnStatus[0].props?.className === 'ds-ts-warn',
  JSON.stringify({ role: c8WarnStatus[0]?.props?.role, live: c8WarnStatus[0]?.props?.['aria-live'], className: c8WarnStatus[0]?.props?.className }),
)

/* ── 4) Thumb：aria-pressed 表达「当前应用中的壁纸」 ─────────────── */

const c8ThumbBase = {
  src: '/theme-studio/api/image?path=x.jpg',
  name: '示例.jpg',
  kind: 'folder',
  label: '从候选墙移除',
  onPick: () => {},
  onRemove: () => {},
}
const c8PickOf = (tree) => c8Hosts(tree, (node) => String(node.props?.className ?? '').includes('ds-ts-thumb-pick'))[0]
const c8ThumbOn = client.Thumb({ ...c8ThumbBase, active: true })
const c8ThumbOff = client.Thumb({ ...c8ThumbBase, active: false })
check(
  'C8-5) Thumb 选图按钮的 aria-pressed：当前壁纸为 true、其它为 false',
  c8PickOf(c8ThumbOn)?.props?.['aria-pressed'] === true &&
    c8PickOf(c8ThumbOff)?.props?.['aria-pressed'] === false,
  `active=true → ${String(c8PickOf(c8ThumbOn)?.props?.['aria-pressed'])} ; active=false → ${String(c8PickOf(c8ThumbOff)?.props?.['aria-pressed'])}`,
)
const c8ThumbDel = c8Hosts(c8ThumbOn, (node) => String(node.props?.className ?? '').includes('ds-ts-thumb-del'))[0]
check(
  'C8-5) 删除按钮的 aria-label 仍然存在（悬停不显示文字，语义只能靠它）',
  c8ThumbDel?.props?.['aria-label'] === '从候选墙移除',
  String(c8ThumbDel?.props?.['aria-label']),
)

/* ── 5) Card：展开按钮的 aria-expanded / aria-controls 必须真的翻转 ── */

const c8Card = findComponents(c8WallpaperTree, 'Card')[0]
const c8CardRender = createHookRenderer()
const c8CardOnce = () => c8CardRender(() => c8Card.type({ ...c8Card.props, children: c8Card.children ?? [] }))
let c8CardTree = c8CardOnce()
const c8CardBody = c8Hosts(c8CardTree, (node) => node.props?.className === 'ds-ts-body')[0]
const c8ToggleOpen = findButton(c8CardTree, '收起')
check(
  'C8-6) 展开状态：按钮 aria-expanded="true" 且 aria-controls 指向正文 id',
  c8ToggleOpen !== null && c8ToggleOpen.props?.['aria-expanded'] === 'true' &&
    typeof c8CardBody?.props?.id === 'string' &&
    c8ToggleOpen.props?.['aria-controls'] === c8CardBody?.props?.id,
  JSON.stringify({ expanded: c8ToggleOpen?.props?.['aria-expanded'], controls: c8ToggleOpen?.props?.['aria-controls'], bodyId: c8CardBody?.props?.id }),
)
const c8CardBodyId = c8CardBody?.props?.id
c8ToggleOpen?.props?.onClick?.()
c8CardTree = c8CardOnce()
const c8ToggleClosed = findButton(c8CardTree, '展开')
check(
  'C8-6) 点击后 aria-expanded 翻转为 "false"、正文卸载，aria-controls 仍指向同一个 id',
  c8ToggleClosed !== null && c8ToggleClosed.props?.['aria-expanded'] === 'false' &&
    c8Hosts(c8CardTree, (node) => node.props?.id === c8CardBodyId).length === 0 &&
    c8ToggleClosed.props?.['aria-controls'] === c8CardBodyId,
  JSON.stringify({ expanded: c8ToggleClosed?.props?.['aria-expanded'], controls: c8ToggleClosed?.props?.['aria-controls'], bodyGone: c8Hosts(c8CardTree, (node) => node.props?.id === c8CardBodyId).length === 0 }),
)

/* ── 6) DiagReport：行按钮 aria-controls → 明细区 id ──────────────── */

const c8DiagItems = [
  {
    region: 'bars', zh: '边栏', note: '', required: true, ok: true, matched: 1, total: 1, invalid: 0,
    hits: [{ selector: '.hHd-Xa_root', count: 1, sample: 'div.hHd-Xa_root' }],
  },
  {
    region: 'menu', zh: '弹层菜单', note: '条件分区，0 命中正常', required: false, ok: true, matched: 0, total: 1, invalid: 0,
    hits: [{ selector: '.ZKlsPq_menu', count: 0, sample: '' }],
  },
]
const c8DiagRender = createHookRenderer()
const c8DiagOnce = () => c8DiagRender(() => client.DiagReport({ items: c8DiagItems }))
const c8DiagHeadOf = (tree) => c8Hosts(tree, (node) => String(node.props?.className ?? '') === 'ds-ts-diag-head')[0]
let c8DiagTree = c8DiagOnce()
let c8DiagHead = c8DiagHeadOf(c8DiagTree)
const c8DiagDetailId = c8DiagHead?.props?.['aria-controls']
check(
  'C8-8) 自检行按钮带 aria-controls（指向由 useId + region 构成的明细区 id）',
  typeof c8DiagDetailId === 'string' && c8DiagDetailId.length > 0 &&
    /-diag-bars$/.test(c8DiagDetailId),
  String(c8DiagDetailId),
)
c8DiagHead?.props?.onClick?.()
c8DiagTree = c8DiagOnce()
c8DiagHead = c8DiagHeadOf(c8DiagTree)
const c8DiagDetail = c8Hosts(c8DiagTree, (node) => node.props?.id === c8DiagDetailId)
check(
  'C8-8) 展开后明细区 id 与 aria-controls 一致，aria-expanded 由 false 翻为 true',
  c8DiagDetail.length === 1 && c8DiagHead?.props?.['aria-expanded'] === 'true',
  JSON.stringify({ expanded: c8DiagHead?.props?.['aria-expanded'], detail: c8DiagDetail.length }),
)

/* ═══════════════════════════════════════════════════════════════════
 * C5：上传交互与缓存清理的客户端语义（audit P1-15、P3-9）
 *
 * 为什么单开一节：
 *   · 上传的预检、单飞、input 复位都只在**真的触发 change** 时才会发生；
 *     静态读源码只能证明「写了」，证明不了「超限时真的没发 fetch」「失败后
 *     value 真的被清空」。这里用 createHookRenderer 让 useState 真的保存值，
 *     才能「触发动作 → 再渲染一次 → 读状态」。
 *   · 清理缓存改走 /api/purge-cache 之后，最关键的两条不变量是
 *     「绝不调用 /api/reset」与「悬挂选择先清掉再扫盘」，都必须数请求来验。
 *
 * 约定：本节的 fetch 桩都返回 `{ status, text }`（readJsonResponse 的入参形态），
 * 与 harness 的默认桩一致；不构造真实 DOM / File，只构造协议够用的 File-like。
 * ═══════════════════════════════════════════════════════════════════ */

/** 造一个 readJsonResponse 能消费的 JSON 响应。 */
const c5Json = (body, status = 200) => ({ status, text: async () => JSON.stringify(body) })

/**
 * 带状态重渲染的面板挂载器。
 *
 * 与 renderPanel() 的区别：renderPanel() 的 useState 是 no-op，动作跑完后
 * status / folders 仍然是初始值，断言不到异步结果。createHookRenderer 把
 * useState 换成真实槽位，于是可以「动作 → 重渲染 → 读状态」。
 *
 * 注意：这里只执行面板**自身**的 hooks —— Card / Thumb / SliderRow 等子组件
 * 都只是 `h(...)` 惰性元素，不会被调用，所以不会出现 harness 注释里警告的
 * 「不同子组件的 hook 串到同一组槽位」。
 * @param runtime - 塞进 React context 的运行时。
 * @returns `{ once, tree }`：`once()` 再渲染一次并返回新树。
 */
function c5Mount(runtime) {
  const render = createHookRenderer()
  const once = () => {
    setContextValue(runtime)
    return render(() => {
      const wrapper = registration.component({ t: (key) => key })
      const section = [].concat(wrapper.children ?? []).find((child) => typeof child?.type === 'function')
      return section.type(section.props)
    })
  }
  return { once, tree: once() }
}

/** 面板里的 `<input type="file">`（宿主节点，不展开组件）。 */
function c5FileInput(tree) {
  return c8Hosts(tree, (node) => node.type === 'input' && node.props?.type === 'file')[0]
}

/** 当前状态提示的 role（没有提示时返回空串）。 */
function c5StatusRole(tree) {
  return c8StatusOf(tree)[0]?.props?.role ?? ''
}

/** 当前状态提示的文本（没有提示时返回空串）。 */
function c5StatusText(tree) {
  return c8Text(c8StatusOf(tree)[0] ?? null)
}

/** 按文案找标签页按钮（`role="tab"`）。 */
function c5Tab(tree, label) {
  return c8Hosts(tree, (node) => node.type === 'button' && node.props?.role === 'tab' && c8Text(node) === label)[0]
}

/**
 * 把指定标题的卡片按**展开态**渲染一次。
 *
 * 卡片默认折叠，正文（按钮）根本不在渲染结果里；而 Card 的头/正文都由它自己
 * 返回，所以必须先展开才能拿到里面的按钮。这里只改测试侧的 props，不碰卡片
 * 自身的 state；按钮的 onClick 仍是面板树上那一份闭包。
 * @param tree - 面板元素树。
 * @param title - 卡片标题。
 * @returns 展开后的卡片元素树；找不到时 null。
 */
function c5CardBody(tree, title) {
  const card = findComponents(tree, 'Card').find((node) => node.props?.title === title)
  if (card === undefined) return null
  /* 本仓库的 React 桩把 children 放在元素对象的 `children` 上（不在 props 里），
   * 所以手工展开组件时要把它们补回 props —— C8 的 Card 测试也是这么做的。 */
  return card.type({ ...card.props, children: card.children ?? [], defaultOpen: true })
}

/** 重置卡片（C5-5 / C5-6 都要点它的按钮）。 */
function c5OpenResetCard(tree) {
  return c5CardBody(tree, '重置')
}

/** 造一个 File-like；fetch 桩不消费 body，所以不需要真正的 Blob。 */
function c5File(name, size, type) {
  return {
    name,
    size,
    type,
    arrayBuffer: async () => new Uint8Array(Math.min(size, 16)).buffer,
    stream() {
      throw new Error('测试桩不消费 stream')
    },
  }
}

/* ── C5-1：合法 PNG → 只发一笔 POST /api/upload，成功后 input 复位 ── */

resetRequests()
const c5UploadRuntime = new ThemeRuntime()
c5UploadRuntime.config = defaultConfig()
const c5UploadPath = 'C:\\Users\\tester\\theme-studio\\wallpapers\\up-1.png'
const c5UploadGroups = {
  ok: true,
  limit: 3000,
  groups: [
    {
      folder: 'C:\\Users\\tester\\theme-studio\\wallpapers',
      uploads: true,
      truncated: false,
      scanned: 1,
      items: [{ path: c5UploadPath, name: 'up-1.png', bytes: 68 }],
    },
  ],
}
setFetchHandler(async (request) => {
  if (request.url.includes('/api/upload')) {
    return c5Json({ ok: true, path: c5UploadPath, url: '/theme-studio/api/image?path=x', bytes: 68, type: 'image/png' })
  }
  if (request.url.includes('/api/folders')) return c5Json(c5UploadGroups)
  if (request.url.includes('/api/config')) return c5Json({ ok: true })
  return c5Json({ ok: true })
})
const c5UploadMount = c5Mount(c5UploadRuntime)
const c5UploadInput = c5FileInput(c5UploadMount.tree)
const c5FakeInput = { value: 'C:\\fakepath\\a.png', files: [c5File('a.png', 68, 'image/png')] }
await c5UploadInput?.props?.onChange?.({ target: c5FakeInput })
const c5UploadTree = c5UploadMount.once()
const c5UploadCalls = requests.filter((request) => request.url.includes('/api/upload'))
check(
  'C5-1) 上传合法 PNG：只发一笔 POST /api/upload，请求体就是选中的文件',
  c5UploadCalls.length === 1 && c5UploadCalls[0].method === 'POST' && c5UploadCalls[0].body?.name === 'a.png',
  `calls=${c5UploadCalls.length} method=${c5UploadCalls[0]?.method ?? '(无)'}`,
)
check(
  'C5-1) 上传成功后 input.value 被清空（同一个文件第二次仍能触发 change）',
  c5FakeInput.value === '',
  `value=${JSON.stringify(c5FakeInput.value)}`,
)
check(
  'C5-1) 成功文案含「上传完成」与宿主返回的 type',
  c5StatusText(c5UploadTree).includes('上传完成') && c5StatusText(c5UploadTree).includes('image/png'),
  c5StatusText(c5UploadTree),
)
check(
  'C5-1) 上传成功后只写一笔配置（applyWallpaper 的 patch 被 flushConfig 一次提交）',
  configPuts().length === 1,
  `PUT=${configPuts().length}`,
)

/* ── C5-1b：上传在途的状态文案 + 重复选择被忽略 ───────────────────── */

resetRequests()
const c5FlightRuntime = new ThemeRuntime()
c5FlightRuntime.config = defaultConfig()
let c5ReleaseUpload
const c5Gate = new Promise((resolve) => {
  c5ReleaseUpload = resolve
})
setFetchHandler(async (request) => {
  if (request.url.includes('/api/upload')) {
    await c5Gate
    return c5Json({ ok: true, path: c5UploadPath, bytes: 68, type: 'image/png' })
  }
  if (request.url.includes('/api/folders')) return c5Json({ ok: true, groups: [] })
  if (request.url.includes('/api/config')) return c5Json({ ok: true })
  return c5Json({ ok: true })
})
const c5FlightMount = c5Mount(c5FlightRuntime)
const c5FlightInput = c5FileInput(c5FlightMount.tree)
const c5FlightFake = { value: 'C:\\fakepath\\in-flight.png', files: [c5File('in-flight.png', 68, 'image/png')] }
const c5FlightPending = c5FlightInput?.props?.onChange?.({ target: c5FlightFake })
const c5FlightTree = c5FlightMount.once()
check(
  'C5-1b) 请求在途时状态是「上传中：文件名」',
  c5StatusText(c5FlightTree) === '上传中：in-flight.png',
  c5StatusText(c5FlightTree),
)
/* 同一笔还在途时再选一个文件：必须被闸门挡住，不能再发第二笔 /api/upload。 */
const c5DuplicateFake = { value: 'C:\\fakepath\\duplicate.png', files: [c5File('duplicate.png', 68, 'image/png')] }
await c5FlightInput?.props?.onChange?.({ target: c5DuplicateFake })
check(
  'C5-1b) 上传在途时重复选择被忽略：只有一笔 POST /api/upload，重复的 input 也被清空',
  requests.filter((request) => request.url.includes('/api/upload')).length === 1 && c5DuplicateFake.value === '',
  `uploads=${requests.filter((request) => request.url.includes('/api/upload')).length} dupValue=${JSON.stringify(c5DuplicateFake.value)}`,
)
c5ReleaseUpload()
await c5FlightPending
const c5FlightDoneTree = c5FlightMount.once()
check(
  'C5-1b) 放行后上传完成，状态回到成功文案',
  c5StatusText(c5FlightDoneTree).includes('上传完成'),
  c5StatusText(c5FlightDoneTree),
)

/* ── C5-2：超过 32MB → 不发任何 fetch，状态是错误提示 ─────────────── */

resetRequests()
const c5BigRuntime = new ThemeRuntime()
c5BigRuntime.config = defaultConfig()
setFetchHandler(async () => c5Json({ ok: true }))
const c5BigMount = c5Mount(c5BigRuntime)
const c5BigInput = c5FileInput(c5BigMount.tree)
const c5BigFake = {
  value: 'C:\\fakepath\\big.png',
  files: [c5File('big.png', 32 * 1024 * 1024 + 1, 'image/png')],
}
await c5BigInput?.props?.onChange?.({ target: c5BigFake })
const c5BigTree = c5BigMount.once()
check(
  'C5-2) 超过 32MB：不发任何 fetch（客户端提前拦截）',
  requests.length === 0,
  `requests=${requests.length}`,
)
check(
  'C5-2) 超限时状态是错误提示，且说明 32MB 上限',
  c5StatusRole(c5BigTree) === 'alert' && c5StatusText(c5BigTree).includes('32MB'),
  `role=${c5StatusRole(c5BigTree)} text=${c5StatusText(c5BigTree)}`,
)
check(
  'C5-2) 被预检拦下时 input 也被清空（失败路径同样复位）',
  c5BigFake.value === '',
  `value=${JSON.stringify(c5BigFake.value)}`,
)

/* ── C5-3：明确非图片 → 拦截；type 为空 → 放行 ────────────────────── */

resetRequests()
const c5TypeRuntime = new ThemeRuntime()
c5TypeRuntime.config = defaultConfig()
setFetchHandler(async (request) => {
  if (request.url.includes('/api/upload')) {
    return c5Json({ ok: true, path: 'C:\\up\\no-type.png', bytes: 4, type: 'image/png' })
  }
  if (request.url.includes('/api/folders')) return c5Json({ ok: true, groups: [] })
  if (request.url.includes('/api/config')) return c5Json({ ok: true })
  return c5Json({ ok: true })
})
const c5TypeMount = c5Mount(c5TypeRuntime)
const c5TypeInput = c5FileInput(c5TypeMount.tree)
const c5TextFake = { value: 'C:\\fakepath\\note.txt', files: [c5File('note.txt', 4, 'text/plain')] }
await c5TypeInput?.props?.onChange?.({ target: c5TextFake })
let c5TypeTree = c5TypeMount.once()
check(
  'C5-3) file.type=text/plain：不发 fetch，状态提示「不是图片」',
  requests.length === 0 && c5StatusText(c5TypeTree).includes('不是图片'),
  `requests=${requests.length} text=${c5StatusText(c5TypeTree)}`,
)
/* 空文件也必须提前拦下：宿主会回 400，但一句「空文件」比 HTTP 状态码直观。 */
const c5TypeInput2 = c5FileInput(c5TypeTree)
const c5EmptyFake = { value: 'C:\\fakepath\\empty.png', files: [c5File('empty.png', 0, 'image/png')] }
await c5TypeInput2?.props?.onChange?.({ target: c5EmptyFake })
const c5EmptyTree = c5TypeMount.once()
check(
  'C5-3) 空文件：不发 fetch，状态直接提示「空文件」',
  requests.length === 0 && c5StatusText(c5EmptyTree).includes('空文件'),
  `requests=${requests.length} text=${c5StatusText(c5EmptyTree)}`,
)
/* type 为空必须放行：有些系统/文件管理器给不出 MIME，宿主会用魔数兜底。
 * 若这里拦下，那些系统上的上传功能就整个不可用。 */
const c5TypeInput3 = c5FileInput(c5EmptyTree)
const c5NoTypeFake = { value: 'C:\\fakepath\\unknown.png', files: [c5File('unknown.png', 4, '')] }
await c5TypeInput3?.props?.onChange?.({ target: c5NoTypeFake })
c5TypeTree = c5TypeMount.once()
const c5NoTypeCalls = requests.filter((request) => request.url.includes('/api/upload'))
check(
  'C5-3) file.type 为空：放行并发送（不能把「不知道类型」误判成「不是图片」）',
  c5NoTypeCalls.length === 1 && !c5StatusText(c5TypeTree).includes('不是图片'),
  `calls=${c5NoTypeCalls.length} text=${c5StatusText(c5TypeTree)}`,
)

/* ── C5-4：上传失败（mock 500）→ 错误状态 + input 清空 + 不写配置 ── */

resetRequests()
const c5FailRuntime = new ThemeRuntime()
c5FailRuntime.config = defaultConfig()
setFetchHandler(async (request) => {
  if (request.url.includes('/api/upload')) return c5Json({ ok: false, error: '磁盘只读' }, 500)
  return c5Json({ ok: true })
})
const c5FailMount = c5Mount(c5FailRuntime)
const c5FailInput = c5FileInput(c5FailMount.tree)
const c5FailFake = { value: 'C:\\fakepath\\a.png', files: [c5File('a.png', 68, 'image/png')] }
await c5FailInput?.props?.onChange?.({ target: c5FailFake })
const c5FailTree = c5FailMount.once()
check(
  'C5-4) 上传失败（HTTP 500）：状态错误、文案可读、input 仍被清空',
  c5StatusRole(c5FailTree) === 'alert' &&
    c5StatusText(c5FailTree).includes('上传失败') &&
    c5StatusText(c5FailTree).includes('磁盘只读') &&
    c5FailFake.value === '',
  `role=${c5StatusRole(c5FailTree)} text=${c5StatusText(c5FailTree)} value=${JSON.stringify(c5FailFake.value)}`,
)
check(
  'C5-4) 上传失败不产生任何配置 PUT（不会把失败当成一次壁纸选择）',
  configPuts().length === 0,
  `PUT=${configPuts().length}`,
)

/* ── C5-5：清理缓存只调 /api/purge-cache，绝不调 /api/reset ────────── */

resetRequests()
const c5PurgeRuntime = new ThemeRuntime()
c5PurgeRuntime.config = defaultConfig()
setFetchHandler(async (request) => {
  if (request.url.includes('/purge-cache')) return c5Json({ ok: true, removedFiles: 3, removedBytes: 2048 })
  if (request.url.includes('/folders')) return c5Json({ ok: true, groups: [] })
  if (request.url.includes('/config')) return c5Json({ ok: true })
  return c5Json({ ok: true })
})
const c5PurgeMount = c5Mount(c5PurgeRuntime)
let c5PurgeTree = c5PurgeMount.tree
c5Tab(c5PurgeTree, '其他')?.props?.onClick?.()
c5PurgeTree = c5PurgeMount.once()
let c5ResetCard = c5OpenResetCard(c5PurgeTree)
const c5ClearCacheButton = c5ResetCard === null ? null : findButton(c5ResetCard, '清理本地缓存')
check(
  'C5-5) 前置：「清理本地缓存」按钮在重置卡片里',
  c5ClearCacheButton !== null && c5ClearCacheButton !== undefined,
  c5ResetCard === null ? '重置卡片未渲染' : `按钮=${c5ClearCacheButton === null ? '缺失' : '在'}`,
)
c5ClearCacheButton?.props?.onClick?.()
c5PurgeTree = c5PurgeMount.once()
c5ResetCard = c5OpenResetCard(c5PurgeTree)
const c5ConfirmButton = c5ResetCard === null ? null : findButton(c5ResetCard, '确认')
check(
  'C5-5) 前置：点「清理本地缓存」后出现「确认」按钮（两步确认保留）',
  c5ConfirmButton !== null && c5ConfirmButton !== undefined,
  c5ConfirmButton === null ? '确认按钮缺失' : '确认按钮在',
)
await c5ConfirmButton?.props?.onClick?.()
c5PurgeTree = c5PurgeMount.once()
const c5PurgeCalls = requests.filter((request) => request.url.includes('/purge-cache'))
const c5ResetCalls = requests.filter((request) => request.url.includes('/api/reset'))
const c5FolderCalls = requests.filter((request) => request.url.includes('/api/folders'))
check(
  'C5-5) 清理缓存只调用一笔 POST /api/purge-cache（同源相对地址），没有 /api/reset',
  c5PurgeCalls.length === 1 &&
    c5PurgeCalls[0].method === 'POST' &&
    c5PurgeCalls[0].url === '/theme-studio/api/purge-cache' &&
    c5ResetCalls.length === 0,
  `purge=${c5PurgeCalls.length} reset=${c5ResetCalls.length} url=${c5PurgeCalls[0]?.url ?? '(无)'}`,
)
check(
  'C5-5) 提示里出现宿主返回的 removedFiles 数量',
  c5StatusText(c5PurgeTree).includes('已清理本地缓存') && c5StatusText(c5PurgeTree).includes('3'),
  c5StatusText(c5PurgeTree),
)
check(
  'C5-5) 清理完成后重新扫描 folders（reloadFolders 会请求两次：groups + refreshWallpapers）',
  c5FolderCalls.length >= 2,
  `folders 请求=${c5FolderCalls.length}`,
)
check(
  'C5-5) 没有悬挂选择时不写配置（清理缓存与改配置彻底解耦）',
  configPuts().length === 0,
  `PUT=${configPuts().length}`,
)

/* ── C5-6：清理后悬挂选择必须清掉（一次 patch + 一笔 PUT） ─────────── */

resetRequests()
const c5DangleRuntime = new ThemeRuntime()
const c5DangleDefaults = defaultConfig()
const c5Pictures = 'C:\\Users\\tester\\Pictures'
c5DangleRuntime.config = {
  ...c5DangleDefaults,
  wallpaper: {
    ...c5DangleDefaults.wallpaper,
    source: 'folder',
    folders: [c5Pictures],
    current: c5UploadPath,
    fixed: c5UploadPath,
    blur: 12,
  },
}
let c5CachePurged = false
setFetchHandler(async (request) => {
  if (request.url.includes('/purge-cache')) {
    c5CachePurged = true
    return c5Json({ ok: true, removedFiles: 2, removedBytes: 128 })
  }
  if (request.url.includes('/folders')) {
    // 清理前扫描到上传候选；清理后上传目录为空，模拟副本真的被删掉。
    return c5Json(c5CachePurged ? { ok: true, groups: [] } : c5UploadGroups)
  }
  if (request.url.includes('/config')) return c5Json({ ok: true })
  return c5Json({ ok: true })
})
const c5DangleMount = c5Mount(c5DangleRuntime)
let c5DangleTree = c5DangleMount.tree
/* 先真的扫一次，让 uploadPaths 里有那张上传候选 —— 悬挂判断读的就是它。
 * 「重新扫描」按钮在「壁纸候选」卡片的 header 里，Card 不展开就看不到。 */
const c5CandidateCard = c5CardBody(c5DangleTree, '壁纸候选')
await findButton(c5CandidateCard, '重新扫描')?.props?.onClick?.()
c5DangleTree = c5DangleMount.once()
c5Tab(c5DangleTree, '其他')?.props?.onClick?.()
c5DangleTree = c5DangleMount.once()
c5ResetCard = c5OpenResetCard(c5DangleTree)
findButton(c5ResetCard, '清理本地缓存')?.props?.onClick?.()
c5DangleTree = c5DangleMount.once()
c5ResetCard = c5OpenResetCard(c5DangleTree)
await findButton(c5ResetCard, '确认')?.props?.onClick?.()
c5DangleTree = c5DangleMount.once()
const c5DanglePuts = configPuts()
const c5DangleBody = c5DanglePuts.length === 1 ? JSON.parse(c5DanglePuts[0].body) : null
check(
  'C5-6) 悬挂选择：只有一笔 PUT，source=none、current/fixed 都清空',
  c5DanglePuts.length === 1 &&
    c5DangleBody?.wallpaper?.source === 'none' &&
    c5DangleBody?.wallpaper?.current === '' &&
    c5DangleBody?.wallpaper?.fixed === '',
  `PUT=${c5DanglePuts.length} body=${JSON.stringify(c5DangleBody?.wallpaper ?? null)}`,
)
check(
  'C5-6) 清空选择没有连带抹掉 wallpaper 的其它字段（folders/blur 仍保留）',
  c5DangleBody?.wallpaper?.folders?.[0] === c5Pictures && c5DangleBody?.wallpaper?.blur === 12,
  JSON.stringify({ folders: c5DangleBody?.wallpaper?.folders, blur: c5DangleBody?.wallpaper?.blur }),
)
check(
  'C5-6) 运行时配置同步清空，不会留下指向已删文件的值',
  c5DangleRuntime.config.wallpaper.source === 'none' &&
    c5DangleRuntime.config.wallpaper.current === '' &&
    c5DangleRuntime.config.wallpaper.fixed === '',
  JSON.stringify({
    source: c5DangleRuntime.config.wallpaper.source,
    current: c5DangleRuntime.config.wallpaper.current,
    fixed: c5DangleRuntime.config.wallpaper.fixed,
  }),
)

/* ═══════════════════════════════════════════════════════════════════
 * C7：数量上限 / 目录缺失全部可见（audit P1-16）
 *
 * 为什么单开一节：这一条的故障形态是「用户什么都没看见」——
 *   · 候选墙旧实现 `slice(0, 400)`，第 401 张之后直接消失，副标题只报可见数；
 *   · /api/folders 补了 scanned / truncated / exists 之后，客户端仍只渲染路径；
 *   · /api/browse 客户端只渲染 60 个目录，一个字的提示都没有。
 * 静态检查证明不了「用户看得见」，只能真的渲染、真的点「加载更多」、真的重扫。
 *
 * 约定：mock /api/folders 返回 500 张候选；断言**数字关系**（200 / 500、总数、
 * 还剩多少、回到 200），不逐字匹配整句文案。
 * ═══════════════════════════════════════════════════════════════════ */

/** 按文案**前缀**找按钮：「加载更多（已显示 200 / 共 500）」里的数字是动态的。 */
function c7ButtonByPrefix(tree, prefix) {
  let found = null
  walkElements(tree, (node) => {
    if (found !== null || node.type !== 'button') return
    const text = [].concat(node.children ?? []).filter((child) => typeof child === 'string').join('')
    if (text.startsWith(prefix)) found = node
  })
  return found
}

/** 「壁纸候选」卡片展开后的正文（缩略图与「加载更多」都在里面）。 */
function c7CandidateBody(tree) {
  return c5CardBody(tree, '壁纸候选')
}

/** 当前渲染出的候选缩略图数量。 */
function c7ThumbCount(tree) {
  return findComponents(c7CandidateBody(tree), 'Thumb').length
}

/** 「壁纸候选」卡片副标题 + 正文的完整文本（断言可见数 / 总数用）。 */
function c7CandidateText(tree) {
  const body = c7CandidateBody(tree)
  return body === null ? '' : c8Text(body)
}

/** 500 张候选（path 互不相同，Thumb 用 path 做 key）。 */
const c7Items = Array.from({ length: 500 }, (_, index) => {
  const name = `p-${String(index + 1).padStart(3, '0')}.jpg`
  return { path: `D:\\pics\\${name}`, name, bytes: 1024 }
})

/** 造一个已登记若干目录的运行时（其余配置保持出厂值）。 */
function c7RuntimeWith(folders, wallpaperOverrides = {}) {
  const runtime = new ThemeRuntime()
  const base = defaultConfig()
  runtime.config = {
    ...base,
    wallpaper: { ...base.wallpaper, source: 'folder', folders, ...wallpaperOverrides },
  }
  return runtime
}

/** 触发「重新扫描」并重渲染（按钮在 Card 的 right 子树里，不在 children 中）。 */
async function c7Rescan(mount, tree) {
  const card = findComponents(tree, 'Card').find((node) => node.props?.title === '壁纸候选')
  await findButton(card?.props?.right, '重新扫描')?.props?.onClick?.()
  return mount.once()
}

/* ── C7-1 ~ C7-7：500 张候选 → 窗口 200 / 加载更多 / 重扫复位 ─────── */

const c7BigGroups = {
  ok: true,
  limit: 3000,
  groups: [
    {
      folder: 'D:\\pics',
      exists: true,
      count: c7Items.length,
      scanned: c7Items.length,
      truncated: false,
      items: c7Items,
    },
  ],
}

resetRequests()
setFetchHandler(async (request) => {
  if (request.url.includes('/api/folders')) return c5Json(c7BigGroups)
  if (request.url.includes('/api/config')) return c5Json({ ok: true })
  return c5Json({ ok: true })
})
const c7BigMount = c5Mount(c7RuntimeWith(['D:\\pics']))
let c7Tree = await c7Rescan(c7BigMount, c7BigMount.tree)

check(
  'C7-1) 500 张候选：初次渲染只渲染窗口内的 200 张缩略图',
  c7ThumbCount(c7Tree) === 200,
  `${c7ThumbCount(c7Tree)} 张`,
)
check(
  'C7-2) 卡片副标题显示「可见数 / 总数」并说明还有多少张没显示（200 / 500，剩 300）',
  c7CandidateText(c7Tree).includes('200 / 500') && c7CandidateText(c7Tree).includes('300'),
  c7CandidateText(c7Tree).match(/\d+\s*\/\s*\d+[^）)]*/)?.[0] ?? '(没找到比率)',
)

const c7MoreButton = c7ButtonByPrefix(c7CandidateBody(c7Tree), '加载更多')
check(
  'C7-3) 超过窗口时出现「加载更多（已显示 200 / 共 500）」',
  c7MoreButton !== null && c8Text(c7MoreButton).includes('200') && c8Text(c7MoreButton).includes('500'),
  c8Text(c7MoreButton),
)

c7MoreButton?.props?.onClick?.()
c7Tree = c7BigMount.once()
check(
  'C7-4) 点一次「加载更多」后显示 400 张，按钮文案跟着变成 400 / 共 500',
  c7ThumbCount(c7Tree) === 400 &&
    c8Text(c7ButtonByPrefix(c7CandidateBody(c7Tree), '加载更多')).includes('400'),
  `${c7ThumbCount(c7Tree)} 张 / ${c8Text(c7ButtonByPrefix(c7CandidateBody(c7Tree), '加载更多'))}`,
)

c7ButtonByPrefix(c7CandidateBody(c7Tree), '加载更多')?.props?.onClick?.()
c7Tree = c7BigMount.once()
check(
  'C7-5) 再点一次后显示全部 500 张，且「加载更多」按钮消失',
  c7ThumbCount(c7Tree) === 500 && c7ButtonByPrefix(c7CandidateBody(c7Tree), '加载更多') === null,
  `${c7ThumbCount(c7Tree)} 张 / 按钮=${String(c7ButtonByPrefix(c7CandidateBody(c7Tree), '加载更多'))}`,
)
check(
  'C7-6) 全部显示后副标题是 500 / 500（不再暗示还有剩余）',
  c7CandidateText(c7Tree).includes('500 / 500'),
  c7CandidateText(c7Tree).match(/\d+\s*\/\s*\d+/)?.[0] ?? '(没找到比率)',
)

c7Tree = await c7Rescan(c7BigMount, c7Tree)
check(
  'C7-7) 重新扫描后渲染窗口重置回 200（不会把全库一次性渲染）',
  c7ThumbCount(c7Tree) === 200,
  `${c7ThumbCount(c7Tree)} 张`,
)

/* ── C7-8 ~ C7-10：每组的状态（数量 / 截断 / 目录缺失）都要可见 ──── */

const c7StatusGroups = {
  ok: true,
  limit: 2,
  groups: [
    {
      folder: 'D:\\pics',
      exists: true,
      count: 2,
      scanned: 2,
      truncated: true,
      items: c7Items.slice(0, 2),
    },
    {
      folder: 'D:\\missing',
      exists: false,
      count: 0,
      scanned: 0,
      truncated: false,
      items: [],
    },
  ],
}
setFetchHandler(async (request) => {
  if (request.url.includes('/api/folders')) return c5Json(c7StatusGroups)
  if (request.url.includes('/api/config')) return c5Json({ ok: true })
  return c5Json({ ok: true })
})
const c7StatusMount = c5Mount(c7RuntimeWith(['D:\\pics', 'D:\\missing']))
const c7StatusTree = await c7Rescan(c7StatusMount, c7StatusMount.tree)
const c7SourceCard = c5CardBody(c7StatusTree, '图片来源')
const c7SourceText = c7SourceCard === null ? '' : c8Text(c7SourceCard)
check(
  'C7-8) truncated 的组显示「扫描达到上限、仅显示前 2 张」',
  c7SourceText.includes('上限') && /上限[^。]*2\s*张/.test(c7SourceText),
  c7SourceText.slice(0, 220),
)
check(
  'C7-9) exists:false 的组显示目录缺失 / 不可读警示',
  c7SourceText.includes('目录不存在或不可读'),
  c7SourceText.slice(0, 220),
)
check(
  'C7-10) 每个登记目录都显示图片数量（2 张 / 0 张），不足窗口时全部显示且没有「加载更多」',
  c7SourceText.includes('2 张') &&
    c7SourceText.includes('0 张') &&
    c7ThumbCount(c7StatusTree) === 2 &&
    c7ButtonByPrefix(c7CandidateBody(c7StatusTree), '加载更多') === null,
  `${c7SourceText.slice(0, 160)} / 缩略图=${c7ThumbCount(c7StatusTree)}`,
)

/* ── C7-11 / C7-12：/api/browse 的 60 个上限必须可见 ─────────────── */

/** 造 count 个子目录的 /api/browse 响应。 */
function c7BrowseBody(count) {
  return {
    ok: true,
    path: 'D:\\',
    parent: null,
    dirs: Array.from({ length: count }, (_, index) => ({ path: `D:\\d${index + 1}`, name: `d${index + 1}` })),
    imageCount: 0,
  }
}

setFetchHandler(async (request) => {
  if (request.url.includes('/api/browse')) return c5Json(c7BrowseBody(60))
  if (request.url.includes('/api/folders')) return c5Json({ ok: true, limit: 3000, groups: [] })
  return c5Json({ ok: true })
})
const c7BrowseMount = c5Mount(c7RuntimeWith([]))
await findButton(c7BrowseMount.tree, '浏览')?.props?.onClick?.()
const c7BrowseTree = c7BrowseMount.once()
const c7BrowseCard = c5CardBody(c7BrowseTree, '图片来源')
const c7BrowseText = c7BrowseCard === null ? '' : c8Text(c7BrowseCard)
check(
  'C7-11) browse 返回 60 个目录：出现「仅显示前 60 个」提示',
  c7BrowseText.includes('仅显示前 60 个'),
  c7BrowseText.slice(0, 220),
)

setFetchHandler(async (request) => {
  if (request.url.includes('/api/browse')) return c5Json(c7BrowseBody(59))
  if (request.url.includes('/api/folders')) return c5Json({ ok: true, limit: 3000, groups: [] })
  return c5Json({ ok: true })
})
const c7BrowseSmallMount = c5Mount(c7RuntimeWith([]))
await findButton(c7BrowseSmallMount.tree, '浏览')?.props?.onClick?.()
const c7BrowseSmallTree = c7BrowseSmallMount.once()
const c7BrowseSmallCard = c5CardBody(c7BrowseSmallTree, '图片来源')
const c7BrowseSmallText = c7BrowseSmallCard === null ? '' : c8Text(c7BrowseSmallCard)
check(
  'C7-12) browse 返回 59 个目录：不出现截断提示（阈值是 60，不是「有列表就提示」）',
  c7BrowseSmallText.includes('当前目录') && !c7BrowseSmallText.includes('仅显示前'),
  c7BrowseSmallText.slice(0, 160),
)

setFetchHandler(null)
setContextValue(undefined)

/* ═══════════════════════════════════════════════════════════════════
 * C9：外壳透明必须跟「壁纸真的会生效」绑定（C13）
 *
 * source 只表示用户选了来源，不代表有图：folder 可能候选为空、候选全部失效
 * 或宿主不可达。判据是运行时真正解析出的 resolved；它为空时绝不能把
 * html/body 调透明，否则背景层没有任何图片，界面会丢掉 DSH 原生底色。
 * ═══════════════════════════════════════════════════════════════════ */

const c9Base = defaultConfig()
const c9FolderConfig = {
  ...c9Base,
  wallpaper: {
    ...c9Base.wallpaper,
    source: 'folder',
    folders: ['D:\\pics'],
    current: '',
    fixed: '',
  },
}
const c9EmptyCss = client.buildCss(c9FolderConfig, '')
check(
  'C9-1) source=folder、current/fixed 为空且 resolved 为空：不输出外壳透明，也不覆盖 frame / --dsw-alias-bg-base',
  !c9EmptyCss.includes(SHELL_RULE) &&
    !c9EmptyCss.includes('--ds-ts-frame') &&
    !c9EmptyCss.includes('--dsw-alias-bg-base'),
  `shell=${c9EmptyCss.includes(SHELL_RULE)} frame=${c9EmptyCss.includes('--ds-ts-frame')} bg-base=${c9EmptyCss.includes('--dsw-alias-bg-base')}`,
)

const c9Wallpaper = 'D:\\壁纸\\a.jpg'
const c9ActiveCss = client.buildCss(c9FolderConfig, c9Wallpaper)
const c9ShellCount = c9ActiveCss.split(SHELL_RULE).length - 1
check(
  'C9-2) 同一份配置但 resolved 指向有效路径：外壳透明规则恰好 1 条（不误伤有图场景）',
  c9ShellCount === 1 && c9ActiveCss.includes('--dsw-alias-bg-base'),
  `次数=${c9ShellCount} bg-base=${c9ActiveCss.includes('--dsw-alias-bg-base')}`,
)

const c9NoneCss = client.buildCss(
  { ...c9FolderConfig, wallpaper: { ...c9FolderConfig.wallpaper, source: 'none' } },
  c9Wallpaper,
)
check(
  'C9-3) source=none 时即使传入 resolved 也不输出外壳透明',
  !c9NoneCss.includes(SHELL_RULE) && !c9NoneCss.includes('--dsw-alias-bg-base'),
  `shell=${c9NoneCss.includes(SHELL_RULE)} bg-base=${c9NoneCss.includes('--dsw-alias-bg-base')}`,
)

const c9DisabledConfig = { ...c9FolderConfig, enabled: false }
const c9DisabledCss = client.buildCss(c9DisabledConfig, c9Wallpaper)
check(
  'C9-4) enabled=false 时生成 CSS 里 0 条外壳透明规则',
  !c9DisabledCss.includes(SHELL_RULE),
  `shell=${c9DisabledCss.includes(SHELL_RULE)}`,
)
const c9DisabledRuntime = new ThemeRuntime()
dom.html.setAttribute('data-dsh-theme-studio', '')
const c9HeadBefore = dom.head.children.length
await c9DisabledRuntime.apply(c9DisabledConfig)
check(
  'C9-4) enabled=false 时运行时不注入样式且撤掉根属性',
  !Object.hasOwn(dom.html, 'data-dsh-theme-studio') && dom.head.children.length === c9HeadBefore,
  `attr=${String(dom.html['data-dsh-theme-studio'])} styleDelta=${dom.head.children.length - c9HeadBefore}`,
)

/* 最贴近真实启动路径：预置缓存 → client.apply(ctx) → 宿主两次 fetch 都失败。
 * 与 probe-cache-offline2.mjs 同一场景：source=folder、候选池为空、没有图。
 * 宿主不可达是本用例的**预期条件**，临时压掉 load() 的告警输出，避免污染测试报告。 */
storage.set(
  'dsh-theme-studio:config:1.0',
  JSON.stringify({ version: '1.0', config: c9FolderConfig }),
)
setFetchHandler(async () => {
  throw new Error('host down')
})
const c9OriginalWarn = console.warn
console.warn = () => {}
try {
  client.apply(c3Context())
  await wait(50)
} finally {
  console.warn = c9OriginalWarn
}
const c9OfflineRuntime = c3Runtime()
const c9OfflineStyles = dom.head.children.filter((node) => node.tagName === 'STYLE')
const c9OfflineCss = c9OfflineStyles[c9OfflineStyles.length - 1]?.textContent ?? ''
check(
  'C9-5) 宿主不可达 + 缓存 source=folder/current 空：resolved 为空、最终样式无外壳透明、背景层未创建（不会「透明且无图」）',
  c9OfflineRuntime.resolved === '' &&
    c9OfflineCss.length > 500 &&
    !c9OfflineCss.includes(SHELL_RULE) &&
    c9OfflineRuntime.background.element === null,
  `resolved=${JSON.stringify(c9OfflineRuntime.resolved)} shell=${c9OfflineCss.includes(SHELL_RULE)} bg=${c9OfflineRuntime.background.element === null ? 'null' : 'exists'} css=${c9OfflineCss.length}`,
)
setFetchHandler(null)

/* ═══════════════════════════════════════════════════════════════════ */

console.log(`\n${failed === 0 ? 'CLIENT OK' : 'CLIENT FAILED'}（${passed} PASS / ${failed} FAIL）`)
if (failed > 0) process.exitCode = 1
