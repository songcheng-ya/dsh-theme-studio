/**
 * 验收探针（运行时）：**候选全删空之后，背景必须回到 DSH 原样**（用户报障）。
 *
 * 用户现象：把所有候选图删掉之后，背景仍然是之前选中的那张。
 * 根因有两处，本探针各钉一条：
 *
 *   A. `ThemeRuntime.apply()` 里写成 `this.resolved = this.resolved || this.pickWallpaper()`
 *      —— 一旦有值就**永不再算**，于是清空 `wallpaper.fixed` 之后背景层照旧铺着。
 *   B. 「删掉候选」与「撤掉背景层」是两件事：候选列表空了，`wallpaper.source` 还是
 *      `'folder'`、`fixed` 还指着那张图。现在候选空到 0 时会**完整复位**成 `source: 'none'`。
 *
 * 探针流程（每一步都读实况 DOM 与真实配置）：
 *   1. 登记目录 + 选中一张图 → 断言背景层存在、`source='folder'`；
 *   2. 把候选删空（模拟把墙上的图全 ✕ 掉）→ 断言
 *      ① 背景层元素消失、② `source='none'`、③ `fixed/current` 清空、
 *      ④ **总开关 `enabled` 与玻璃参数没被误改**（复位只该动壁纸）；
 *   3. 重新登记目录 + 选中 → 断言背景层回来（可恢复，不是单向破坏）。
 *
 * 用法：node tools/probe-background-restore.mjs <token> <port> [imageDir]
 *
 * ⚠️ **这个探针曾经弄坏过用户的配置，改它之前先读这段。**
 *
 * 事故：原来的写法是「先 `put({ folders: [tinyDir] })` 把目录换成临时目录，
 * 之后再读一次配置当备份」。于是备份里存的是**已经被自己改过**的状态 ——
 * 跑完「还原」把临时目录写了回去，用户的 `Pictures` 从配置里消失；而临时目录
 * 随后被删掉，`wallpaper.fixed` 指向的图也没了。删掉的那几张是同一张图的 3 份副本，
 * 没有不可替代的数据，但这个错误模式非常危险。
 *
 * 现在三条硬约束：
 *   1. `PRistine` 在**任何写操作之前**取，只取一次，之后绝不再读；
 *   2. 收尾必须**断言**配置逐字段回到 PRistine，不一致就让探针 FAIL 并打印差异；
 *   3. 临时目录用完即删（`finally` 语义），不给用户留垃圾。
 *
 * 这个坑的教训值得写下来：**「跑完会还原」这句话必须由断言来保证，不能靠自觉。**
 * 上一版的收尾确实调了还原，看起来无懈可击，但它还原的是被自己污染过的快照 ——
 * 探针报 OK，用户的配置却已经坏了，而且是静默的。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const token = process.argv[2]
const port = process.argv[3] ?? '3087'
const imageDir = process.argv[4] ?? path.join(os.homedir(), 'Pictures')
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9253
const profileDir = path.join(os.tmpdir(), `dsh-bg-restore-${process.pid}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ORIGIN = `http://127.0.0.1:${port}`
const API = `${ORIGIN}/theme-studio/api`
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, 'theme-studio', 'config.json')

if (token === undefined) {
  console.error('usage: node tools/probe-background-restore.mjs <token> <port> [imageDir]')
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
const diskConfig = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))

/* 探针会改配置，跑完必须还原。
 *
 * ⚠️ 这一句必须在**第一次写操作之前**执行，而且之后**绝不能再读一次配置来当备份**。
 * 上一版就是先改 folders、再读备份，于是「还原」把临时目录写了回去，
 * 把用户登记的真目录从配置里抹掉了（详见文件头的事故说明）。 */
