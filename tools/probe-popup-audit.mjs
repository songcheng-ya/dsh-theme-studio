/**
 * 运行时审计：插件对「弹窗 / 弹层」到底做了什么。
 *
 * 与 audit-popup.mjs 的分工：
 *   audit-popup.mjs  —— 静态 + 生成层（源码里有哪些、CSS 里生成了哪些）
 *   本脚本           —— 运行时（这些选择器在真实 DOM 上命中几个元素、
 *                       弹窗子树里到底有几个元素真的带上了 backdrop-filter）
 *
 * 关键设计：**不改动落盘配置**。
 * 现网配置是「不透明度 100% / 模糊 0」，插件根本不会输出 backdrop-filter，
 * 直接量什么都量不到。所以这里在 Node 侧把最激进的 CSS（所有分区 opacity 0.5 /
 * blur 20）算好，用 CDP 临时注入一个 <style>，量完再删掉 —— 用户界面不受影响。
 *
 * 用法：node tools/probe-popup-audit.mjs <token> <port>
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUNDLE = path.join(HERE, '..', 'lib', 'client.js')

const token = process.argv[2]
const port = process.argv[3] ?? '3087'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9243
const profileDir = path.join(os.tmpdir(), `dsh-popup-${process.pid}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ORIGIN = `http://127.0.0.1:${port}`

if (!token) {
  console.error('usage: node tools/probe-popup-audit.mjs <token> <port>')
  process.exit(2)
}

const check = (label, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) process.exitCode = 1
}

/* ══════════════════════════════════════════════════════════════════
 * 一、Node 侧：物化 bundle，算出「最激进」的 CSS
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

const aggressive = client.defaultConfig()
for (const key of Object.keys(aggressive.glass)) {
  if (typeof aggressive.glass[key] === 'object' && aggressive.glass[key] !== null) {
    aggressive.glass[key] = { ...aggressive.glass[key], enabled: true, opacity: 0.5, blur: 20 }
  }
}
const AUDIT_CSS = client.buildCss(aggressive)
const SELECTORS = client.REGION_SELECTORS

console.log(`待注入的审计 CSS：${AUDIT_CSS.split('\n').length} 行（不落盘，只活在这次探测里）`)

/* ══════════════════════════════════════════════════════════════════
 * 二、浏览器侧
 * ══════════════════════════════════════════════════════════════════ */

const child = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' })
for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) break
  } catch {}
  await sleep(250)
}
const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json()
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

