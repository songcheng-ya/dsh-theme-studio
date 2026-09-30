/**
 * 侦察：写「边栏」（侧边栏 + 顶边栏）毛玻璃之前必须先量准的事实。
 *
 * 为什么需要它：这两个分区已经失败过三次（子元素模糊无效 / 根容器模糊把设置弹窗
 * 锁进 280×807 / 控件与膜分层造成「断层」）。重写方案能不能成立，取决于几个
 * 只能实测的 CSS 事实：
 *
 *   1. **谁是 `position: fixed` 的包含块**。`backdrop-filter`（以及 filter / transform /
 *      contain:paint / will-change）会让元素成为 fixed 后代的包含块，而设置弹窗
 *      `.VOzbGW_overlay` 就渲染在侧栏子树内部 —— 这是 0.1.7 把弹窗锁进侧栏的根因。
 *      要确认侧栏/顶边栏的祖先链上**现在**没有这类属性。
 *   2. **元素自身的 position / z-index / overflow / isolation**。决定能不能用
 *      「伪元素承担膜 + 模糊」这个新方案：伪元素不是 fixed 元素的祖先，
 *      所以它带 backdrop-filter 绝不会困住弹窗。
 *   3. **背景链**：谁在给侧栏/顶边栏铺实色。伪元素要能采到壁纸，
 *      从它往上到壁纸之间就不能有实色层。
 *
 * 用法：node tools/scout-bars.mjs <token> <port>
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const token = process.argv[2]
const port = process.argv[3] ?? '3087'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9249
const profileDir = path.join(os.tmpdir(), `dsh-scout-bars-${process.pid}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ORIGIN = `http://127.0.0.1:${port}`

if (!token) {
  console.error('usage: node tools/scout-bars.mjs <token> <port>')
  process.exit(2)
}

/* ── 浏览器 ─────────────────────────────────────────────────────── */

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
for (let i = 0; i < 120; i++) {
  await sleep(250)
  if (await evaluate(`document.querySelector('#root')?.children.length > 0`).catch(() => false)) break
}
await sleep(2500)

