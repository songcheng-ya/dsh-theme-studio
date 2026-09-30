/**
 * 验收探针（运行时）：候选墙的「恢复已移除」入口已经消失，且删除语义按来源正确落位。
 *
 * 要证四件事（都在真实浏览器里读实况 DOM）：
 *   1. 壁纸页再也看不到「恢复已移除」「已移除 N 张」这类字样与按钮；
 *   2. 「重新扫描」还在（功能没被误删）；
 *   3. 候选缩略图的删除按钮，aria-label 按来源区分：
 *      上传目录里的图 → 「删除这张上传的图」；登记目录里的图 → 「从候选墙移除」；
 *   4. 点掉一个**登记目录**来源的候选：它从候选墙消失，但
 *      ① config.json 里没有 hidden 键、② 磁盘原文件仍在、③ 刷新/重新扫描后它回来了
 *      —— 这条是本次改动的核心语义，必须实测。
 *
 * 用法：node tools/probe-candidate-wall.mjs <token> <port>
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const token = process.argv[2]
const port = process.argv[3] ?? '3087'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9251
const profileDir = path.join(os.tmpdir(), `dsh-candidate-wall-${process.pid}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ORIGIN = `http://127.0.0.1:${port}`
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, 'theme-studio', 'config.json')

if (token === undefined) {
  console.error('usage: node tools/probe-candidate-wall.mjs <token> <port>')
  process.exit(2)
}

const check = (label, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) process.exitCode = 1
}

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
await send('Page.navigate', { url: `${ORIGIN}/` })
await sleep(4500)

/* ── 打开设置 → 主题工作室 → 壁纸页 ─────────────────────────────── */