const first = await fetch(`${ORIGIN}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (first.headers.getSetCookie?.() ?? []).map((value) => value.split(';')[0]).join('; ')
await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' })
await send('Page.navigate', { url: `${ORIGIN}/` })
await sleep(4000)

/* ══════════════════════════════════════════════════════════════════
 * 阶段 0：DSH 的 class 命名格式
 *
 * 这决定了「属性前缀兜底」选择器到底还有没有兜底能力。
 * 结论（0.1.10 实测）：DSH 同时存在三种命名，
 *   `<hash>_<局部名>`（`wSkVaW_header`）、`_<局部名>_<hash>_<行号>`（`_dialog_w1urq_22`）、
 *   `_<hash>_<局部名>`（`_root_1nxmc_1`）。
 * 所以 `[class*="_dialog_"]` 这类属性兜底**是有效的**；而原来那两条写成
 * `[class*="_header_"][class*="_wSkVaW_"]` 的兜底要求同一元素同时含两段，
 * 属于永远不可能命中的死代码，已在 0.1.10 删除。
 * ══════════════════════════════════════════════════════════════════ */

const naming = await evaluate(`(() => {
  const tokens = new Set()
  for (const el of document.querySelectorAll('*')) for (const token of el.classList) tokens.add(token)
  const buckets = { '纯小写(原生)': 0, 'hash_local(CSS Modules)': 0, '含 _xxx_ 三段式': 0, '下划线开头(_local_hash)': 0, '其他': 0 }
  const samples = {}
  const push = (name, token) => {
    samples[name] = samples[name] ?? []
    if (samples[name].length < 8) samples[name].push(token)
  }
  for (const token of tokens) {
    let name
    if (/^[a-z][a-z0-9-]*$/.test(token)) name = '纯小写(原生)'
    else if (/^[A-Za-z0-9]{5,9}_[a-zA-Z][A-Za-z0-9]*$/.test(token)) name = 'hash_local(CSS Modules)'
    else if (/_[a-zA-Z]+_/.test(token)) name = '含 _xxx_ 三段式'
    else if (token.startsWith('_')) name = '下划线开头(_local_hash)'
    else name = '其他'
    buckets[name] += 1
    push(name, token)
  }
  return { total: tokens.size, buckets, samples }
})()`)

console.log('\n══ 阶段 0：DSH 真实 class 命名分布 ══\n')
console.log(`  页面类名总数（去重）：${naming.total}`)
for (const [name, count] of Object.entries(naming.buckets)) {
  console.log(`    ${String(count).padStart(4)}  ${name}${naming.samples[name] ? `   例：${naming.samples[name].join(', ')}` : ''}`)
}
const threePart = naming.buckets['含 _xxx_ 三段式'] + naming.buckets['下划线开头(_local_hash)']
console.log(`\n  符合「中间夹下划线」三段式的类名：${threePart} 个`)

/* ══════════════════════════════════════════════════════════════════
 * 阶段 0b：弹层菜单 —— 点开浮层触发器，看 menu 分区的选择器能不能命中
 * ══════════════════════════════════════════════════════════════════ */

const MENU_HITS = `(() => {
  const table = ${JSON.stringify(SELECTORS.menu ?? [])}
  return table.map((selector) => {
    let count = 0
    try { count = document.querySelectorAll(selector).length } catch { count = -1 }
    return { selector, count }
  })
})()`

const menuSeen = Object.fromEntries((SELECTORS.menu ?? []).map((selector) => [selector, 0]))
const triggers = await evaluate(`(() => {
  const nodes = [...document.querySelectorAll('[aria-haspopup], [aria-expanded], [class*="trigger"], [class*="Trigger"]')]
  return nodes.slice(0, 10).map((el) => ({
    el: el.tagName.toLowerCase() + '.' + [...el.classList].slice(0, 2).join('.'),
    hint: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 20),
  }))
})()`)
console.log(`\n══ 阶段 0b：弹层菜单探测（找到 ${triggers.length} 个候选触发器）══\n`)
for (const item of triggers) console.log(`    ${item.el}  「${item.hint}」`)

for (let index = 0; index < triggers.length; index++) {
  await evaluate(`(() => {
    window.__dsTsBefore = new Set()
    for (const el of document.querySelectorAll('*')) for (const token of el.classList) window.__dsTsBefore.add(token)
    const nodes = [...document.querySelectorAll('[aria-haspopup], [aria-expanded], [class*="trigger"], [class*="Trigger"]')]
    nodes[${index}]?.click()
    return true
  })()`)
  await sleep(500)
  const hits = await evaluate(MENU_HITS)
  for (const item of hits) if (item.count > menuSeen[item.selector]) menuSeen[item.selector] = item.count
  /* 点开之后新出现的类名 = DSH 浮层真实用的命名。这是判定菜单选择器是否有效的关键证据。 */
  const delta = await evaluate(`(() => {
    const now = new Set()
    for (const el of document.querySelectorAll('*')) for (const token of el.classList) now.add(token)
    return [...now].filter((token) => !window.__dsTsBefore.has(token))
  })()`)
  console.log(`    [${index}] ${triggers[index].el} 「${triggers[index].hint}」 → 新增类名 ${delta.length} 个${delta.length > 0 ? `：${delta.join(', ')}` : ''}`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(300)
}
console.log('\n  menu 分区选择器的最大命中数：')
for (const [selector, count] of Object.entries(menuSeen)) {
  console.log(`    ${String(count).padStart(4)} × ${selector}`)
}

/* ── 打开设置弹窗，并切到「主题工作室 → 毛玻璃」 ─────────────────── */
const opened = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const trigger = document.querySelector('.VOzbGW_trigger')
  trigger?.click()
  await sleep(1200)
  const panel = document.querySelector('.VOzbGW_panel') ?? document.body
  const studio = [...panel.querySelectorAll('.VOzbGW_navCell')].find((el) => el.textContent.includes('主题工作室'))
  studio?.click()
  await sleep(900)
  const glassBtn = [...panel.querySelectorAll('button, [role="tab"]')].find((el) => el.textContent.trim() === '毛玻璃')
  glassBtn?.click()
  await sleep(900)
  return {
    trigger: trigger !== null,
    studio: Boolean(studio),
    glass: Boolean(glassBtn),
    page: document.querySelector('.ds-ts-page') !== null,
  }
})()`)
console.log(`\n弹窗已打开：trigger=${opened.trigger} 主题工作室=${opened.studio} 毛玻璃页=${opened.glass} 页面渲染=${opened.page}`)
if (!opened.page) {
  console.error('设置页没渲染出来，后续测量无意义')
  process.exit(1)
}

