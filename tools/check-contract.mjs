/**
 * 契约测试：宿主半侧与客户端半侧必须对「配置形状」达成一致，
 * 且每个分区都要有默认参数与选择器。两侧分开维护，这里把它们钉在一起。
 *
 * 用法：node tools/check-contract.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHost } from './lib/host-harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* ── 最小 DOM/React 桩，用来物化客户端 bundle ───────────────────── */

const makeElement = (tag) => ({
  tagName: String(tag).toUpperCase(),
  style: { setProperty() {} },
  dataset: {},
  children: [],
  isConnected: true,
  textContent: '',
  setAttribute() {},
  removeAttribute() {},
  appendChild(child) {
    this.children.push(child)
    return child
  },
  remove() {},
})

globalThis.document = {
  head: makeElement('head'),
  body: makeElement('body'),
  documentElement: makeElement('html'),
  createElement: makeElement,
  querySelector: () => null,
  querySelectorAll: () => [],
}
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
}
globalThis.localStorage = { getItem: () => null, setItem() {} }

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect() {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  useContext: () => undefined,
  createContext: () => ({}),
}

const registrations = []
globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }

await import(`file://${path.join(ROOT, 'lib', 'client.js').replace(/\\/g, '/')}`)
const client = registrations[0].factory((name) => {
  if (name === 'react') return React
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Switch: () => null }
  throw new Error(`unexpected require("${name}")`)
})

const host = await import(`file://${path.join(ROOT, 'lib', 'index.js').replace(/\\/g, '/')}`)

const check = (label, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) process.exitCode = 1
}

const shape = (value) =>
  JSON.stringify(value, (key, item) => (Array.isArray(item) ? `[${item.length}]` : item))

const hostDefaults = host.defaultConfig()
const clientDefaults = client.defaultConfig()
check('壁纸遮罩颜色两端默认为 auto，沿用原黑色遮罩',
  hostDefaults.wallpaper.dimColor === 'auto' && clientDefaults.wallpaper.dimColor === 'auto')
check('遮罩自定义色可随壁纸配置合并保存，并可恢复 auto 而不改变强度', (() => {
  const saved = host.mergeConfig(hostDefaults, { wallpaper: { dim: 0.4, dimColor: '#13579b' } })
  const restored = host.mergeConfig(saved, { wallpaper: { dimColor: 'auto' } })
  return saved.wallpaper.dim === 0.4 && saved.wallpaper.dimColor === '#13579b' &&
    restored.wallpaper.dim === 0.4 && restored.wallpaper.dimColor === 'auto'
})())

/* 形状一致性：只比较键与类型（数组比长度），不比较具体数值。 */
for (const section of ['accent', 'wallpaper', 'glass']) {
  const a = JSON.parse(shape(hostDefaults[section]))
  const b = JSON.parse(shape(clientDefaults[section]))
  const keysA = Object.keys(a).sort().join(',')
  const keysB = Object.keys(b).sort().join(',')
  check(`配置节 ${section} 键集合一致`, keysA === keysB, keysA === keysB ? `${Object.keys(a).length} 项` : `host=[${keysA}] client=[${keysB}]`)
}

check('顶层键一致', Object.keys(hostDefaults).sort().join(',') === Object.keys(clientDefaults).sort().join(','),
  Object.keys(hostDefaults).join(','))

const hostGlassKeys = Object.keys(hostDefaults.glass).filter((key) => typeof hostDefaults.glass[key] === 'object').sort()
const clientGlassKeys = Object.keys(clientDefaults.glass).filter((key) => typeof clientDefaults.glass[key] === 'object').sort()
check('玻璃分区集合一致', hostGlassKeys.join(',') === clientGlassKeys.join(','), hostGlassKeys.join(','))

/* 每个分区都必须有：默认参数 + 至少一个选择器。 */
for (const key of hostGlassKeys) {
  const hasDefaults = typeof clientDefaults.glass[key]?.opacity === 'number' && typeof clientDefaults.glass[key]?.blur === 'number'
  const selectors = client.REGION_SELECTORS[key]
  check(`分区 ${key} 参数与选择器齐备`, hasDefaults && Array.isArray(selectors) && selectors.length > 0,
    `selectors=${(selectors ?? []).length}`)
}

