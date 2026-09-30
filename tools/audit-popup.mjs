/**
 * 审计：插件里所有「弹窗 / 弹层」相关的效果与设置代码，逐条列出并分类。
 *
 * 背景：用户要求「把顶边栏和弹窗的模糊效果及设置相关代码全部删除」，但「弹窗」
 * 在设置页里没有同名卡片，所以先做一次可判定的清点 —— 回答「到底有没有弹窗
 * 相关的残留」，而不是靠猜。
 *
 * 三个层次，缺一不可：
 *   A. 源码层：lib/*.js 里每一行弹窗相关的代码，逐条标 file:line，
 *      并区分「真代码」与「注释」。
 *   B. 生成层：真实物化 bundle 后 buildCss() 到底输出了哪些弹窗相关规则/变量。
 *      —— 源码里有字符串不等于真会生成（可能条件不成立）。
 *   C. 面板层：设置页自己的 CSS 里有没有弹窗相关的模糊（这类最容易漏，
 *      因为它不在 REGION_SELECTORS 表里）。
 *
 * 用法：node tools/audit-popup.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const BUNDLE = path.join(ROOT, 'lib', 'client.js')

/* ══════════════════════════════════════════════════════════════════
 * 判定规则：一个标识符算不算「弹窗相关」
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 每一类都写了「为什么它算弹窗」，避免误伤 —— 比如 `--dsw-elevation-panel`
 * 名字里有 panel，但它只是阴影令牌，属于「公共质感」，不算弹窗专属。
 */
const CATEGORIES = [
  {
    id: 'dialog',
    zh: '弹窗容器（设置弹窗 / 对话框 / 全屏遮罩）',
    patterns: [/VOzbGW_panel/, /VOzbGW_mask/, /_dialog_/, /_float_/, /_mask_/, /_overlay/, /弹窗/, /遮罩/],
  },
  {
    id: 'menu',
    zh: '弹层菜单（下拉 / 悬浮 / Toast）',
    patterns: [/bRhRbq_panel/, /JObwrW_panel/, /mufS8W_card/, /Nqubda_panel/, /ZKlsPq_menu/, /_menu_/, /弹层/, /浮层/],
  },
  {
    id: 'tokens',
    zh: '弹窗/弹层共用的表面令牌覆盖',
    patterns: [
      /--dsw-alias-bg-overlay/,
      /--dsw-alias-bg-layer-[123]\b/,
      /--dsw-specific-tip/,
      /--dsw-specific-selector/,
      /--dsw-specific-menu/,
      /--dsw-mask-blur/,
      /--ds-ts-panel\b/,
      /--ds-ts-menu\b/,
    ],
  },
  {
    id: 'region',
    zh: '分区表里的 panel / menu 两个分区',
    patterns: [/['"]panel['"]/, /['"]menu['"]/, /\bpanel\b/, /\bmenu\b/, /设置界面/, /弹层菜单/],
  },
]

/** 一行命中哪些类别。 */
function classify(text) {
  const hits = []
  for (const category of CATEGORIES) {
    if (category.patterns.some((pattern) => pattern.test(text))) hits.push(category.id)
  }
  return hits
}

/** 是不是注释行（`//`、`*`、`/*`）。 */
function isComment(line) {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

/* ══════════════════════════════════════════════════════════════════
 * A. 源码层
 * ══════════════════════════════════════════════════════════════════ */

const SOURCES = ['lib/client.js', 'lib/index.js']
const sourceFindings = []

for (const relative of SOURCES) {
  const absolute = path.join(ROOT, relative)
  const lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const categories = classify(lines[i])
    if (categories.length === 0) continue
    sourceFindings.push({
      file: relative,
      line: i + 1,
      categories,
      comment: isComment(lines[i]),
      text: lines[i].trim(),
    })
  }
}

console.log('══ A. 源码层：lib/ 里的弹窗相关行 ══\n')
let currentFile = ''
for (const finding of sourceFindings) {
  if (finding.file !== currentFile) {
    currentFile = finding.file
    console.log(`── ${finding.file} ──`)
  }
  const tag = finding.comment ? '注释' : '代码'
  console.log(`  ${String(finding.line).padStart(4)}  [${tag}] [${finding.categories.join(',')}]  ${finding.text.slice(0, 118)}`)
}
const codeLines = sourceFindings.filter((finding) => !finding.comment).length
const commentLines = sourceFindings.length - codeLines
console.log(`\n合计 ${sourceFindings.length} 行：真代码 ${codeLines} 行，纯注释 ${commentLines} 行\n`)

/* ══════════════════════════════════════════════════════════════════
 * B. 生成层：真实跑一遍 buildCss()
 * ══════════════════════════════════════════════════════════════════ */

const makeElement = () => ({
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
  head: makeElement(),
  body: makeElement(),
  documentElement: makeElement(),
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
  useMemo: (fn) => fn(),
  createContext: () => ({}),
}

const registrations = []
globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
await import(`file://${BUNDLE.replace(/\\/g, '/')}`)
const client = registrations[0].factory((name) => {
  if (name === 'react') return React
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Switch: () => null }
  throw new Error(`unexpected require("${name}")`)
})

/** 最激进的场景：所有分区都开、都半透明，任何弹窗规则都会现形。 */
const config = client.defaultConfig()
for (const key of Object.keys(config.glass)) {
  if (typeof config.glass[key] === 'object' && config.glass[key] !== null) {
    config.glass[key] = { ...config.glass[key], enabled: true, opacity: 0.5, blur: 20 }
  }
}
config.wallpaper = { ...config.wallpaper, source: 'folder', fixed: 'x.png' }
const css = client.buildCss(config)

/** 把 CSS 文本切成规则块：{ selector, body }。 */
function parseRules(text) {
  const lines = text.split('\n')
  const rules = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trimEnd().endsWith('{')) continue
    let start = i
    while (start > 0 && !lines[start - 1].includes('}') && !lines[start - 1].includes('{')) start--
    const selector = lines.slice(start, i + 1).join(' ').replace(/\s+/g, ' ').trim()
    const body = []
    for (let j = i + 1; j < lines.length && lines[j].trim() !== '}'; j++) body.push(lines[j].trim())
    rules.push({ selector, body })
  }
  return rules
}

