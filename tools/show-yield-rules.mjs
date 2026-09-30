/**
 * 一次性核对脚本：把与「侧栏让位规则」有关的输出直接打出来。
 *
 * 回答一个具体问题：`:has(.VOzbGW_overlay) … { backdrop-filter: none }` 这条规则
 * （0.1.7 为绕开「backdrop-filter 吃 fixed」而加的让位方案）是否还在生成的 CSS 里。
 *
 * 做法：把**所有分区都开到半透明**再生成 CSS（这是最可能触发让位规则的条件），
 * 然后逐条打印含 `:has(` 与含 `backdrop-filter` 的规则。
 *
 * 用法：node tools/show-yield-rules.mjs
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.join(HERE, '..', 'lib', 'client.js')

/* 最小桩，只为把 bundle 物化出来。 */
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

/* ── 全部分区开到半透明 ─────────────────────────────────────────── */

const defaults = client.defaultConfig()
const allOn = {
  ...defaults,
  glass: {
    ...Object.fromEntries(Object.keys(defaults.glass)
      .filter((key) => typeof defaults.glass[key] === 'object')
      .map((key) => [key, { enabled: true, opacity: 0.5, blur: 20, saturation: 1.3 }])),
    border: 0.6,
    highlight: 0.5,
  },
}
const css = client.buildCss(allOn)

/* 把多行选择器列表 + 规则体归并成一条条规则 */
const rules = []
let buffer = ''
for (const line of css.split('\n')) {
  buffer += (buffer === '' ? '' : '\n') + line
  if (line.trimEnd().endsWith('}')) {
    rules.push(buffer)
    buffer = ''
  }
}

console.log(`分区键：${Object.keys(client.REGION_SELECTORS).join(', ')}`)
console.log(`生成规则总数：${rules.length}\n`)

console.log('── 含 :has( 的规则 ──')
const hasRules = rules.filter((rule) => rule.includes(':has('))
if (hasRules.length === 0) console.log('  （无）')
for (const rule of hasRules) console.log(`  ${rule.split('\n')[0].trim()}`)

console.log('\n── 含 backdrop-filter 的规则 ──')
for (const rule of rules.filter((rule) => rule.includes('backdrop-filter'))) {
  const selector = rule.split('\n')[0].trim().replace(/^html\[data-dsh-theme-studio\]\s*/, '')
  const filter = /backdrop-filter: ([^;]+);/.exec(rule)?.[1] ?? '?'
  console.log(`  blur 值=${filter.padEnd(32)} 选择器=${selector}`)
}

console.log('\n── 结论 ──')
const yieldRule = css.includes(':has(.VOzbGW_overlay)')
const noneRule = css.includes('backdrop-filter: none')
const sidebarSel = css.includes('.hHd-Xa')
console.log(`  含 :has(.VOzbGW_overlay) 让位规则：${yieldRule ? '是' : '否'}`)
console.log(`  含 backdrop-filter: none：      ${noneRule ? '是' : '否'}`)
console.log(`  含 .hHd-Xa 选择器：             ${sidebarSel ? '是' : '否'}`)
process.exitCode = yieldRule || noneRule || sidebarSel ? 1 : 0