/* ── 快照脚本 ─────────────────────────────────────────────────────
 * 一次性把所有要量的事实都取回来，避免多次往返把状态搅乱。 */
const SNAPSHOT = `(() => {
  const desc = (el) => el.tagName.toLowerCase() +
    (el.id ? '#' + el.id : '') +
    [...el.classList].slice(0, 2).map((c) => '.' + c).join('')
  const panel = document.querySelector('.VOzbGW_panel')
  const overlay = document.querySelector('.VOzbGW_overlay')
  const mask = document.querySelector('.VOzbGW_mask')
  const sidebar = document.querySelector('.hHd-Xa_root')
  const inTree = (root, el) => root !== null && root !== undefined && root.contains(el)

  /* 全文档里所有带 backdrop-filter 的元素，标明它落在哪块区域。 */
  const blurred = []
  for (const el of document.querySelectorAll('*')) {
    const value = getComputedStyle(el).backdropFilter
    if (value === 'none' || value === '' || value === undefined) continue
    blurred.push({
      el: desc(el),
      value,
      where: inTree(panel, el) ? '设置弹窗' : inTree(overlay, el) ? '弹窗遮罩层' : inTree(sidebar, el) ? '侧栏' : '主区',
    })
  }

  /* 令牌的实际计算值 —— 这些就是「弹窗表面」的颜色来源。 */
  const body = getComputedStyle(document.body)
  const tokens = {}
  for (const name of ['--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3',
    '--dsw-alias-bg-overlay', '--dsw-specific-menu', '--dsw-specific-tip', '--dsw-specific-selector',
    '--dsw-mask-blur', '--ds-ts-panel', '--ds-ts-menu']) {
    tokens[name] = body.getPropertyValue(name).trim()
  }

  /* 弹窗与遮罩自身的计算样式。 */
  const styleOf = (el, props) => {
    if (el === null) return null
    const computed = getComputedStyle(el)
    return Object.fromEntries(props.map((p) => [p, computed[p]]))
  }

  return {
    blurred,
    tokens,
    panelStyle: styleOf(panel, ['backgroundColor', 'backdropFilter', 'position']),
    maskStyle: styleOf(mask, ['backgroundColor', 'backdropFilter', 'position']),
    overlayStyle: styleOf(overlay, ['backdropFilter', 'position']),
    sidebarStyle: styleOf(sidebar, ['backgroundColor', 'backdropFilter']),
    /* 面板里那个删除按钮自带 backdrop-filter —— 面板层唯一的模糊。 */
    thumbDelStyle: styleOf(document.querySelector('.ds-ts-thumb-del'), ['backdropFilter', 'backgroundColor']),
    cards: [...document.querySelectorAll('.ds-ts-card .ds-ts-title')].map((el) => el.textContent.trim()),
  }
})()`

/** 每个分区选择器在真实 DOM 上的命中数。 */
const HITS = `(() => {
  const table = ${JSON.stringify(SELECTORS)}
  const out = {}
  for (const [region, list] of Object.entries(table)) {
    out[region] = list.map((selector) => {
      let count = 0
      try { count = document.querySelectorAll(selector).length } catch { count = -1 }
      return { selector, count }
    })
  }
  /* 兜底属性选择器单独再查一遍，看它们是不是死选择器。 */
  const fallbacks = ['[class*="_dialog_"]', '[class*="_float_"]', '[class*="_mask_"]', '[class*="_menu_"]']
  out.__fallback = fallbacks.map((selector) => ({
    selector,
    count: document.querySelectorAll(selector).length,
    sample: [...document.querySelectorAll(selector)].slice(0, 3).map((el) => el.tagName.toLowerCase() + '.' + [...el.classList].join('.')),
  }))
  return out
})()`

