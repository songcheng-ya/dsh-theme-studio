/**
 * 验收探针：「分区命中自检」的报告在**真实浏览器**里的呈现（0.1.18 起）。
 *
 * 这一版修的是**渲染与判据**，所以静态断言不算数，必须在实况 DOM 上量。
 * 要证的五件事：
 *
 *   1. 打开面板 → 运行自检，报告能出来，每个分区一行（`命中数 / 总数` + 状态）；
 *   2. **「弹层菜单」显示中性色的「正常」，不是红色的「未命中」**（修掉的误报）；
 *   3. **空会话里「气泡 0 / 2」同样是中性灰**（0.1.19 修掉的同类误报）；
 *   4. 展开后 **6 条选择器全部可见、且没有一条被省略号截断**（修掉的截断）；
 *   5. **真的发一条消息**，断言「气泡」从「正常(灰)」翻成「命中(绿)」——
 *      这既证明 `.Sixlwa_bubble` 这个选择器没写错，也证明条件分区的着色是活的。
 *
 * 第 4 点的判据不能只看「文本在不在」——文本一直在，是被 `text-overflow: ellipsis`
 * 画掉了。所以逐条量：`scrollWidth <= clientWidth` 才算真的显示完整。
 *
 * ⚠️ 本探针会**在当前会话里发送一条测试消息**（内容是「自检探针测试」）。
 * 那是用户的真实 profile，验证完请手动删掉那个会话。
 *
 * 用法：node tools/probe-diag-report.mjs <token> <port>
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const token = process.argv[2]
const port = process.argv[3] ?? '3087'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9247
const profileDir = path.join(os.tmpdir(), `dsh-diag-report-${process.pid}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ORIGIN = `http://127.0.0.1:${port}`

if (!token) {
  console.error('usage: node tools/probe-diag-report.mjs <token> <port>')
  process.exit(2)
}

const check = (label, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) process.exitCode = 1
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
await sleep(4000)

/* ── 判定 1：自检报告 ───────────────────────────────────────────────
 *
 * 顺序很重要：**先在刚建的空白会话里跑一次**（气泡必须是中性灰），
 * 再发一条消息重跑（气泡必须转绿）。判定 0b / 判定 1 就按这个顺序来。
 */

const ran = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  document.querySelector('.VOzbGW_trigger')?.click()
  await sleep(1200)
  const panel = document.querySelector('.VOzbGW_panel') ?? document.body
  const studio = [...panel.querySelectorAll('.VOzbGW_navCell')].find((el) => el.textContent.includes('主题工作室'))
  studio?.click()
  await sleep(900)
  const tab = [...document.querySelectorAll('.ds-ts-tabs button')].find((el) => el.textContent.trim() === '其他')
  tab?.click()
  await sleep(700)
  const card = [...document.querySelectorAll('.ds-ts-card')]
    .find((el) => el.querySelector('.ds-ts-title')?.textContent?.trim() === '分区命中自检')
  card?.querySelector('header .ds-ts-btn')?.click()
  await sleep(400)
  const run = [...(card?.querySelectorAll('.ds-ts-btn') ?? [])].find((el) => el.textContent.trim() === '运行自检')
  run?.click()
  await sleep(600)
  return { card: Boolean(card), ran: Boolean(run), rows: document.querySelectorAll('.ds-ts-diag-row').length }
})()`)
check('自检卡片能展开并点到「运行自检」', ran.card && ran.ran, JSON.stringify(ran))
check('运行自检后每个分区一行', ran.rows === 4, `rows=${ran.rows}`)

const readReport = () => evaluate(`(() => {
  const rows = [...document.querySelectorAll('.ds-ts-diag-row')].map((row) => {
    const status = row.querySelector('.ds-ts-diag-status')
    return {
      zh: row.querySelector('.ds-ts-diag-name')?.textContent?.trim() ?? '?',
      count: row.querySelector('.ds-ts-diag-count')?.textContent?.trim() ?? '?',
      status: status?.textContent?.trim() ?? '?',
      tone: status?.dataset?.tone ?? '?',
      color: status === null ? '?' : getComputedStyle(status).color,
      expanded: row.querySelector('.ds-ts-diag-head')?.getAttribute('aria-expanded') ?? '?',
    }
  })
  return { rows, summary: document.querySelector('.ds-ts-diag .ds-ts-hint')?.textContent?.trim() ?? '' }
})()`)

const show = (title, report) => {
  console.log(`\n自检报告（${title}）：`)
  for (const row of report.rows) {
    console.log(`    ${row.zh.padEnd(6, '　')} ${row.count.padEnd(7)} ${row.status}  tone=${row.tone}  color=${row.color}`)
  }
  console.log(`    摘要：${report.summary}`)
}

/* ── 判定 0b：**空会话**里气泡必须是中性色（本次新修的点）──────────
 *
 * 刚建的新会话里没有用户消息，`.Sixlwa_bubble` 一个都不存在。
 * 早先这会被标成红色的「未命中」—— 和「弹层菜单」一模一样的误报。
 *
 * ⚠️ 这里必须**刷新页面重开设置**，不能只关掉弹窗。第一版为了关弹窗直接
 * `document.querySelector('.VOzbGW_overlay').remove()`，把 React 的挂载点从 DOM 里
 * 抽走了而状态没变 —— 之后 `document.querySelector('.VOzbGW_panel')` 变成 null，
 * 弹窗再也打不开（实测就是这么挂的）。刷新最省事，也最接近用户的真实操作。 */

await send('Page.reload', {})
await sleep(4500)

const fresh = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const newChat = document.querySelector('.hHd-Xa_newSession')
    ?? [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === '新会话')
  if (newChat === null || newChat === undefined) return { ok: false }
  newChat.click()
  await sleep(2500)
  return { ok: true, bubbles: document.querySelectorAll('.Sixlwa_bubble').length }
})()`)
check('★ 建一个全新的空会话（里面没有用户消息）', fresh.ok && fresh.bubbles === 0, JSON.stringify(fresh))