/* CSS 必须全部限定在开启属性之内，关闭后才能干净复原。
   逐字符扫描：在每个 `{` 之前回溯出选择器文本（选择器本身不含花括号），
   逐个校验它是否以开启属性开头。

   注意分割选择器列表时不能直接 split(',')：`:is(button, [role="button"], a)`
   这类函数式伪类里的逗号会被误当成选择器分隔符，切出 `[role="button"]` 这样的碎片。
   所以按括号深度只在顶层切分。 */
const css = client.buildCss(clientDefaults)
const rootAttr = '[data-dsh-theme-studio]'

/** 按顶层逗号切分选择器列表（忽略括号内的逗号）。 */
function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth += 1
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

const unguarded = []
{
  let lastBoundary = 0
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]
    if (ch === '{') {
      const selectorText = css.slice(lastBoundary, i)
      for (const selector of splitTopLevel(selectorText)) {
        const trimmed = selector.trim()
        // 合法形态有两种：以 `html[attr]` 起头，或以 `html[attr]` 自身为选择器
        // （后者用于声明自定义属性）。
        const scoped = trimmed.startsWith(`html${rootAttr}`) || trimmed === `html${rootAttr}`
        if (trimmed.length > 0 && !scoped) unguarded.push(trimmed)
      }
    } else if (ch === '}') {
      lastBoundary = i + 1
    }
  }
}
check('所有规则都限定在开启属性内', unguarded.length === 0,
  unguarded.length === 0 ? 'none' : [...new Set(unguarded)].slice(0, 4).join(' | '))

/* 分区数：原本 7 个（含 sidebar）；0.1.9 删 sidebar、0.1.12 删 topbar、
 * 0.1.13 删 chat、0.1.14 删 panel；0.1.15 把 sidebar + topbar 合并重写为新分区 `bars`。
 * 这里刻意写成「常量 + 已删分区不得出现」，而不是只对数字 ——
 * 单纯改数字的话，把删掉的分区加回来、同时少写一个别的分区也能骗过断言。 */
const LIVE_REGIONS = ['bars', 'input', 'bubble', 'assistant', 'menu']
const recolored = host.mergeConfig(host.defaultConfig(), { glass: { menu: { color: '#ff0080' } } })
const restoredColor = host.mergeConfig(recolored, { glass: { menu: { color: 'auto' } } })
check('自定义颜色可以持久化，并能通过 auto 写回默认（不用会被深合并忽略的 null）',
  recolored.glass.menu.color === '#ff0080' && restoredColor.glass.menu.color === 'auto')
/* `sidebar` / `topbar` 仍然算「已删」：0.1.15 重写用的是**全新的键 `bars`**，
 * 那两个旧键不该复活（宿主 RETIRED_REGIONS 里也还留着它们）。 */
const REMOVED_REGIONS = ['sidebar', 'topbar', 'chat', 'panel']
check(`CSS 覆盖了 ${LIVE_REGIONS.length} 个分区`,
  Object.keys(client.REGION_SELECTORS).length === LIVE_REGIONS.length &&
    LIVE_REGIONS.every((key) => key in client.REGION_SELECTORS),
  Object.keys(client.REGION_SELECTORS).join(','))
for (const key of REMOVED_REGIONS) {
  check(`分区选择器表不含 ${key}`, !(key in client.REGION_SELECTORS), Object.keys(client.REGION_SELECTORS).join(','))
  check(`默认配置 glass 不含 ${key}`, !(key in client.defaultConfig().glass), Object.keys(client.defaultConfig().glass).join(','))
  check(`宿主默认配置 glass 不含 ${key}`, !(key in host.defaultConfig().glass), Object.keys(host.defaultConfig().glass).join(','))
  check(`分区定义表不含 ${key}`, !client.REGIONS.some((region) => region.key === key),
    client.REGIONS.map((region) => region.key).join(','))
  check(`生成的 CSS 不含 ${key} 专用变量`, !css.includes(`--ds-ts-${key}`))
}
/* 已删分区的**元素选择器**也不得再出现在生成的 CSS 里 ——
 * 光断言「表里没有这个键」不够：选择器完全可能挂在别的分区名下（chat 当初就挂在
 * `.pI_x6G_centerCol` / `.wSkVaW_root` 上，而它们都是顶边栏的祖先）。
 * 注意 `sidebar` / `topbar` **不在**这张表里：它们的元素由重写后的 `bars` 接管。 */
