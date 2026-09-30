/**
 * 验收探针（运行时）：「移除」一个登记目录之后，它**真的从宿主配置里消失**。
 *
 * 用户报障：「打开后会强制加载 C:\Users\<用户名>\Pictures 这个路径下的图片文件，
 * 并且无法移除」。根因是 `removeFolder` 里两次 `persist` 互相取消：
 *   persist({ folders: [] })            ← 排队 350ms
 *   restoreOriginalBackground()         ← 里面又 persist(...) → clearTimeout 掉上一句
 * 于是「移除目录」这一笔**从来没发给宿主**，刷新就回来，看起来「移不掉」。
 *
 * 这个探针钉的就是那一条：点「移除」之后，去**宿主的 /api/config** 读，
 * 确认 `folders` 真的空了、`source` 变成 none，而且**再刷新一次仍然如此**。
 *
 * 用法：node tools/probe-folder-remove.mjs <token> <port>
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configGuard } from './lib/config-guard.mjs'

const token = process.argv[2]
const port = process.argv[3] ?? '3087'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9259
const profileDir = path.join(os.tmpdir(), `dsh-folder-remove-${process.pid}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ORIGIN = `http://127.0.0.1:${port}`
const API = `${ORIGIN}/theme-studio/api`

if (token === undefined) {
  console.error('usage: node tools/probe-folder-remove.mjs <token> <port>')
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
const hostConfig = async () => (await json(`${API}/config`)).body?.config ?? {}

/* ── 配置托管（快照 → 体检 → 崩溃也还原 → 还原后断言）────────────── */
const guard = configGuard({ api: API, json })
const PRistine = await guard.snapshot()
console.log(`初始快照：folders=${JSON.stringify(PRistine.wallpaper?.folders)} source=${PRistine.wallpaper?.source}`)
const sanity = guard.assertSane()
if (!sanity.ok) {
  console.error(`\n拒绝继续：\n  ${sanity.reason}`)
  process.exit(1)
}

/* 两个临时目录：一个用来删、一个留着，验证「删一个不影响另一个」。 */
const tmpRoot = path.join(os.tmpdir(), `dsh-folder-remove-${process.pid}`)
const dirA = path.join(tmpRoot, 'keep-me')
const dirB = path.join(tmpRoot, 'remove-me')
fs.mkdirSync(dirA, { recursive: true })
fs.mkdirSync(dirB, { recursive: true })
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
fs.writeFileSync(path.join(dirA, 'a.png'), PNG)
fs.writeFileSync(path.join(dirB, 'b.png'), PNG)

/* ── 浏览器 ─────────────────────────────────────────────────────── */

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
const warnings = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.consoleAPICalled') {
    const text = (message.params.args ?? []).map((a) => a.value ?? '').join(' ')
    if (text.includes('同一帧内有两笔配置写入')) warnings.push(text)
  }
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

await guard.run(async () => {
  await put({ enabled: true, wallpaper: { folders: [dirA, dirB], recursive: false, source: 'folder', fixed: '', current: '' } })
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

  const thumbs = await openPanel()
  check('两个目录都被扫出候选', thumbs === 2, `${thumbs} 张`)

  /* 点「remove-me」那一行的「移除」。只点我自己造的那一行。 */
  const removed = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const rows = [...document.querySelectorAll('.ds-ts-list li')]
    const row = rows.find((li) => (li.querySelector('.ds-ts-mono')?.textContent ?? '').includes(${JSON.stringify(dirB)}))
    if (row === undefined) return { ok: false, stage: 'no-row', rows: rows.map((li) => li.querySelector('.ds-ts-mono')?.textContent ?? '') }
    const button = [...row.querySelectorAll('button')].find((el) => el.textContent.trim() === '移除')
    if (button === undefined) return { ok: false, stage: 'no-button' }
    button.click()
    await sleep(2500)
    return {
      ok: true,
      remainingRows: [...document.querySelectorAll('.ds-ts-list li')].map((li) => li.querySelector('.ds-ts-mono')?.textContent ?? ''),
      thumbs: document.querySelectorAll('.ds-ts-thumb').length,
      status: document.querySelector('.ds-ts-ok, .ds-ts-err, .ds-ts-warn')?.textContent?.trim() ?? '',
    }
  })()`)
  console.log(`\n点「移除」之后：${JSON.stringify(removed)}`)
  check('点得到「移除」按钮', removed.ok === true, JSON.stringify(removed))

  /* ★ 关键断言：宿主配置里那个目录必须真的没了。 */
  const afterRemove = await hostConfig()
  const folders = afterRemove.wallpaper?.folders ?? []
  check('★★ 宿主配置里「remove-me」已消失（这就是「无法移除」的回归点）',
    !folders.includes(dirB), JSON.stringify(folders))
  check('★ 另一个目录还在（只删点中的那一个）', folders.includes(dirA), JSON.stringify(folders))
  check('★ 界面上那一行也没了', !(removed.remainingRows ?? []).some((row) => row.includes(dirB)),
    JSON.stringify(removed.remainingRows))
  check('★ 候选墙只剩另一个目录的图', removed.thumbs === 1, `${removed.thumbs} 张`)

  /* ★ 再刷新一次：它绝不能回来（「打开后强制加载」的回归点）。 */
  await send('Page.reload', {})
  await sleep(4500)
  const afterReload = await hostConfig()
  check('★★ 刷新之后宿主配置里仍然没有它',
    !(afterReload.wallpaper?.folders ?? []).includes(dirB), JSON.stringify(afterReload.wallpaper?.folders))
  const thumbsAfterReload = await openPanel()
  check('★★ 刷新之后界面上也扫不出它的图', thumbsAfterReload === 1, `${thumbsAfterReload} 张`)

  /* 最后删掉仅剩的那个目录：source 应当复位成 none。 */
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const row = [...document.querySelectorAll('.ds-ts-list li')]
      .find((li) => (li.querySelector('.ds-ts-mono')?.textContent ?? '').includes(${JSON.stringify(dirA)}))
    ;[...(row?.querySelectorAll('button') ?? [])].find((el) => el.textContent.trim() === '移除')?.click()
    await sleep(2500)
  })()`)
  const afterAll = await hostConfig()
  check('★ 删掉最后一个目录后 folders 为空且 source 复位为 none',
    (afterAll.wallpaper?.folders ?? []).length === 0 && afterAll.wallpaper?.source === 'none',
    `folders=${JSON.stringify(afterAll.wallpaper?.folders)} source=${afterAll.wallpaper?.source}`)
  check('★ 背景层已撤除',
    (await evaluate(`document.querySelector('#dsh-theme-studio-bg') === null`)) === true)

  check('★ 没有出现「同一帧内两笔写入互相取消」的告警（哨兵保持沉默）',
    warnings.length === 0, warnings.join(' | ') || '(无告警)')
})

await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
socket.close(); child.kill(); await sleep(300)
await fs.promises.rm(profileDir, { recursive: true, force: true }).catch(() => {})
console.log(process.exitCode === 1 ? '\nFOLDER REMOVE PROBE FAILED' : '\nFOLDER REMOVE PROBE OK')