/* 刷新后自检报告没了，得重新点出来（顺带证明这条路径可以重复走）。 */
const rerunCheck = (label) => evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const panel = document.querySelector('.VOzbGW_panel')
  if (panel === null) {
    document.querySelector('.VOzbGW_trigger')?.click()
    await sleep(1200)
  }
  const scope = document.querySelector('.VOzbGW_panel') ?? document.body
  ;[...scope.querySelectorAll('.VOzbGW_navCell')].find((el) => el.textContent.includes('主题工作室'))?.click()
  await sleep(900)
  ;[...document.querySelectorAll('.ds-ts-tabs button')].find((el) => el.textContent.trim() === '其他')?.click()
  await sleep(700)
  const card = [...document.querySelectorAll('.ds-ts-card')]
    .find((el) => el.querySelector('.ds-ts-title')?.textContent?.trim() === '分区命中自检')
  if (card?.querySelector('.ds-ts-body') === null) card?.querySelector('header .ds-ts-btn')?.click()
  await sleep(400)
  ;[...(card?.querySelectorAll('.ds-ts-btn') ?? [])].find((el) => el.textContent.trim() === '运行自检')?.click()
  await sleep(600)
  return { label: ${JSON.stringify(label)}, rows: document.querySelectorAll('.ds-ts-diag-row').length }
})()`)

const emptyRun = await rerunCheck('空会话')
check('空会话里能跑出 4 行自检报告', emptyRun.rows === 4, JSON.stringify(emptyRun))

const emptySession = await readReport()
show('刚新建的空会话，折叠态', emptySession)
const emptyBubble = emptySession.rows.find((row) => row.zh === '气泡')
check('★ 空会话里「气泡 0 / 2」是中性灰「正常」，不是红色「未命中」',
  emptyBubble !== undefined && emptyBubble.status === '正常' && emptyBubble.tone === 'soft',
  JSON.stringify(emptyBubble))
check('★ 空会话里没有任何分区被标红',
  emptySession.rows.every((row) => row.tone !== 'warn'),
  emptySession.rows.filter((row) => row.tone === 'warn').map((row) => row.zh).join(',') || '无')
check('空会话的摘要不会吓人（不出现「毛玻璃已失效」）',
  !emptySession.summary.includes('毛玻璃已失效'), emptySession.summary)

/* ── 判定 1：真的发一条消息，气泡必须转绿 ─────────────────────────
 *
 * ⚠️ 打字前必须**真的把设置弹窗关掉**。第二版栽在这里：只调 `input.focus()`
 * 就以为可以输入了，但遮罩还在最上层，CDP 的鼠标点击落在遮罩上 ——
 * `insertText` 打进去的字是空的（实测 `输入的字=""`），消息根本没发出去。
 * 用 ESC 关（和用户按 ESC 一样），并且**断言弹窗真的没了**再开始打字。 */

let closed = false
for (let attempt = 0; attempt < 3 && !closed; attempt++) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, key: 'Escape', code: 'Escape' })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, key: 'Escape', code: 'Escape' })
  await sleep(900)
  closed = (await evaluate(`document.querySelector('.VOzbGW_overlay') === null && document.querySelector('.VOzbGW_panel') === null`)) === true
}
check('★ 用 ESC 关掉设置弹窗（否则点击会被遮罩吃掉）', closed)

const composer = await evaluate(`(() => {
  const input = document.querySelector('.uV2eYG_input[contenteditable=true]')
    ?? document.querySelector('.uV2eYG_card [contenteditable=true]')
  if (input === null || input === undefined) return { stage: 'no-composer' }
  const box = input.getBoundingClientRect()
  return {
    stage: 'focused', before: document.querySelectorAll('.Sixlwa_bubble').length,
    x: Math.round(box.x + 20), y: Math.round(box.y + Math.round(box.height / 2)),
  }
})()`)
if (composer.stage !== 'focused') {
  check('★ 聚焦输入框并发送一条测试消息', false, JSON.stringify(composer))
} else {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: composer.x, y: composer.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: composer.x, y: composer.y, button: 'left', clickCount: 1 })
  await sleep(300)
  await send('Input.insertText', { text: '自检探针测试' })
  await sleep(500)
  const typed = await evaluate(`document.querySelector('.uV2eYG_input')?.textContent ?? ''`)
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter' })
  await send('Input.dispatchKeyEvent', { type: 'char', text: '\\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter' })
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    if ((await evaluate(`document.querySelectorAll('.Sixlwa_bubble').length`)) > 0) break
  }
  const sent = await evaluate(`(() => {
    const bubbles = [...document.querySelectorAll('.Sixlwa_bubble')]
    return { count: bubbles.length, first: bubbles[0]?.textContent?.trim()?.slice(0, 24) ?? '',
             rows: document.querySelectorAll('.Sixlwa_userRow').length }
  })()`)
  console.log(`\n气泡验证（新会话里发一条消息）：输入的字="${typed}" 发送后=${JSON.stringify(sent)}`)
  check('★ 发一条消息后 .Sixlwa_bubble 真的出现 —— 选择器没写错，气泡是条件渲染的',
    typed === '自检探针测试' && sent.count > 0, JSON.stringify(sent))

  /* 重新跑自检（会话现在有消息了），气泡必须转绿。 */
  const filledRun = await rerunCheck('有消息')
  check('发完消息后能重跑自检', filledRun.rows === 4, JSON.stringify(filledRun))

  const collapsed = await readReport()
  show('有消息的会话，折叠态', collapsed)

  const menuRow = collapsed.rows.find((row) => row.zh === '弹层菜单')
  check('★「弹层菜单」显示为「正常」而不是「未命中」',
    menuRow !== undefined && menuRow.status === '正常', JSON.stringify(menuRow))
  check('★「弹层菜单」用中性色（tone=soft），不是红色告警',
    menuRow?.tone === 'soft', `tone=${menuRow?.tone} color=${menuRow?.color}`)
  check('★ 有消息后「气泡」转为命中并标绿',
    collapsed.rows.find((row) => row.zh === '气泡')?.tone === 'ok',
    JSON.stringify(collapsed.rows.find((row) => row.zh === '气泡')))
  check('此时没有任何分区被标红（本次没有真故障）',
    collapsed.rows.every((row) => row.tone !== 'warn'),
    collapsed.rows.filter((row) => row.tone === 'warn').map((row) => row.zh).join(',') || '无')
  check('摘要说明「弹层菜单 0 命中是设计如此」',
    collapsed.summary.includes('弹层菜单') && collapsed.summary.includes('设计如此'), collapsed.summary)

  const detailWhenCollapsed = await evaluate(`document.querySelectorAll('.ds-ts-diag-sel').length`)
  check('未展开时看不到选择器明细（默认紧凑）',
    collapsed.rows.every((row) => row.expanded === 'false') && detailWhenCollapsed === 0,
    `aria-expanded=${collapsed.rows.map((row) => row.expanded).join(',')} 明细数=${detailWhenCollapsed}`)
}

/* ── 判定 2：展开后 6 条选择器全部完整可见（截断的回归点）───────── */

const expanded = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // 展开前必须确认「弹层菜单」这一行是收起的 —— 它可能已经被上一次展开过了。
  const row = [...document.querySelectorAll('.ds-ts-diag-row')]
    .find((el) => el.querySelector('.ds-ts-diag-name')?.textContent?.trim() === '弹层菜单')
  if (row === undefined) return { items: [], note: '', missing: true }
  const head = row.querySelector('.ds-ts-diag-head')
  if (head.getAttribute('aria-expanded') !== 'true') {
    head.click()
    await sleep(500)
  }
  const items = [...row.querySelectorAll('.ds-ts-diag-sel')].map((el) => {
    const box = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return {
      text: el.textContent.trim(),
      // 截断的**唯一**可靠判据：内容宽度超过可见宽度（此时 ellipsis 才画得出来）
      overflowX: Math.round(el.scrollWidth - el.clientWidth),
      clipped: style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap',
      whiteSpace: style.whiteSpace,
      wrap: style.overflowWrap,
      width: Math.round(box.width),
      height: Math.round(box.height),
    }
  })
  return { items, note: row.querySelector('.ds-ts-diag-note')?.textContent?.trim() ?? '' }
})()`)
console.log('\n展开「弹层菜单」的明细：')
for (const item of expanded.items) {
  console.log(`    ${item.text.padEnd(24)} 可见宽 ${item.width}px 高 ${item.height}px  溢出 ${item.overflowX}px  white-space=${item.whiteSpace}`)
}
console.log(`    解释：${expanded.note}`)