const RETIRED_SELECTOR_FRAGMENTS = {
  chat: ['.pI_x6G_centerCol', '.wSkVaW_root'],
  panel: ['.VOzbGW_panel', '.VOzbGW_mask'],
}
for (const key of REMOVED_REGIONS) {
  const fragments = RETIRED_SELECTOR_FRAGMENTS[key] ?? []
  for (const fragment of fragments) {
    check(`已删分区 ${key} 的元素选择器 ${fragment} 不再出现在 CSS 里`,
      !css.includes(`] ${fragment}`), (css.match(new RegExp(`[^\\n]*${fragment.replace('.', '\\.')}[^\\n]*`, 'g')) ?? []).slice(0, 2).join(' | ') || '(无)')
  }
}
/* panel 还额外绑过三条 token，删掉之后都不该再出现在生成的 CSS 里。 */
for (const token of ['--ds-ts-panel', '--dsw-mask-blur']) {
  check(`设置界面分区删掉后不再输出 ${token}`, !css.includes(token))
}
check('--dsw-alias-bg-layer-1 不再被插件覆盖（还给 DSH 原生）',
  !/--dsw-alias-bg-layer-1\s*:/.test(css))
check('--dsw-alias-bg-overlay 不再被插件覆盖（还给 DSH 原生）',
  !/--dsw-alias-bg-overlay\s*:/.test(css))

/* ── 边栏（0.1.15 重写）：这套实现有它的形状约束，逐条钉住 ────────────── */
const barsCss = client.buildCss({
  ...client.defaultConfig(),
  glass: { ...client.defaultConfig().glass, bars: { enabled: true, opacity: 0.5, blur: 24 } },
})
check('边栏的膜与模糊落在 ::before 上（不是元素自身）',
  /\] \.hHd-Xa_root::before,/.test(barsCss) && /\] \.wSkVaW_header::before \{/.test(barsCss))
check('边栏的伪元素同时带 background-color 与 backdrop-filter',
  /\.hHd-Xa_root::before,[\s\S]*?background-color: var\(--ds-ts-bars\)[\s\S]*?backdrop-filter: blur\(24px\)/.test(barsCss))
check('侧边栏与顶边栏的选择器成对出现（一个分区管两处）',
  barsCss.includes('] .hHd-Xa_root,') && barsCss.includes('] .wSkVaW_header {'))
check('伪元素被推到内容之下（z-index: -1）并让出指针事件',
  /\.hHd-Xa_root::before,[\s\S]*?z-index: -1;[\s\S]*?pointer-events: none;/.test(barsCss))
check('仅边栏玻璃膜右缘/下缘补回原生颜色的分隔描边，不占布局宽度',
  barsCss.includes('] .hHd-Xa_root::before { box-shadow: inset -1px 0 0 var(--dsw-alias-border-l1); }') &&
    barsCss.includes('] .wSkVaW_header::before { background-color: var(--ds-ts-bars-head); box-shadow: inset 0 -1px 0 var(--dsw-alias-border-l1); }') &&
    !/\] \.(?:hHd-Xa_root|wSkVaW_header) \{[^}]*border(?:-right|-bottom)?\s*:/.test(barsCss))
check('顶边栏的负层伪元素有自己的绘制上下文，侧栏保持原层叠以放行设置弹窗',
  barsCss.includes('] .wSkVaW_header { isolation: isolate; }') &&
    !/\] \.hHd-Xa_root \{[^}]*isolation/.test(barsCss))
/* ★ 真实故障的回归点（0.1.16）：给这两个元素加 `z-index` 会创建层叠上下文，
 * 把内部的设置弹窗（`z-index: 1000` 的 fixed 元素）关在里面，于是弹窗被 DOM 顺序
 * 更靠后的 `.wSkVaW_root`（z-index: auto → 按 0 处理）整块盖住。 */