const opened = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  document.querySelector('.VOzbGW_trigger')?.click()
  await sleep(1200)
  const panel = document.querySelector('.VOzbGW_panel') ?? document.body
  ;[...panel.querySelectorAll('.VOzbGW_navCell')].find((el) => el.textContent.includes('主题工作室'))?.click()
  await sleep(900)
  ;[...document.querySelectorAll('.ds-ts-tabs button')].find((el) => el.textContent.trim() === '壁纸')?.click()
  await sleep(1200)
  // 等候选墙扫出来
  for (let i = 0; i < 20; i++) {
    await sleep(400)
    if (document.querySelectorAll('.ds-ts-thumb').length > 0) break
  }
  return { page: document.querySelector('.ds-ts-page') !== null, thumbs: document.querySelectorAll('.ds-ts-thumb').length }
})()`)
check('壁纸页渲染出来且候选墙非空', opened.page && opened.thumbs > 0, JSON.stringify(opened))

/* ── 1. 「恢复已移除」入口必须彻底消失 ─────────────────────────── */

const surface = await evaluate(`(() => {
  const page = document.querySelector('.ds-ts-page')
  const card = [...page.querySelectorAll('.ds-ts-card')]
    .find((el) => el.querySelector('.ds-ts-title')?.textContent?.trim() === '壁纸候选')
  return {
    cardFound: card !== undefined && card !== null,
    cardSub: card?.querySelector('.ds-ts-sub')?.textContent?.trim() ?? '',
    buttons: [...(card?.querySelectorAll('.ds-ts-btn') ?? [])].map((el) => el.textContent.trim()),
    text: card?.textContent ?? '',
    pageText: page.textContent,
    labels: [...document.querySelectorAll('.ds-ts-thumb-del')].map((el) => el.getAttribute('aria-label')),
  }
})()`)
console.log(`\n壁纸候选卡片：sub="${surface.cardSub}"  按钮=${JSON.stringify(surface.buttons)}`)
console.log(`缩略图删除按钮的 aria-label 分布：${JSON.stringify([...new Set(surface.labels)])}`)

check('★ 卡片标题还是「壁纸候选」', surface.cardFound)
check('★ 副标题只剩「N 张」，不再有「已移除 N 张」',
  /^\d+\s*张$/.test(surface.cardSub), surface.cardSub)
check('★ 卡片上只有「重新扫描」一个动作按钮（恢复入口已删）',
  surface.buttons.length === 2 && surface.buttons.includes('重新扫描') && surface.buttons.includes('收起'),
  `实际=${JSON.stringify(surface.buttons)}（「收起」是 Card 自带的折叠按钮）`)
check('★ 整个壁纸页文本里都没有「恢复已移除」/「已移除」',
  !surface.pageText.includes('恢复已移除') && !surface.pageText.includes('已移除'),
  (surface.pageText.match(/[^\n]{0,20}已移除[^\n]{0,20}/g) ?? []).join(' | ') || '(无)')
/* 注意：取值必须先 await 出来再传进 check —— 直接把 await 写在参数里是语法错。 */
const restoreButtons = await evaluate(`[...document.querySelectorAll('button')].filter((el) => el.textContent.includes('恢复')).length`)
check('★ DOM 里也没有任何带「恢复」字样的按钮', restoreButtons === 0, `找到 ${restoreButtons} 个`)
check('★ 删除按钮的 aria-label 只按「上传 / 登记目录」两种来源区分',
  surface.labels.length > 0 &&
    surface.labels.every((label) => label === '删除这张上传的图' || label === '从候选墙移除'),
  JSON.stringify([...new Set(surface.labels)]))

/* ── 2. 点掉一个登记目录来源的候选：前端消失、磁盘与配置都不许动 ── */

const beforeStat = await evaluate(`(() => {
  const pick = [...document.querySelectorAll('.ds-ts-thumb')]
    .find((el) => el.querySelector('.ds-ts-thumb-del')?.getAttribute('aria-label') === '从候选墙移除')
  if (pick === undefined) return null
  return {
    name: pick.querySelector('.ds-ts-thumb-pick')?.getAttribute('aria-label') ?? '?',
    total: document.querySelectorAll('.ds-ts-thumb').length,
    src: pick.querySelector('img')?.getAttribute('src') ?? '',
  }
})()`)
check('找得到一个「登记目录来源」的候选', beforeStat !== null, JSON.stringify(beforeStat))

/* 从 img src 里把绝对路径解出来，好在 Node 侧检查磁盘。 */
const victimPath = decodeURIComponent((beforeStat?.src ?? '').replace(/^.*[?&]path=/, ''))
const victimExistsBefore = fs.existsSync(victimPath)
const mtimeBefore = victimExistsBefore ? fs.statSync(victimPath).mtimeMs : null
const sizeBefore = victimExistsBefore ? fs.statSync(victimPath).size : null
console.log(`\n目标图：${victimPath}`)
console.log(`  磁盘上存在=${victimExistsBefore}  size=${sizeBefore}  mtime=${mtimeBefore}`)

/* 点掉这个候选。
 *
 * ⚠️ 必须按**记录下来的那张图的 src** 定位，不能只按 aria-label 找第一个
 * 「从候选墙移除」—— 上传来源的判定依赖 `/api/folders` 的 `uploads` 分组，
 * 那次请求还没回来时 aria-label 会短暂是「从候选墙移除」，探针就会误点一张上传图，
 * 于是断言到的是「删除上传的图」那条文案（实测就是这么假失败的）。 */
await evaluate(`(() => {
  const target = ${JSON.stringify(beforeStat?.src ?? '')}
  const pick = [...document.querySelectorAll('.ds-ts-thumb')]
    .find((el) => el.querySelector('img')?.getAttribute('src') === target)
  pick?.querySelector('.ds-ts-thumb-del')?.click()
})()`)
await sleep(1200)

const afterRemove = await evaluate(`(() => ({
  total: document.querySelectorAll('.ds-ts-thumb').length,
  /* ⚠️ 只取页面底部那条状态行。写成裸的 ds-ts-ok / ds-ts-err / ds-ts-warn 选择器
   * 会撞上「壁纸加载失败」那张**卡片**（它的正文也带 ds-ts-err 类），
   * 于是读到的是一段图片地址而不是操作提示（实测假失败过一次）。
   * 注意：这段在 JS 模板字符串里，注释中不能出现反引号。 */
  status: document.querySelector('.ds-ts-page > .ds-ts-ok, .ds-ts-page > .ds-ts-err, .ds-ts-page > .ds-ts-warn')?.textContent?.trim() ?? '',
  stillThere: [...document.querySelectorAll('.ds-ts-thumb-pick')]
    .some((el) => el.getAttribute('aria-label') === ${JSON.stringify(beforeStat?.name ?? '')}),
}))()`)
console.log(`  点掉之后：缩略图 ${beforeStat?.total} → ${afterRemove.total}，提示="${afterRemove.status}"`)

check('★ 该候选从候选墙消失', afterRemove.total === beforeStat.total - 1, `${beforeStat?.total} → ${afterRemove.total}`)
check('★ 提示文案说明「原图未改动、刷新复原」',
  afterRemove.status.includes('未做任何改动') || afterRemove.status.includes('刷新页面即复原'), afterRemove.status)
check('★ 磁盘上的原图仍在', fs.existsSync(victimPath), victimPath)
const statNow = fs.existsSync(victimPath) ? fs.statSync(victimPath) : null
check('★ 原图既没被删也没被改动（大小与 mtime 都和点之前一致）',
  statNow !== null && statNow.size === sizeBefore && statNow.mtimeMs === mtimeBefore,
  `size ${sizeBefore}→${statNow?.size}  mtime ${mtimeBefore}→${statNow?.mtimeMs}`)
const diskConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
check('★ config.json 里没有留下任何 hidden 名单',
  !('hidden' in (diskConfig.wallpaper ?? {})),
  Object.keys(diskConfig.wallpaper ?? {}).join(','))

/* ── 3. 重新扫描后它必须回来（这就是「不落盘」的可观察后果）──────── */

const afterRescan = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const card = [...document.querySelectorAll('.ds-ts-card')]
    .find((el) => el.querySelector('.ds-ts-title')?.textContent?.trim() === '壁纸候选')
  ;[...(card?.querySelectorAll('.ds-ts-btn') ?? [])].find((el) => el.textContent.trim() === '重新扫描')?.click()
  await sleep(2000)
  return {
    total: document.querySelectorAll('.ds-ts-thumb').length,
    back: [...document.querySelectorAll('.ds-ts-thumb-pick')]
      .some((el) => el.getAttribute('aria-label') === ${JSON.stringify(beforeStat?.name ?? '')}),
  }
})()`)
check('★ 重新扫描后它回来了（没有任何持久名单在挡它）',
  afterRescan.back && afterRescan.total === beforeStat?.total,
  `总数 ${afterRescan.total}，回来了=${afterRescan.back}`)

/* ── 收尾 ───────────────────────────────────────────────────────── */

socket.close()
child.kill()
await sleep(300)
await fs.promises.rm(profileDir, { recursive: true, force: true }).catch(() => {})
console.log(process.exitCode === 1 ? '\nCANDIDATE WALL PROBE FAILED' : '\nCANDIDATE WALL PROBE OK')