check('★ 展开后 6 条选择器一条不少', expanded.items.length === 6, `${expanded.items.length} 条`)
check('★ 没有任何一条被省略号截断（scrollWidth 不超 clientWidth）',
  expanded.items.every((item) => item.overflowX <= 0),
  expanded.items.filter((item) => item.overflowX > 0).map((item) => `${item.text}+${item.overflowX}px`).join(' ') || '全部完整')
check('★ 明细已脱离 nowrap + ellipsis 那条规则',
  expanded.items.every((item) => !item.clipped && item.whiteSpace !== 'nowrap' && item.wrap === 'anywhere'),
  [...new Set(expanded.items.map((item) => `${item.whiteSpace}/${item.wrap}`))].join(' '))
check('0 命中时给出「靠令牌覆盖」的解释',
  expanded.note.includes('令牌覆盖'), expanded.note)

/* ── 判定 3：窄面板不能撑出横向滚动，长选择器要能换行 ─────────────
 *
 * 截断故障的根因就是「宽度不够」。这里把面板压窄（模拟小窗口），
 * 长选择器必须换行而不是溢出。 */

const narrow = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const page = document.querySelector('.ds-ts-page')
  const before = page.style.maxWidth
  page.style.maxWidth = '320px'
  await sleep(400)
  const row = [...document.querySelectorAll('.ds-ts-diag-row')]
    .find((el) => el.querySelector('.ds-ts-diag-name')?.textContent?.trim() === '弹层菜单')
  const items = [...row.querySelectorAll('.ds-ts-diag-sel')].map((el) => ({
    text: el.textContent.trim(),
    overflowX: Math.round(el.scrollWidth - el.clientWidth),
    height: Math.round(el.getBoundingClientRect().height),
  }))
  const scroll = { page: page.scrollWidth - page.clientWidth, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth }
  page.style.maxWidth = before
  return { items, scroll }
})()`)
console.log('\n面板压到 320px 宽时的明细：')
for (const item of narrow.items) console.log(`    ${item.text.padEnd(24)} 溢出 ${item.overflowX}px  高 ${item.height}px`)
check('★ 面板压窄后长选择器换行显示、不横向溢出',
  narrow.items.every((item) => item.overflowX <= 0),
  narrow.items.filter((item) => item.overflowX > 0).map((item) => `${item.text}+${item.overflowX}px`).join(' ') || '全部不溢出')
check('★ 窄面板下也没有把整页撑出横向滚动条',
  narrow.scroll.page <= 1 && narrow.scroll.doc <= 1, JSON.stringify(narrow.scroll))

await send('Page.captureScreenshot', {}).then(async (shot) => {
  await fs.promises.writeFile(path.join('tools', 'diag-report-live.png'), Buffer.from(shot.data, 'base64'))
}).catch(() => {})

/* ── 收尾 ───────────────────────────────────────────────────────── */

socket.close()
child.kill()
await sleep(400)
await fs.promises.rm(profileDir, { recursive: true, force: true }).catch(() => {})
console.log(process.exitCode === 1 ? '\nDIAG REPORT PROBE FAILED' : '\nDIAG REPORT PROBE OK')