/* 进一个会话并打开设置弹窗：两件事都会改变 DOM，侦察必须在最终形态下做。 */
await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const rows = [...document.querySelectorAll('[class*="sessionRow"]')]
  const real = rows.filter((n) => !(n.textContent || '').includes('新会话'))[0] ?? rows[0]
  real?.click()
  await sleep(3500)
  return true
})()`)

/* ── 侧栏内部「自带实色背景」的元素 ────────────────────────────────
 *
 * 「边栏」分区只把 `.pI_x6G_sidebarCol` 与 `.hHd-Xa_root` 两层置为透明。
 * 侧栏里**任何别的元素**如果自带不透明底色，都会在磨砂之上留下一块实色 ——
 * 这正是「侧栏下方出现异常白块」这类报障的成因。这里把它们全列出来。 */
const internals = await evaluate(`(() => {
  const sidebar = document.querySelector('.hHd-Xa_root')
  if (sidebar === null) return { error: '找不到侧栏' }
  const desc = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    [...el.classList].map((c) => '.' + c).join('')
  const alphaOf = (value) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(value)
    if (m === null) return null
    const parts = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number)
    return parts.length >= 4 ? parts[3] : 1
  }
  const rows = []
  for (const el of [sidebar, ...sidebar.querySelectorAll('*')]) {
    const cs = getComputedStyle(el)
    const alpha = alphaOf(cs.backgroundColor)
    const hasImage = cs.backgroundImage !== 'none'
    if ((alpha === null || alpha < 0.02) && !hasImage) continue
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    rows.push({
      node: desc(el),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      bg: cs.backgroundColor,
      alpha,
      hasImage,
      position: cs.position,
      zIndex: cs.zIndex,
    })
  }
  rows.sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])

  /* 侧栏直接子节点的几何：白块落在哪一段一眼能看出来。 */
  const children = [...sidebar.children].map((el) => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return { node: desc(el), rect: [Math.round(r.y), Math.round(r.height)], bg: cs.backgroundColor, overflow: cs.overflow }
  })
  const sr = sidebar.getBoundingClientRect()
  return {
    sidebarRect: [Math.round(sr.x), Math.round(sr.y), Math.round(sr.width), Math.round(sr.height)],
    children,
    opaque: rows,
  }
})()`)

console.log('\n══ 侧栏内部的实色背景元素 ══')
if (internals.error) {
  console.log(`  ${internals.error}`)
} else {
  console.log(`  侧栏 ${JSON.stringify(internals.sidebarRect)}`)
  console.log('  直接子节点：')
  for (const child of internals.children) {
    console.log(`    y=${String(child.rect[0]).padStart(4)} h=${String(child.rect[1]).padStart(4)}  ${child.node.padEnd(30)} 底色=${child.bg}  overflow=${child.overflow}`)
  }
  console.log(`  自带底色的元素（${internals.opaque.length} 个，按 y 排序）：`)
  for (const item of internals.opaque) {
    console.log(`    y=${String(item.rect[1]).padStart(4)} h=${String(item.rect[3]).padStart(4)} x=${String(item.rect[0]).padStart(4)} w=${String(item.rect[2]).padStart(4)}  α=${String(item.alpha).padEnd(5)} ${item.hasImage ? '有图层 ' : '       '} ${item.node}`)
  }
}

/* ── 截图：眼见为实，也方便与用户截图对照 ────────────────────────── */
const shot = await send('Page.captureScreenshot', { format: 'png' })
const shotPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), 'bars-live.png')
fs.writeFileSync(decodeURIComponent(shotPath), Buffer.from(shot.data, 'base64'))
console.log(`\n截图已保存：${decodeURIComponent(shotPath)}`)

const report = await evaluate(`(() => {
  const CREATORS = ['transform', 'filter', 'backdropFilter', 'perspective', 'contain', 'willChange', 'containerType', 'contentVisibility']
  const desc = (el) => el === null ? '(无)' : el.tagName.toLowerCase() +
    (el.id ? '#' + el.id : '') + [...el.classList].map((c) => '.' + c).join('')
  const facts = (el) => {
    if (el === null) return null
    const cs = getComputedStyle(el)
    const creating = CREATORS.filter((p) => {
      const v = cs[p]
      if (v === undefined || v === null) return false
      if (p === 'contain') return /paint|layout|strict|content/.test(v)
      if (p === 'willChange') return /transform|filter|perspective/.test(v)
      if (p === 'contentVisibility') return v !== 'visible'
      if (p === 'containerType') return v !== 'normal'
      return v !== 'none'
    })
    const r = el.getBoundingClientRect()
    return {
      node: desc(el),
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      position: cs.position,
      zIndex: cs.zIndex,
      isolation: cs.isolation,
      overflow: cs.overflow,
      display: cs.display,
      borderRadius: cs.borderRadius,
      backgroundColor: cs.backgroundColor,
      backgroundImage: cs.backgroundImage === 'none' ? 'none' : '有图层',
      creatingContainingBlock: creating,
    }
  }
  const TARGETS = ['.pI_x6G_frame', '.pI_x6G_sidebarCol', '.hHd-Xa_root', '.wSkVaW_root', '.wSkVaW_header', '.pI_x6G_centerCol']
  const nodes = {}
  for (const selector of TARGETS) nodes[selector] = facts(document.querySelector(selector))

  /* 设置弹窗的祖先链：确认它到底挂在谁下面，以及链上有没有包含块制造者。 */
  const overlay = document.querySelector('.VOzbGW_overlay')
  const overlayChain = []
  for (let n = overlay; n && n !== document.documentElement; n = n.parentElement) {
    const cs = getComputedStyle(n)
    const creating = CREATORS.filter((p) => {
      const v = cs[p]
      if (v === undefined || v === null) return false
      if (p === 'contain') return /paint|layout|strict|content/.test(v)
      if (p === 'willChange') return /transform|filter|perspective/.test(v)
      if (p === 'contentVisibility') return v !== 'visible'
      if (p === 'containerType') return v !== 'normal'
      return v !== 'none'
    })
    overlayChain.push({ node: desc(n), position: cs.position, zIndex: cs.zIndex, overflow: cs.overflow, creating })
  }

  /* 侧栏的直接子节点：伪元素要压在它们下面，得知道它们是什么。 */
  const sidebar = document.querySelector('.hHd-Xa_root')
  const sidebarChildren = sidebar === null ? [] : [...sidebar.children].map((el) => {
    const cs = getComputedStyle(el)
    return { node: desc(el), position: cs.position, zIndex: cs.zIndex, backgroundColor: cs.backgroundColor }
  })

  /* 顶边栏的直接子节点。 */
  const header = document.querySelector('.wSkVaW_header')
  const headerChildren = header === null ? [] : [...header.children].map((el) => {
    const cs = getComputedStyle(el)
    return { node: desc(el), position: cs.position, zIndex: cs.zIndex, backgroundColor: cs.backgroundColor }
  })

  const body = getComputedStyle(document.body)
  return {
    viewport: [innerWidth, innerHeight],
    nodes,
    overlayChain,
    sidebarChildren,
    headerChildren,
    overlayInSidebar: sidebar !== null && overlay !== null ? sidebar.contains(overlay) : null,
    tokens: {
      sidebarFill: body.getPropertyValue('--dsw-specific-sidebar-fill').trim(),
      bgBase: body.getPropertyValue('--dsw-alias-bg-base').trim(),
      frame: body.getPropertyValue('--ds-ts-frame').trim(),
    },
  }
})()`)

console.log(`\n视口 ${JSON.stringify(report.viewport)}   弹窗在侧栏子树内 = ${report.overlayInSidebar}`)
console.log(`令牌：--dsw-specific-sidebar-fill=${report.tokens.sidebarFill}  --dsw-alias-bg-base=${report.tokens.bgBase}  --ds-ts-frame=${report.tokens.frame}`)

console.log('\n══ 关键元素的事实 ══')
for (const [selector, fact] of Object.entries(report.nodes)) {
  if (fact === null) { console.log(`\n${selector}  →  (页面上没有)`); continue }
  console.log(`\n${selector}`)
  console.log(`  实际节点 ${fact.node}  rect=${JSON.stringify(fact.rect)}`)
  console.log(`  position=${fact.position}  z-index=${fact.zIndex}  isolation=${fact.isolation}  overflow=${fact.overflow}  display=${fact.display}`)
  console.log(`  底色=${fact.backgroundColor}  图层=${fact.backgroundImage}  border-radius=${fact.borderRadius}`)
  console.log(`  ★ 包含块制造者：${fact.creatingContainingBlock.length === 0 ? '（无 —— 安全）' : fact.creatingContainingBlock.join(', ')}`)
}

console.log('\n══ 设置弹窗的祖先链（从 .VOzbGW_overlay 往上）══')
for (const item of report.overlayChain) {
  console.log(`  ${item.node.padEnd(38)} position=${String(item.position).padEnd(9)} z-index=${String(item.zIndex).padEnd(6)} overflow=${String(item.overflow).padEnd(8)} 包含块制造者=${item.creating.length === 0 ? '无' : item.creating.join(',')}`)
}

console.log('\n══ 侧栏的直接子节点 ══')
for (const item of report.sidebarChildren) {
  console.log(`  ${item.node.padEnd(38)} position=${String(item.position).padEnd(9)} z-index=${String(item.zIndex).padEnd(6)} 底色=${item.backgroundColor}`)
}

console.log('\n══ 顶边栏的直接子节点 ══')
for (const item of report.headerChildren) {
  console.log(`  ${item.node.padEnd(38)} position=${String(item.position).padEnd(9)} z-index=${String(item.zIndex).padEnd(6)} 底色=${item.backgroundColor}`)
}

socket.close()
child.kill()
await sleep(400)
await fs.promises.rm(profileDir, { recursive: true, force: true }).catch(() => {})
console.log('\nSCOUT BARS DONE')