const rules = parseRules(css)
console.log(`══ B. 生成层：buildCss() 输出 ${rules.length} 条规则（全分区开启 + 半透明）══\n`)

const popupRules = rules.filter((rule) => classify(rule.selector).length > 0)
console.log(`其中「选择器本身是弹窗/弹层元素」的规则 ${popupRules.length} 条：`)
for (const rule of popupRules) {
  const blur = rule.body.filter((line) => line.includes('backdrop-filter')).join(' ')
  console.log(`  · ${rule.selector.slice(0, 200)}`)
  console.log(`      ${rule.body.join(' ').slice(0, 150)}${blur ? '' : ''}`)
}

/* 令牌覆盖：这些不写在选择器里，但对弹窗生效。 */
const tokenLines = css
  .split('\n')
  .map((line, index) => ({ line: line.trim(), no: index + 1 }))
  .filter((item) => classify(item.line).length > 0 && item.line.includes('--dsw'))
console.log(`\n对弹窗生效的令牌覆盖 ${tokenLines.length} 行：`)
for (const item of tokenLines) console.log(`  ${String(item.no).padStart(4)}  ${item.line}`)

/* ══════════════════════════════════════════════════════════════════
 * C. 面板层：设置页自己的 CSS 里有没有模糊
 * ══════════════════════════════════════════════════════════════════ */

const clientSource = fs.readFileSync(BUNDLE, 'utf8')
const panelCssMatch = /const PANEL_CSS = `([\s\S]*?)`\n/.exec(clientSource)
const panelCss = panelCssMatch === null ? '' : panelCssMatch[1]
const panelBlur = panelCss
  .split('\n')
  .map((line, index) => ({ line: line.trim(), no: index + 1 }))
  .filter((item) => item.line.includes('backdrop-filter') || item.line.includes('filter:'))
const panelBase = clientSource.slice(0, clientSource.indexOf('const PANEL_CSS')).split('\n').length

console.log(`\n══ C. 面板层：PANEL_CSS 里自带 filter 的行（位于设置弹窗内部）══\n`)
for (const item of panelBlur) {
  console.log(`  PANEL_CSS 第 ${item.no} 行（client.js ≈ ${panelBase + item.no}）：${item.line.slice(0, 150)}`)
}
if (panelBlur.length === 0) console.log('  （无）')

/* ══════════════════════════════════════════════════════════════════
 * D. 设置项层：面板里哪些控件写的是弹窗参数
 * ══════════════════════════════════════════════════════════════════ */

console.log(`\n══ D. 设置项层：REGIONS 表 ══\n`)
const regionSource = /const REGIONS = \[([\s\S]*?)\n    \]/.exec(clientSource)
for (const line of (regionSource?.[1] ?? '').split('\n')) {
  if (line.trim().length === 0) continue
  console.log(`  ${line.trim()}`)
}

console.log(`\n══ 结论 ══`)
console.log(`  A 源码层：${codeLines} 行真代码 / ${commentLines} 行注释与弹窗相关`)
console.log(`  B 生成层：${popupRules.length} 条规则 + ${tokenLines.length} 行令牌覆盖对弹窗生效`)
console.log(`  C 面板层：PANEL_CSS 里 ${panelBlur.length} 处 blur`)
console.log(`  D 设置项层：REGIONS 表 ${client.REGIONS === undefined ? '(未导出，按源码统计)' : ''}`)