check('★ 边栏元素自身绝不加 z-index（否则会把设置弹窗关进层叠上下文）',
  !/\] \.(?:hHd-Xa_root|wSkVaW_header) \{[^}]*z-index/.test(barsCss))
check('★ 壁纸层用 z-index: -2，排在边栏伪元素（-1）之下',
  barsCss.includes('#dsh-theme-studio-bg { position: fixed; inset: 0; z-index: -2;'))
check('无壁纸时左侧整列直接绘制遮罩，不被不透明的 frame 盖掉',
  barsCss.includes('.pI_x6G_sidebarCol { background: var(--ds-ts-bars) !important; }') &&
    !barsCss.includes('.pI_x6G_frame { background: transparent !important; }'))
/* ★ 侧栏里的实色有**三个来源**，第三个是会话列表底部 24px 的渐隐遮罩
 * （`linear-gradient(to bottom, transparent, var(--dsw-specific-sidebar-fill))`）。
 * 它只能靠「在 .hHd-Xa_root 上就地覆盖 token」掐掉；而那个 token 会话区也在消费，
 * 所以**必须限定作用域**，不能写到 body/html 上做全局覆盖。 */
check('★ sidebar-fill 在侧栏内被就地覆盖为透明（掐掉渐隐白带）',
  barsCss.includes('] .hHd-Xa_root { --dsw-specific-sidebar-fill: transparent !important; }'))
check('★ sidebar-fill 的覆盖没写到全局（会话区也消费同一个 token）',
  !/body \{[^}]*--dsw-specific-sidebar-fill\s*:/.test(barsCss))
/* 最关键的一条：**不允许**在 .hHd-Xa_root / .wSkVaW_header 自身上写 backdrop-filter。
 * 那会让它们成为 position:fixed 的包含块，把设置弹窗锁进侧栏 280×807（0.1.7 的真实故障）。 */
const selfBlurred = /\] \.(?:hHd-Xa_root|wSkVaW_header) \{[^}]*backdrop-filter/.test(barsCss)
check('元素自身绝不带 backdrop-filter（否则会困住设置弹窗）', !selfBlurred)
check('没有 :has() 让位规则这类补丁（伪元素方案不需要）',
  !barsCss.includes(':has(.VOzbGW_overlay)'))
check('边栏关闭时一条规则都不输出', (() => {
  const off = client.buildCss({
    ...client.defaultConfig(),
    glass: { ...client.defaultConfig().glass, bars: { enabled: false, opacity: 0.5, blur: 24 } },
  })
  return !off.includes('.hHd-Xa_root') && !off.includes('.wSkVaW_header') && !off.includes('--ds-ts-bars') &&
    !off.includes('box-shadow: inset -1px 0 0 var(--dsw-alias-border-l1)')
})())
const wallpaperConfig = {
  ...client.defaultConfig(),
  wallpaper: { ...client.defaultConfig().wallpaper, source: 'fixed', fixed: 'C:\\wallpaper.jpg' },
}
const barsOffWallpaper = client.buildCss({
  ...wallpaperConfig,
  glass: { ...wallpaperConfig.glass, bars: { enabled: false, opacity: 0.4, blur: 24 } },
})
check('壁纸生效但边栏关闭时：仅给顶边栏恢复 DSH 原生明暗底色，主区仍透明',
  barsOffWallpaper.includes('.pI_x6G_frame { background: transparent !important; }') &&
    barsOffWallpaper.includes('.wSkVaW_header { background: var(--dsw-static-neutral-bluish-00, #fff) !important; }') &&
    barsOffWallpaper.includes('.wSkVaW_header { background: var(--dsw-static-neutral-bluish-950, #151517) !important; }') &&
    !barsOffWallpaper.includes('.wSkVaW_header::before') &&
    !barsOffWallpaper.includes('.hHd-Xa_root') &&
    !barsOffWallpaper.includes('.wSkVaW_root {'))