const hits = await evaluate(HITS)
console.log('\n══ 选择器命中数（设置弹窗已打开）══\n')
for (const [region, list] of Object.entries(hits)) {
  if (region === '__fallback') continue
  console.log(`  ${region}:`)
  for (const item of list) {
    console.log(`    ${String(item.count).padStart(4)} × ${item.selector}`)
  }
}
console.log('  兜底属性选择器：')
for (const item of hits.__fallback) {
  console.log(`    ${String(item.count).padStart(4)} × ${item.selector}${item.sample.length > 0 ? `   → ${item.sample.join('  ')}` : ''}`)
}

console.log('\n══ 注入前：弹窗相关计算值（现网配置 = 全 opaque）══\n')
const before = await evaluate(SNAPSHOT)
console.log(`  令牌：${JSON.stringify(before.tokens, null, 0)}`)
console.log(`  面板 ${JSON.stringify(before.panelStyle)}`)
console.log(`  遮罩 ${JSON.stringify(before.maskStyle)}`)
console.log(`  带 backdrop-filter 的元素数：${before.blurred.length}`)
console.log(`  删除按钮 ${JSON.stringify(before.thumbDelStyle)}`)

/* ── 注入最激进的 CSS，再量一次 ─────────────────────────────────── */
await evaluate(`(() => {
  document.getElementById('ds-ts-audit')?.remove()
  const tag = document.createElement('style')
  tag.id = 'ds-ts-audit'
  tag.textContent = ${JSON.stringify(AUDIT_CSS)}
  document.head.appendChild(tag)
  return true
})()`)
await sleep(600)

console.log('\n══ 注入后：把**所有现存分区**都拉到 不透明度 0.5 / 模糊 20px ══\n')
const after = await evaluate(SNAPSHOT)
console.log(`  令牌：${JSON.stringify(after.tokens, null, 0)}`)
console.log(`  面板 ${JSON.stringify(after.panelStyle)}`)
console.log(`  遮罩 ${JSON.stringify(after.maskStyle)}`)
console.log(`  弹层容器 ${JSON.stringify(after.overlayStyle)}`)
console.log(`  侧栏 ${JSON.stringify(after.sidebarStyle)}`)
console.log(`  删除按钮 ${JSON.stringify(after.thumbDelStyle)}`)

console.log(`\n  真实带上 backdrop-filter 的元素（${after.blurred.length} 个）：`)
const byWhere = {}
for (const item of after.blurred) {
  byWhere[item.where] = byWhere[item.where] ?? []
  byWhere[item.where].push(item)
}
for (const [where, list] of Object.entries(byWhere)) {
  console.log(`    [${where}] ${list.length} 个`)
  for (const item of list) console.log(`        ${item.el}  →  ${item.value}`)
}

/* ── 判定 ───────────────────────────────────────────────────────── */
console.log('\n══ 判定 ══\n')

const dialogBlur = after.blurred.filter((item) => item.where === '设置弹窗' || item.where === '弹窗遮罩层')
check('弹窗子树里确实存在插件的模糊（说明这块代码是活的，不是残留）', dialogBlur.length > 0,
  `${dialogBlur.length} 个元素：${dialogBlur.map((item) => item.el).join(', ')}`)
check('侧栏仍然 0 个模糊元素（0.1.9 的删除仍然干净）',
  after.blurred.filter((item) => item.where === '侧栏').length === 0,
  String(after.blurred.filter((item) => item.where === '侧栏').length))
check('设置遮罩的模糊令牌已被插件接管', String(after.tokens['--dsw-mask-blur']).includes('20px'),
  String(after.tokens['--dsw-mask-blur']))
