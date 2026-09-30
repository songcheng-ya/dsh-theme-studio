/**
 * 验收探针（运行时）：删掉最后一张候选之后，背景层**多快**从 DOM 里消失。
 *
 * 为什么单独写一个：`probe-background-restore.mjs` 只断言了「等 2.5 秒之后配置是 none」，
 * **没有量时间**，也**没有逐步采样**。用户报障说「界面没有立刻重绘」——
 * 那说明当时确实有一段时间背景还挂着。这个探针把「最后一次点击 → 图层消失」
 * 的延迟量出来，并断言它在一个明确的阈值内。
 *
 * 顺带覆盖两种删法（用户可能都用）：
 *   A. 逐张点候选图上的 ✕ 直到 0 张；
 *   B. 直接删掉整条「已登记目录」记录（候选列表会立刻变空）。
 *
 * 用法：node tools/probe-bg-latency.mjs <token> <port>
 *
 * ⚠️ **这个探针改过真实配置两次，改它之前先读这段。**
 *
 * 第一次：备份在写操作**之后**才取，于是备份里存的是被自己污染过的快照，
 * 「还原」把临时目录写了回去，用户的 `Pictures` 从配置里消失。
 * 第二次：B 场景会把「已登记目录」**整条删掉**，而收尾用 `put({wallpaper: PRistine.wallpaper})`
 * 还原 —— `deepMerge` 用的是 `out[key] = deepMerge(base[key], patch[key])`，
 * 数组会被**整体替换**，所以这一句本该把 `folders` 恢复成快照里的值。
 * 但快照本身在第一轮之后就已经是空的了（上一轮的 B 把它清空了），于是「还原空」= 继续空，
 * 探针还报 OK。**两次都是同一个病根：把「跑完会还原」当成了保证，而不是去断言它。**
 *
 * 现在的规矩：
 *   1. `PRistine` 在**第一次写操作之前**取，只取一次，之后绝不再读；
 *   2. B 场景只删**我自己登记的**临时目录 —— 快照里本来没有它，删掉它是还原的一部分，
 *      这样即使快照再次被污染，污染源也只可能是这个临时目录（收尾一定会去掉它）；
 *   3. 收尾把配置恢复成**初始快照**（不是「合并」），并断言 `wallpaper` 逐字段相等；
 *      断言里额外打印初始快照，让「空对空」这种无鉴别力的通过一眼可见。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configGuard } from './lib/config-guard.mjs'

const token = process.argv[2]
const port = process.argv[3] ?? '3087'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9257
const profileDir = path.join(os.tmpdir(), `dsh-bg-latency-${process.pid}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ORIGIN = `http://127.0.0.1:${port}`
const API = `${ORIGIN}/theme-studio/api`

/** 延迟阈值（毫秒）：超过它就认为「不是立刻」。给足一帧 + effect + apply 的余量。 */
const BUDGET_MS = 1500

if (token === undefined) {
  console.error('usage: node tools/probe-bg-latency.mjs <token> <port>')
  process.exit(2)
}

const check = (label, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) process.exitCode = 1
}
const json = async (url, init) => {
  const response = await fetch(url, init)
  return { status: response.status, body: await response.json().catch(() => null) }
}
const put = (patch) => json(`${API}/config`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
})

/* ⚠️ 配置托管：快照 → 体检 → （无论成功失败都）还原 + 断言。
 * 护栏的来历见 tools/lib/config-guard.mjs 的头注释（探针改坏过真实配置三次）。 */
const guard = configGuard({ api: API, json })
const PRistine = await guard.snapshot()
console.log(`初始快照：folders=${JSON.stringify(PRistine.wallpaper?.folders)} source=${PRistine.wallpaper?.source}`)
const sanity = guard.assertSane()
if (!sanity.ok) {
  console.error(`\n拒绝继续：\n  ${sanity.reason}`)
  process.exit(1)
}