check('壁纸未生效时边栏关闭：原生 frame 与顶边栏均不被覆盖', (() => {
  const off = client.buildCss({
    ...client.defaultConfig(),
    glass: { ...client.defaultConfig().glass, bars: { enabled: false, opacity: 0.4, blur: 24 } },
  })
  return !off.includes('.pI_x6G_frame {') && !off.includes('.wSkVaW_header')
})())
check('壁纸与边栏均开启时顶边栏由玻璃膜负责，不叠加原生实色', (() => {
  const on = client.buildCss({
    ...wallpaperConfig,
    glass: { ...wallpaperConfig.glass, bars: { enabled: true, opacity: 0.4, blur: 24 } },
  })
  return on.includes('.wSkVaW_header { isolation: isolate; }') &&
    on.includes('.wSkVaW_header::before {') &&
    on.includes('.pI_x6G_sidebarCol { background: transparent !important; }') &&
    !on.includes('.wSkVaW_header { background: var(--dsw-static-neutral-bluish-00')
})())
check('边栏不透明度=100% 时不输出 backdrop-filter',
  !/\.hHd-Xa_root::before,[\s\S]*?backdrop-filter/.test(client.buildCss({
    ...client.defaultConfig(),
    glass: { ...client.defaultConfig().glass, bars: { enabled: true, opacity: 1, blur: 24 } },
  })))
check('客户端导出 REGIONS 且与选择器表一一对应',
  client.REGIONS.every((region) => region.key in client.REGION_SELECTORS) &&
    client.REGIONS.length === Object.keys(client.REGION_SELECTORS).length,
  client.REGIONS.map((region) => region.key).join(','))
/* `required` 决定自检报告里 0 命中算不算故障：
 *   - 必需（bars / input）：目标元素**始终存在**，0 命中只可能是选择器过期 → 标红；
 *   - 条件（bubble / assistant / menu）：目标只在某种状态下渲染（会话里有消息 / 弹层被打开），
 *     0 命中是那个状态的必然结果 → 中性色。
 * 判定逻辑在 diagnose()，这里只锁住这张表的结论，防止有人顺手改掉。 */
check('★ 自检的必需/条件判定：消息气泡与弹层菜单是条件，边栏与输入框是必需',
  client.REGIONS.filter((region) => region.required === false).map((region) => region.key).sort().join(',') === 'assistant,bubble,menu',
  client.REGIONS.map((region) => `${region.key}:${region.required === false ? '条件' : '必需'}`).join(' '))
check('★ 条件分区都带 0 命中的解释文案（面板上要显示给人看）',
  client.REGIONS.filter((region) => region.required === false)
    .every((region) => String(region.note ?? '').trim().length > 10),
  client.REGIONS.filter((region) => region.required === false)
    .map((region) => `${region.key}:${String(region.note ?? '').length}字`).join(' '))
check('宿主插件导出 name/inject/apply', host.name === 'dsh-theme-studio' && Array.isArray(host.inject) && typeof host.apply === 'function')
check('客户端插件导出 apply/inject', typeof client.apply === 'function' && Array.isArray(client.inject))

/* ═══════════════════════════════════════════════════════════════════════
 * 本轮新增契约：默认值深比较、版本同源、退役键、关闭分区、外壳透明
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * 递归比较两份 JSON 值，返回首个差异路径；完全一致返回 null。
 *
 * 只比 shape 的旧断言会漏掉「两侧默认值不同」——例如客户端把 blur 从 18 改成 0、
 * 宿主没改，键集合完全一样却已经分叉。这里逐个叶子比较，并给出路径便于定位。
 *
 * @param a - 期望值（host）。
 * @param b - 实际值（client）。
 * @param at - 当前路径，仅用于报错。
 * @returns 差异描述；无差异时 null。
 */