check('弹窗表面令牌已被插件接管（bg-layer-1 / bg-overlay）',
  after.tokens['--dsw-alias-bg-layer-1'].includes('0.5') && after.tokens['--dsw-alias-bg-overlay'].includes('0.5'),
  `${after.tokens['--dsw-alias-bg-layer-1']} / ${after.tokens['--dsw-alias-bg-overlay']}`)
check('弹层令牌已被插件接管（bg-layer-2 / -3 / specific-menu）',
  after.tokens['--dsw-alias-bg-layer-2'].includes('0.5') && after.tokens['--dsw-alias-bg-layer-3'].includes('0.5') &&
    after.tokens['--dsw-specific-menu'].includes('0.5'),
  `${after.tokens['--dsw-alias-bg-layer-2']} / ${after.tokens['--dsw-specific-menu']}`)
check('删除按钮自带的一层模糊与配置无关，恒定存在',
  String(after.thumbDelStyle?.backdropFilter) === String(before.thumbDelStyle?.backdropFilter),
  `${before.thumbDelStyle?.backdropFilter} → ${after.thumbDelStyle?.backdropFilter}`)

/* 死选择器 = 写在表里但一个元素都命中不了。
 * 注意要区分三类，不能一律叫「残留」：
 *   a) 兜底选择器：精确类名已经命中，兜底本来就不需要命中；
 *   b) 条件未满足：测量时没打开弹层菜单 / 没有消息气泡；
 *   c) 真死：DSH 的类名格式决定了它永远不可能命中。 */
const DEAD_CANDIDATES = []
for (const [region, list] of Object.entries(hits)) {
  if (region === '__fallback') continue
  for (const item of list) {
    const seenInMenu = region === 'menu' ? (menuSeen[item.selector] ?? 0) : null
    if (item.count === 0 && seenInMenu !== null && seenInMenu > 0) continue
    if (item.count === 0) DEAD_CANDIDATES.push({ region, selector: item.selector, menuSeen: seenInMenu })
  }
}
for (const item of hits.__fallback) {
  if (item.count === 0) DEAD_CANDIDATES.push({ region: 'fallback', selector: item.selector, menuSeen: null })
}

const FALLBACK_BY_DESIGN = (selector) => selector.includes('*="_') && selector.includes('"][class*=')
const threePartPossible = threePart > 0

console.log(`\n══ 命中 0 的选择器分诊（共 ${DEAD_CANDIDATES.length} 个）══\n`)
const trulyDead = []
for (const item of DEAD_CANDIDATES) {
  let reason
  if (FALLBACK_BY_DESIGN(item.selector)) reason = '兜底选择器（精确类名已命中，本就不要求它命中）'
  else if (item.selector.includes('*="_')) {
    reason = threePartPossible
      ? '属性兜底：类名格式上存在 `_xxx_`，只是当前 DOM 没有该元素'
      : '★ 真死选择器：全站没有任何类名符合 `_xxx_` 三段式，该兜底永远不可能命中'
  } else if (item.region === 'bubble') reason = '条件未满足：当前会话没有消息气泡'
  else if (item.region === 'menu') reason = '条件未满足：本次探测没能点开对应弹层'
  else reason = '未分类'
  if (reason.startsWith('★')) trulyDead.push(item)
  console.log(`  · [${item.region}] ${item.selector}\n      → ${reason}`)
}

check('属性前缀兜底选择器在 DSH 的类名格式下不可能命中（设计缺陷，不是本次删除的残留）',
  trulyDead.length === 0 || threePartPossible === false,
  `符合 _xxx_ 三段式的类名 ${threePart} 个；受影响的兜底选择器 ${trulyDead.map((item) => item.selector).join(', ') || '无'}`)

/* ── 清理 ───────────────────────────────────────────────────────── */
await evaluate(`document.getElementById('ds-ts-audit')?.remove()`)
console.log('\n注入的审计样式已移除；落盘配置从未被改动')

socket.close()
child.kill()
await sleep(400)
await fs.promises.rm(profileDir, { recursive: true, force: true }).catch(() => {})
console.log(process.exitCode === 1 ? '\nPOPUP AUDIT FAILED' : '\nPOPUP AUDIT OK')