/* 只有 2 张图的临时目录，让「删空」这件事快且确定。 */
const tinyDir = path.join(os.tmpdir(), `dsh-bg-latency-${process.pid}`)
fs.mkdirSync(tinyDir, { recursive: true })
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
for (const name of ['a.png', 'b.png']) fs.writeFileSync(path.join(tinyDir, name), PNG)

const child = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' })
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) break } catch {}
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
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
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

await put({ enabled: true, wallpaper: { folders: [tinyDir], recursive: false, source: 'folder', fixed: '', current: '' } })
const first = await fetch(`${ORIGIN}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (first.headers.getSetCookie?.() ?? []).map((v) => v.split(';')[0]).join('; ')
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
await send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' })
await send('Page.navigate', { url: `${ORIGIN}/` })
await sleep(4500)

const openPanel = () => evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  if (document.querySelector('.ds-ts-page') === null) {
    document.querySelector('.VOzbGW_trigger')?.click(); await sleep(1200)
    const panel = document.querySelector('.VOzbGW_panel') ?? document.body
    ;[...panel.querySelectorAll('.VOzbGW_navCell')].find((el) => el.textContent.includes('主题工作室'))?.click()
    await sleep(900)
    ;[...document.querySelectorAll('.ds-ts-tabs button')].find((el) => el.textContent.trim() === '壁纸')?.click()
    await sleep(1500)
  }
  for (let i = 0; i < 20; i++) { await sleep(300); if (document.querySelectorAll('.ds-ts-thumb').length > 0) break }
  return document.querySelectorAll('.ds-ts-thumb').length
})()`)

/**
 * 在页面里采样：从「点击最后一行的 ✕」那一刻起，每 50ms 记一次背景层在不在。
 * 全在浏览器里跑，避免 CDP 往返把延迟量歪。
 * @param selector - 触发删除的方式：'thumb' 点最后一张候选的 ✕；'folder' 删登记目录。
 */