function firstDifference(a, b, at = '$') {
  if (Object.is(a, b)) return null
  const typeOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value)
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${at}: 类型不同（${typeOf(a)} vs ${typeOf(b)}）`
    if (a.length !== b.length) return `${at}: 数组长度不同（${a.length} vs ${b.length}）`
    for (let index = 0; index < a.length; index += 1) {
      const diff = firstDifference(a[index], b[index], `${at}[${index}]`)
      if (diff !== null) return diff
    }
    return null
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(a, key)) return `${at}.${key}: host 缺少该键`
      if (!Object.prototype.hasOwnProperty.call(b, key)) return `${at}.${key}: client 缺少该键`
      const diff = firstDifference(a[key], b[key], `${at}.${key}`)
      if (diff !== null) return diff
    }
    return null
  }
  return `${at}: 值不同（${JSON.stringify(a)} vs ${JSON.stringify(b)}）`
}

const configDifference = firstDifference(hostDefaults, clientDefaults)
check('宿主与客户端的 defaultConfig() 深度相等（不只看键集合）',
  configDifference === null, configDifference ?? '全部叶子一致')

/* 版本同源：package.json 是唯一真源；客户端缓存键只跟 major.minor，
 * 宿主 /api/ping 则必须回报完整 package 版本。 */
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
check('package.json 版本为 1.0.0', packageJson.version === '1.0.0', String(packageJson.version))

const clientSource = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
const cacheVersion = /const CACHE_VERSION = '([^']+)'/.exec(clientSource)?.[1]
const [packageMajor, packageMinor] = String(packageJson.version).split('.')
check('客户端 CACHE_VERSION 与 package.json 的 major.minor 对齐',
  cacheVersion === `${packageMajor}.${packageMinor}`,
  `CACHE_VERSION=${cacheVersion ?? '(未提取到)'} package=${packageJson.version}`)

let pingResult
try {
  const started = await startHost()
  try {
    const response = await fetch(`${started.origin}/theme-studio/api/ping`)
    pingResult = { status: response.status, body: await response.json().catch(() => null) }
  } finally {
    // host-harness 的 close 会关服务器、还原 DSH_HOME/env 并删除临时目录。
    await started.close()
  }
} catch (error) {
  pingResult = { error: String(error?.message ?? error) }
}
check('宿主 GET /api/ping 返回的 version 与 package.json 一致',
  pingResult?.status === 200 && pingResult.body?.ok === true && pingResult.body?.version === packageJson.version,
  pingResult?.error ?? `status=${pingResult?.status} version=${pingResult?.body?.version}`)

/* 退役键：默认配置不该含 scope / wallpaper.rotate；宿主清理函数必须真能删掉。 */
check('宿主默认配置不含退役顶层键 scope',
  !Object.prototype.hasOwnProperty.call(hostDefaults, 'scope'), Object.keys(hostDefaults).join(','))
check('客户端默认配置不含退役顶层键 scope',
  !Object.prototype.hasOwnProperty.call(clientDefaults, 'scope'), Object.keys(clientDefaults).join(','))
check('两侧默认配置的 wallpaper 都不含退役键 rotate',
  !Object.prototype.hasOwnProperty.call(hostDefaults.wallpaper, 'rotate') &&
    !Object.prototype.hasOwnProperty.call(clientDefaults.wallpaper, 'rotate'),
  Object.keys(hostDefaults.wallpaper).join(','))
check('hasRetiredKeys 能识别 scope 与 wallpaper.rotate',
  host.hasRetiredKeys({ scope: 1, wallpaper: { rotate: {} } }) === true)
check('两侧默认配置都不含任何退役键（hasRetiredKeys 返回 false）',
  host.hasRetiredKeys(hostDefaults) === false && host.hasRetiredKeys(clientDefaults) === false)

const legacyConfig = {
  scope: 1,
  version: 2,
  wallpaper: { rotate: {}, current: 'C:\\wallpaper\\a.png', source: 'folder' },
  glass: { bars: { enabled: true, opacity: 0.5, blur: 8 }, border: 0.6 },
}
const cleanedConfig = host.dropRetiredKeys(legacyConfig)
check('dropRetiredKeys 移除 scope / wallpaper.rotate 并保留其余字段',
  cleanedConfig === legacyConfig &&
    !Object.prototype.hasOwnProperty.call(cleanedConfig, 'scope') &&
    !Object.prototype.hasOwnProperty.call(cleanedConfig.wallpaper, 'rotate') &&
    cleanedConfig.version === 2 &&
    cleanedConfig.wallpaper.source === 'folder' &&
    cleanedConfig.wallpaper.current === 'C:\\wallpaper\\a.png' &&
    cleanedConfig.glass.bars.opacity === 0.5 &&
    cleanedConfig.glass.bars.blur === 8 &&
    cleanedConfig.glass.border === 0.6,
  `keys=${Object.keys(cleanedConfig).join(',')} wallpaper=${Object.keys(cleanedConfig.wallpaper).join(',')}`)

/* 关闭分区：变量与元素选择器都必须一条不剩，而不是把不透明度写成 1 继续盖住 DSH。 */
const glassRegionKeys = Object.keys(clientDefaults.glass)
  .filter((key) => clientDefaults.glass[key] !== null && typeof clientDefaults.glass[key] === 'object')
check('默认配置的玻璃分区键非空（关闭断言的前提）',
  glassRegionKeys.length === 5, glassRegionKeys.join(','))
for (const key of glassRegionKeys) {
  const disabledCss = client.buildCss({
    ...clientDefaults,
    glass: { ...clientDefaults.glass, [key]: { ...clientDefaults.glass[key], enabled: false } },
  })
  const selectors = client.REGION_SELECTORS[key] ?? []
  const leakedSelectors = selectors.filter((selector) => disabledCss.includes(selector))
  const hasToken = disabledCss.includes(`--ds-ts-${key}`)
  check(`关闭分区 ${key} 后不输出 --ds-ts-${key} 与对应分区选择器`,
    selectors.length > 0 && !hasToken && leakedSelectors.length === 0,
    `token=${hasToken} selectors=[${leakedSelectors.join(',')}]`)
}

/* 外壳透明：只有壁纸真的会生效（enabled + source != none）时才允许输出。 */
const shellRule = 'html[data-dsh-theme-studio], html[data-dsh-theme-studio] body { background: transparent !important; }'
const noneCss = client.buildCss({
  ...clientDefaults,
  wallpaper: { ...clientDefaults.wallpaper, source: 'none' },
})
check('wallpaper.source=none 时不输出 html/body 外壳透明规则',
  !noneCss.includes(shellRule),
  noneCss.includes(shellRule) ? '出现了外壳透明规则' : '未出现')

/* 关闭语义：buildCss 本身不返回空串（它只负责编译一份配置），真正的关闭动作
 * 在 ThemeRuntime.apply：撤掉根属性、移除样式、销毁背景层。这里直接验证它。 */
const runtime = new client.ThemeRuntime()
globalThis.document.documentElement.setAttribute('data-dsh-theme-studio', '')
const styleCountBefore = globalThis.document.head.children.length
await runtime.apply({
  ...clientDefaults,
  enabled: false,
  wallpaper: { ...clientDefaults.wallpaper, source: 'folder', current: 'C:\\wallpaper\\a.png' },
})
const rootAttributeAfter = globalThis.document.documentElement['data-dsh-theme-studio']
const styleCountAfter = globalThis.document.head.children.length
check('enabled=false 时运行时撤除根属性且不注入样式（实现定义的关闭语义）',
  rootAttributeAfter === undefined && styleCountAfter === styleCountBefore,
  `attr=${String(rootAttributeAfter)} styleDelta=${styleCountAfter - styleCountBefore}`)

const activeCss = client.buildCss({
  ...clientDefaults,
  wallpaper: { ...clientDefaults.wallpaper, source: 'folder', current: 'C:\\wallpaper\\a.png' },
})
const shellOccurrences = activeCss.split(shellRule).length - 1
check('壁纸生效时外壳透明规则恰好出现 1 次', shellOccurrences === 1, `次数=${shellOccurrences}`)
check('生成的 CSS 里没有裸 html, body { 规则',
  !/^\s*html\s*,\s*body\s*\{/m.test(activeCss),
  (activeCss.match(/^\s*html\s*,\s*body\s*\{.*$/m) ?? [])[0] ?? '(无)')

console.log(process.exitCode === 1 ? '\nCONTRACT FAILED' : '\nCONTRACT OK')
