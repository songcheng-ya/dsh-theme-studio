/**
 * 打印某个分区在给定参数下生成的 CSS 规则，用于人工核对。
 *
 * 用法：node tools/show-region-css.mjs [region] [opacity] [blur]
 *   例：node tools/show-region-css.mjs input 0.58 20
 *
 * region 取 REGION_SELECTORS 的键：chat / input / bubble / panel / menu。
 * （`sidebar` 0.1.9 删、`topbar` 0.1.12 删，传它们只会打印空结果。）
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.join(HERE, '..', 'lib', 'client.js')

const region = process.argv[2] ?? 'input'
const opacity = Number(process.argv[3] ?? 0.55)
const blur = Number(process.argv[4] ?? 18)

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

const config = client.defaultConfig()
if (config.glass[region] !== undefined) {
  config.glass[region] = { enabled: true, opacity, blur }
}
const css = client.buildCss(config)

console.log(`分区 ${region} · 不透明度 ${opacity} · 模糊 ${blur}px`)
console.log('选择器：', JSON.stringify(client.REGION_SELECTORS[region]))
console.log('\n--- 命中的规则 ---')
const selectors = client.REGION_SELECTORS[region] ?? []
const lines = css.split('\n')
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes(`.hHd-Xa_root`)) console.log(`[根容器] ${lines[i].trim()}`)
}

/* 选择器列表是多行输出（每个选择器一行，最后一行带 {），逐个找出规则块。 */
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].trim().endsWith('{')) continue
  // 往上收集同一个选择器列表
  let start = i
  while (start > 0 && !lines[start - 1].trim().endsWith('}') && !lines[start - 1].includes('{')) start--
  const head = lines.slice(start, i + 1).join(' ').trim()
  if (!selectors.some((selector) => head.includes(selector))) continue
  const body = []
  for (let j = i + 1; j < lines.length && lines[j].trim() !== '}'; j++) body.push(lines[j].trim())
  console.log(`\n[分区规则] ${head}`)
  for (const line of body) console.log(`    ${line}`)
}

console.log('\n--- 全文里是否出现侧栏子元素自带底色 ---')
const hasChildBackground = css
  .split('\n')
  .filter((line) => line.includes('hHd-Xa_root > *') )
console.log(hasChildBackground.length > 0 ? hasChildBackground.join('\n') : '（无）')