const measure = (mode) => evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const present = () => document.querySelector('#dsh-theme-studio-bg') !== null
  const samples = []
  const t0 = performance.now()
  if (${JSON.stringify(mode)} === 'thumb') {
    const thumbs = [...document.querySelectorAll('.ds-ts-thumb')]
    thumbs[thumbs.length - 1].querySelector('.ds-ts-thumb-del')?.click()
  } else {
    /* B 场景：删掉「已登记目录」那一行的「移除」按钮。
     * 只点**我自己登记的临时目录**那一行 —— 绝不去碰用户登记的目录
     * （上一版是随便 pop 一个，等于拿用户的配置做实验）。
     * 注意：这段在 JS 模板字符串里，注释中不能出现反引号。 */
    const rows = [...document.querySelectorAll('.ds-ts-list li')]
    const row = rows.find((li) => (li.querySelector('.ds-ts-mono')?.textContent ?? '').includes(${JSON.stringify(tinyDir)}))
      ?? rows.find((li) => li.querySelector('.ds-ts-btn[data-variant=danger]') !== null)
    row?.querySelector('.ds-ts-btn[data-variant=danger]')?.click()
  }
  for (let i = 0; i < 80; i++) {
    samples.push({ t: Math.round(performance.now() - t0), present: present(), thumbs: document.querySelectorAll('.ds-ts-thumb').length })
    if (!present() && i > 1) break
    await sleep(50)
  }
  return { samples, thumbs: document.querySelectorAll('.ds-ts-thumb').length, source: document.querySelector('select')?.value ?? '?' }
})()`)

/* ── A. 逐张 ✕ 删空 ─────────────────────────────────────────────── */

console.log(`\n[A] 逐张点 ✕ 删空（临时目录 2 张：${tinyDir}）`)
console.log(`  候选数 = ${await openPanel()}`)
await evaluate(`document.querySelector('.ds-ts-thumb-pick')?.click()`)
await sleep(2500)
const startState = await evaluate(`({ present: document.querySelector('#dsh-theme-studio-bg') !== null })`)
check('选中一张后背景层在', startState.present === true)

/* 先删掉「非最后一张」，不留观测噪声；再对最后一张做带时序的测量。 */
const beforeLast = await evaluate(`(() => {
  const thumbs = [...document.querySelectorAll('.ds-ts-thumb')]
  if (thumbs.length > 1) thumbs[0].querySelector('.ds-ts-thumb-del')?.click()
  return thumbs.length
})()`)
await sleep(1500)
console.log(`  先删掉一张（原有 ${beforeLast} 张），剩 ${await evaluate(`document.querySelectorAll('.ds-ts-thumb').length`)} 张`)

const resultA = await measure('thumb')
const gone = resultA.samples.find((sample) => !sample.present)
console.log('  采样（点击后 ms → 背景层在不在）：' + resultA.samples.slice(0, 12).map((s) => `${s.t}:${s.present ? '在' : '没了'}`).join('  '))
check('★★ A：删掉最后一张后背景层从 DOM 消失', gone !== undefined, gone === undefined ? '采样 4 秒内始终存在' : `于第 ${gone.t}ms 消失`)
check('★★ A：延迟在预算内（立即重绘）',
  gone !== undefined && gone.t <= BUDGET_MS, gone === undefined ? '从未消失' : `${gone.t}ms（预算 ${BUDGET_MS}ms）`)
check('A：候选墙也同步清空', resultA.thumbs === 0, `剩 ${resultA.thumbs} 张`)

/* ── B. 删掉整条已登记目录记录 ──────────────────────────────────── */

console.log('\n[B] 重新登记目录 → 选中 → 删掉整条目录记录')
await put({ wallpaper: { folders: [tinyDir], recursive: false, source: 'folder', fixed: '', current: '' } })
await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const card = [...document.querySelectorAll('.ds-ts-card')]
    .find((el) => el.querySelector('.ds-ts-title')?.textContent?.trim() === '壁纸候选')
  ;[...(card?.querySelectorAll('.ds-ts-btn') ?? [])].find((el) => el.textContent.trim() === '重新扫描')?.click()
  await sleep(2500)
})()`)
await sleep(800)
const thumbsB = await evaluate(`document.querySelectorAll('.ds-ts-thumb').length`)
check('B：重新登记后候选回来了', thumbsB === 2, `${thumbsB} 张`)
await evaluate(`document.querySelector('.ds-ts-thumb-pick')?.click()`)
await sleep(2500)
check('B：选中后背景层在', (await evaluate(`document.querySelector('#dsh-theme-studio-bg') !== null`)) === true)

const resultB = await measure('folder')
const goneB = resultB.samples.find((sample) => !sample.present)
console.log('  采样：' + resultB.samples.slice(0, 12).map((s) => `${s.t}:${s.present ? '在' : '没了'}`).join('  '))
check('★ B：删掉登记目录后背景层消失', goneB !== undefined, goneB === undefined ? '采样 4 秒内始终存在' : `于第 ${goneB.t}ms 消失`)
check('★ B：延迟在预算内', goneB !== undefined && goneB.t <= BUDGET_MS, goneB === undefined ? '从未消失' : `${goneB.t}ms`)

/* ── 收尾 ───────────────────────────────────────────────────────── */

await fs.promises.rm(tinyDir, { recursive: true, force: true }).catch(() => {})
const restored = await guard.restore()
console.log(`\n配置还原：${restored.ok ? 'OK' : '★失败★'} — ${restored.detail}`)
check('★★ 配置已还原成初始快照（folders / source / fixed 都不许变）', restored.ok, restored.detail)

socket.close(); child.kill(); await sleep(300)
await fs.promises.rm(profileDir, { recursive: true, force: true }).catch(() => {})
console.log(process.exitCode === 1 ? '\nBG LATENCY PROBE FAILED' : '\nBG LATENCY PROBE OK')