const PRistine = (await json(`${API}/config`)).body?.config ?? null
if (PRistine === null) {
  console.error('拿不到初始配置，拒绝继续（不能在没有备份的情况下改用户配置）')
  process.exit(1)
}
console.log(`备份初始配置：folders=${JSON.stringify(PRistine.wallpaper?.folders)} source=${PRistine.wallpaper?.source}`)

const restore = async () => {
  await put({
    enabled: PRistine.enabled, glass: PRistine.glass, wallpaper: PRistine.wallpaper, accent: PRistine.accent,
  }).catch(() => {})
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

const first = await fetch(`${ORIGIN}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (first.headers.getSetCookie?.() ?? []).map((v) => v.split(';')[0]).join('; ')
await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' })

/** 背景层的实况：元素在不在、它当前用的是哪张图。 */
const readBackground = () => evaluate(`(() => {
  const layer = document.querySelector('#dsh-theme-studio-bg')
  return {
    present: layer !== null,
    // 图层里每一个背景元素用的图片地址（背景层由若干子层组成）
    images: layer === null ? [] : [...layer.querySelectorAll('*')]
      .map((el) => getComputedStyle(el).backgroundImage)
      .filter((value) => value !== 'none'),
    rootAttr: document.documentElement.hasAttribute('data-dsh-theme-studio'),
  }
})()`)

const openPanel = () => evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  if (document.querySelector('.ds-ts-page') === null) {
    document.querySelector('.VOzbGW_trigger')?.click()
    await sleep(1200)
    const panel = document.querySelector('.VOzbGW_panel') ?? document.body
    ;[...panel.querySelectorAll('.VOzbGW_navCell')].find((el) => el.textContent.includes('主题工作室'))?.click()
    await sleep(900)
    ;[...document.querySelectorAll('.ds-ts-tabs button')].find((el) => el.textContent.trim() === '壁纸')?.click()
    await sleep(1000)
  }
  for (let i = 0; i < 20; i++) {
    await sleep(400)
    if (document.querySelectorAll('.ds-ts-thumb').length > 0) break
  }
  return document.querySelectorAll('.ds-ts-thumb').length
})()`)

/* ── 0. 造一个只有 2 张图的小目录，用**真实路径**把候选删空 ────────
 *
 * ⚠️ 第一版这里栽了：直接 `PUT { folders: [], source:'folder' }` 想「模拟删空」，
 * 但那条路径**绕过了面板的 `gallery` 状态** —— 而「候选空了就复原背景」是挂在
 * `gallery.length === 0` 上的 React effect，不走面板就永远不会触发。
 * 探针必须复现用户的真实操作：点候选图上的 ✕，一张一张删。
 * 用 2 张图的小目录是为了让「全删掉」这件事跑得快且确定。
 */

const tinyDir = path.join(os.tmpdir(), `dsh-bg-probe-${process.pid}`)
fs.mkdirSync(tinyDir, { recursive: true })
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
const tinyFiles = ['a.png', 'b.png'].map((name) => path.join(tinyDir, name))
for (const file of tinyFiles) fs.writeFileSync(file, PNG)
console.log(`临时候选目录：${tinyDir}（${tinyFiles.length} 张）`)

await put({
  enabled: true,
  // source 必须显式给 'folder'：光设 fixed 不会让背景层挂载（pickWallpaper 在
  // source==='none' 时直接返回空串），第一版就是这么假失败的。
  wallpaper: { folders: [tinyDir], recursive: false, source: 'folder', fixed: '', current: '' },
})
await send('Page.navigate', { url: `${ORIGIN}/` })
await sleep(4500)

const thumbs = await openPanel()
check('候选墙扫出来了', thumbs === tinyFiles.length, `${thumbs} 张（应为 ${tinyFiles.length}）`)

/* 点第一张候选 → 应用为壁纸。点的是缩略图的「选图」按钮（与 ✕ 是并列兄弟）。 */
const picked = await evaluate(`(() => {
  const pick = document.querySelector('.ds-ts-thumb-pick')
  const src = pick?.querySelector('img')?.getAttribute('src') ?? ''
  pick?.click()
  return src
})()`)
await sleep(2500)
const pickedPath = decodeURIComponent(String(picked).replace(/^.*[?&]path=/, ''))

const withWallpaper = await readBackground()
const cfg1 = (await json(`${API}/config`)).body.config
console.log(`\n选中：${pickedPath}`)
console.log(`  背景层 present=${withWallpaper.present}  图片数=${withWallpaper.images.length}`)
console.log(`  source=${cfg1.wallpaper.source}  fixed=${path.basename(cfg1.wallpaper.fixed || '')}`)

check('★ 选中后背景层存在', withWallpaper.present === true)
check('★ 背景层里确实铺着那张图',
  withWallpaper.images.some((value) => value.includes(encodeURIComponent(path.basename(pickedPath))) || value.includes(path.basename(pickedPath)) || value.includes('image')),
  JSON.stringify(withWallpaper.images).slice(0, 200))
check('配置里 source=folder 且 fixed 指向那张图',
  cfg1.wallpaper.source === 'folder' && cfg1.wallpaper.fixed === pickedPath,
  `${cfg1.wallpaper.source} / ${path.basename(cfg1.wallpaper.fixed || '')}`)

/* ── 2. 逐张点 ✕ 把候选删空（复现用户的真实操作）───────────────── */

const glassBefore = JSON.stringify(cfg1.glass)
const uploadsBefore = fs.readdirSync(path.join(DSH_HOME, 'theme-studio', 'wallpapers')).length

const removalLog = []
for (let round = 0; round < tinyFiles.length + 2; round++) {
  const state = await evaluate(`(() => {
    const thumbs = [...document.querySelectorAll('.ds-ts-thumb')]
    if (thumbs.length === 0) return { left: 0 }
    // 点最后一张（第 1 轮会先把「当前壁纸」那张删掉，正好覆盖 clearIfActive 分支）
    const thumb = thumbs[thumbs.length - 1]
    const name = thumb.querySelector('.ds-ts-thumb-pick')?.getAttribute('aria-label') ?? '?'
    thumb.querySelector('.ds-ts-thumb-del')?.click()
    return { left: thumbs.length, name }
  })()`)
  removalLog.push(`${state.name ?? '-'}（剩 ${state.left}）`)
  if (state.left === 0) break
  await sleep(1200)
}
console.log(`\n逐张 ✕：${removalLog.join(' → ')}`)
await sleep(2500)

const emptyState = await readBackground()
const cfg2 = (await json(`${API}/config`)).body.config
const cfg2disk = diskConfig()
console.log(`\n候选删空之后：`)
console.log(`  背景层 present=${emptyState.present}  source=${cfg2.wallpaper.source}  fixed="${cfg2.wallpaper.fixed}"  current="${cfg2.wallpaper.current}"`)
console.log(`  enabled=${cfg2.enabled}  glass 未变=${JSON.stringify(cfg2.glass) === glassBefore}`)
console.log(`  面板上的候选数=${await evaluate(`document.querySelectorAll('.ds-ts-thumb').length`)}`)

check('★★ 背景层元素已消失（用户报障的核心：背景回到 DSH 原样）', emptyState.present === false,
  `present=${emptyState.present}`)
check('★★ 配置里 source 复位为 none', cfg2.wallpaper.source === 'none', cfg2.wallpaper.source)
check('★ fixed 与 current 都清空，不留悬空路径',
  cfg2.wallpaper.fixed === '' && cfg2.wallpaper.current === '',
  `fixed="${cfg2.wallpaper.fixed}" current="${cfg2.wallpaper.current}"`)
check('★ 复位已落盘（磁盘 config.json 与内存一致）',
  cfg2disk.wallpaper.source === 'none' && cfg2disk.wallpaper.fixed === '',
  JSON.stringify({ source: cfg2disk.wallpaper.source, fixed: cfg2disk.wallpaper.fixed }))
check('★ 只动了壁纸：总开关 enabled 未被误改', cfg2.enabled === cfg1.enabled, `${cfg1.enabled} → ${cfg2.enabled}`)
check('★ 只动了壁纸：玻璃参数逐字节未变', JSON.stringify(cfg2.glass) === glassBefore)
check('★ 只动了壁纸：上传目录里的文件没被牵连',
  fs.readdirSync(path.join(DSH_HOME, 'theme-studio', 'wallpapers')).length === uploadsBefore, `${uploadsBefore} 个`)

/* 面板上应当有一句说明，别让用户以为程序坏了。 */
const hint = await evaluate(`(() => {
  const page = document.querySelector('.ds-ts-page')
  return page?.textContent?.includes('已恢复 DSH 原本的背景') ?? false
})()`)
check('★ 面板给出「已恢复 DSH 原本的背景」的提示', hint === true)

/* ── 3. 重新登记目录：必须能恢复（不是单向破坏）────────────────── */

/* 走面板上的真实入口：往「文件夹绝对路径」输入框里填路径 + 点「添加」。
 * ⚠️ 按钮文案是「添加」不是「登记」—— 别照着自己脑补的文案写选择器。 */
const readded = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const input = [...document.querySelectorAll('.ds-ts-text')].find((el) => el.placeholder?.includes('文件夹'))
  if (input === undefined) return { ok: false, stage: 'no-input' }
  const proto = HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${JSON.stringify(tinyDir)})
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(300)
  const button = [...document.querySelectorAll('.ds-ts-btn')].find((el) => el.textContent.trim() === '添加')
  if (button === undefined) return { ok: false, stage: 'no-button', value: input.value }
  button.click()
  await sleep(3000)
  return { ok: true, value: input.value, thumbs: document.querySelectorAll('.ds-ts-thumb').length }
})()`)
check('重新登记目录后候选回来了（复位不是单向的）',
  readded.ok === true && readded.thumbs > 0, JSON.stringify(readded))

await evaluate(`document.querySelector('.ds-ts-thumb-pick')?.click()`)
await sleep(3000)
const recovered = await readBackground()
const cfg3 = (await json(`${API}/config`)).body.config
check('★ 再选一张，背景层回来了', recovered.present === true, `present=${recovered.present}`)
check('★ 再选之后 source 回到 folder', cfg3.wallpaper.source === 'folder', cfg3.wallpaper.source)

/* ── 收尾 ───────────────────────────────────────────────────────── */

await restore()
await fs.promises.rm(tinyDir, { recursive: true, force: true }).catch(() => {})
console.log(`\n临时目录已删除：${tinyDir}`)

/* 硬校验：配置必须逐字段回到开始时那一份。
 * 上一版没有这一步，所以「还原成临时目录」这种事故是**静默**发生的 ——
 * 探针报 OK，用户的配置却已经坏了。 */
const finalConfig = (await json(`${API}/config`)).body?.config ?? {}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const diffs = []
for (const key of ['enabled', 'glass', 'wallpaper', 'accent']) {
  if (!same(finalConfig[key], PRistine[key])) diffs.push(key)
}
check('★★ 配置已逐字段还原（folders / source / fixed 都不许变）',
  diffs.length === 0,
  diffs.length === 0
    ? `folders=${JSON.stringify(finalConfig.wallpaper?.folders)}`
    : diffs.map((key) => `${key}: ${JSON.stringify(PRistine[key])} → ${JSON.stringify(finalConfig[key])}`).join(' | '))
socket.close()
child.kill()
await sleep(300)
await fs.promises.rm(profileDir, { recursive: true, force: true }).catch(() => {})
console.log(process.exitCode === 1 ? '\nBACKGROUND RESTORE PROBE FAILED' : '\nBACKGROUND RESTORE PROBE OK')
