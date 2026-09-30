/**
 * 实验：验证「改完 lib/client.js，到底要不要重启 dsh web」。
 *
 * 背景：这个插件是 `link:` / 联接安装的，磁盘上改完立刻生效 —— 但**服务端到底
 * 什么时候重新读盘**，取决于 `client-modules` 的 HMR 监视是否真的挂上了。
 * 服务器源码里同时存在两条路径：
 *   - `ClientModuleRegistry` 构造时同步扫描一次（`readFileSync`）；
 *   - `rebuilt(id)` 会重新 `readFileSync` + 重新算 rev（注释说是「HMR 监视的登记钩子」）。
 * 所以「必须重启」这个结论不该靠记忆，得实测。
 *
 * 做法（不改任何语义，只往 bundle 末尾追加一条注释再撤回）：
 *   1. 起实例，记下 boot 载荷里本插件的 `rev`；
 *   2. 往 lib/client.js **末尾**追加一行注释（JS 里等价于没有改动）；
 *   3. 等 HMR；看旧 rev 的 URL 是否开始 404、boot 里的 rev 是否变了；
 *   4. 再请求新 rev，确认拿到的是**新字节**（体积变了）；
 *   5. 撤回文件（内容和 mtime 都尽量复原），并复核服务端回到初始状态。
 *
 * ⚠️ 必须先在浏览器里打开过页面，HMR 的 watch 才可能挂上（`artifactBaseline`
 * 那段注释明说「HMR 把基线写文件比较，在启动组合之后、watch 安装之前发生的写入
 * 不能消失在监视器的初始状态里」）。
 *
 * 用法：node tools/probe-hmr-reload.mjs <token> <port>
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const token = process.argv[2]
const port = process.argv[3] ?? '3087'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9249
const BUNDLE = path.resolve('lib/client.js')
const MARKER = `\n/* probe-hmr-reload: ${Date.now()} */\n`

if (token === undefined) {
  console.error('usage: node tools/probe-hmr-reload.mjs <token> <port>')
  process.exit(2)
}
const ORIGIN = `http://127.0.0.1:${port}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const check = (label, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) process.exitCode = 1
}

/* ── 先备份原始字节：中途出错也必须能还原 ───────────────────────── */

const original = fs.readFileSync(BUNDLE)
const originalStat = fs.statSync(BUNDLE)
const backup = path.join(os.tmpdir(), `client.js.probe-backup-${process.pid}`)
fs.writeFileSync(backup, original)
console.log(`bundle 源码 ${BUNDLE}`)
console.log(`  原始 ${original.length} 字节，mtime ${originalStat.mtime.toISOString()}`)
console.log(`  备份 ${backup}`)

const restoreFile = () => {
  try {
    fs.writeFileSync(BUNDLE, original)
    fs.utimesSync(BUNDLE, originalStat.atime, originalStat.mtime)
    console.log('  已还原 lib/client.js（内容与 mtime 都复原）')
  } catch (error) {
    console.error(`  ⚠️ 还原失败，请手工从备份恢复：${backup} — ${error.message}`)
  }
}

/* ── 浏览器：boot 载荷 + 触发 HMR watch 挂载 ─────────────────────── */

const child = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(os.tmpdir(), `dsh-hmr-${process.pid}`)}`,
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

const first = await fetch(`${ORIGIN}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (first.headers.getSetCookie?.() ?? []).map((v) => v.split(';')[0]).join('; ')
await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' })
await send('Page.navigate', { url: `${ORIGIN}/` })
await sleep(4500)

/** 直接读服务端进程当前广告出来的 rev（boot 载荷每次都现算，不是页面缓存）。 */
const readRev = async () => {
  const html = await (await fetch(`${ORIGIN}/`, { headers: { cookie } })).text()
  const boot = JSON.parse(/globalThis\["__DSH_BOOT__"\]\s*=\s*(\{[^]*?\})<\/script>/.exec(html)[1])
  return boot.entries.find((entry) => entry.id === 'dsh-theme-studio')
}

const before = await readRev()
const beforeBody = await (await fetch(ORIGIN + before.url)).text()
console.log(`\n改动前：rev=${before.rev}  体积=${beforeBody.length} 字节`)
console.log(`  URL ${before.url}`)

/* ── 追加一行注释（等价于没改代码），看服务端会不会自己重读 ───────── */

fs.appendFileSync(BUNDLE, MARKER)
const mutatedSize = fs.statSync(BUNDLE).size
console.log(`\n已往 bundle 末尾追加 ${MARKER.length} 字节注释 → ${mutatedSize} 字节；等 HMR…`)

let after = null
for (let i = 0; i < 24; i++) {
  await sleep(1000)
  after = await readRev()
  if (after.rev !== before.rev) break
}

console.log(`改动后：rev=${after.rev}  ${after.rev === before.rev ? '（没变）' : '（变了）'}`)
if (after.rev !== before.rev) {
  const afterBody = await (await fetch(ORIGIN + after.url)).text()
  console.log(`  新体积=${afterBody.length} 字节（旧 ${beforeBody.length}）`)
  const oldUrl = await fetch(ORIGIN + before.url)
  console.log(`  旧 rev 的 URL → ${oldUrl.status}`)
  check('★ 改文件后服务端自己换了 rev（不需要重启进程）', true, `${before.rev} → ${after.rev}`)
  /* 判据用「标记字符串在不在」而不是字节数：
   * bundle 体积会被包装（惰性 CJS 外壳 / sourcemap 注释）扰动，上一版按
   * `+MARKER.length` 断言就假失败了（+39 只涨了 32）。权威的字节级比对在
   * `probe-served-source.mjs`（走 sourcemap 的 sourcesContent）。
   * 这里的标记是行注释、且排在文件最末，只要服务端重读了盘就必然出现在 bundle 里。 */
  check('★ 新 rev 拿到的 bundle 里含刚追加的标记（证明真的重读了盘）',
    afterBody.includes(MARKER.trim()), `标记「${MARKER.trim()}」${afterBody.includes(MARKER.trim()) ? '在' : '不在'} bundle 里`)
  check('旧 rev 的 URL 已失效（按 rev 精确匹配，不会拿旧缓存充当新代码）',
    oldUrl.status === 404, `status=${oldUrl.status}`)
} else {
  check('★ 改文件后服务端自己换了 rev（不需要重启进程）', false,
    `等了 24 秒 rev 仍是 ${before.rev} —— 需要重启 dsh web 才会生效`)
}

/* ── 还原并复核 ─────────────────────────────────────────────────── */

restoreFile()
let back = null
for (let i = 0; i < 24; i++) {
  await sleep(1000)
  back = await readRev()
  if (back.rev === before.rev) break
}
check('还原后 rev 回到初始值（服务端确实跟着盘走）',
  back.rev === before.rev, `${back.rev} vs ${before.rev}`)
const backBody = await (await fetch(ORIGIN + back.url)).text()
check('还原后的 bundle 不含那个标记',
  !backBody.includes(MARKER.trim()), `标记${backBody.includes(MARKER.trim()) ? '仍在' : '已消失'}`)

socket.close()
child.kill()
await sleep(300)
await fs.promises.rm(path.join(os.tmpdir(), `dsh-hmr-${process.pid}`), { recursive: true, force: true }).catch(() => {})
console.log(process.exitCode === 1 ? '\nHMR RELOAD PROBE FAILED' : '\nHMR RELOAD PROBE OK')
