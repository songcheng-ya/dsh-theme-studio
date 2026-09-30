/**
 * 候选删除的机械校验（0.2.0 重写，不涉及视觉）。
 *
 * 这一版验的是**三种来源各自的删除语义**，以及被拆掉的 `wallpaper.hidden` 机制
 * 确实不再回来：
 *
 *   1. **文件夹来源**（用户自己的壁纸库）—— ✕ 只作用于当前会话的候选墙，
 *      **一个字节都不许动**：磁盘原图在、`config.json` 里也不留任何「已移除」痕迹。
 *      这是本次改动最容易做错的地方（早先就是往 hidden 名单里塞路径）。
 *   2. **上传来源**（插件复制到 wallpapers/ 的副本）—— 真删，文件从磁盘消失。
 *   3. **URL 来源** —— 删 url-cache 里的本地副本 + 从 urls 列表移除；远端原图不受影响。
 *   4. **`hidden` 键已退役** —— 无论谁往 PUT 里塞 `wallpaper.hidden`，
 *      落盘后都必须被物理删除；而且 `/api/folders` 不再按它过滤。
 *   5. **上传删除端点必须拒绝用户目录里的文件**（403 + removed:false）——
 *      那是这个端点唯一危险的方向，必须钉死。
 *
 * 用法：node tools/probe-candidate-remove.mjs [port] [imageDir]
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const port = process.argv[2] ?? '3083'
const imageDir = process.argv[3] ?? path.join(os.homedir(), 'Pictures')
const API = `http://127.0.0.1:${port}/theme-studio/api`
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, 'theme-studio', 'config.json')
const UPLOAD_DIR = path.join(DSH_HOME, 'theme-studio', 'wallpapers')

const check = (label, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) process.exitCode = 1
}

const json = async (url, init) => {
  const response = await fetch(url, init)
  return { status: response.status, body: await response.json().catch(() => null) }
}
const put = (patch) => json(`${API}/config`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(patch),
})
const readDiskConfig = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))

/* 探针会改配置，跑完必须还原。 */
const backup = (await json(`${API}/config`)).body?.config ?? null
const restore = async () => {
  if (backup === null) return
  await put({
    enabled: backup.enabled, glass: backup.glass, wallpaper: backup.wallpaper, accent: backup.accent,
  }).catch(() => {})
}

/* ── 准备：登记目录并挑一张真实存在的图 ────────────────────────── */

await put({ wallpaper: { folders: [imageDir], recursive: false, source: 'none', fixed: '', current: '' } })

const before = await json(`${API}/folders`)
const group = (before.body?.groups ?? []).find((item) => item.folder === imageDir)
check('目录可扫描', (group?.count ?? 0) > 0, `count=${group?.count}`)
check('★ /api/folders 不再返回 hiddenCount', before.body?.hiddenCount === undefined, JSON.stringify(before.body?.hiddenCount))
check('★ 分组里不再有 hiddenItems 字段', group?.hiddenItems === undefined, JSON.stringify(Object.keys(group ?? {})))

const victim = group?.items?.[0]?.path
if (victim === undefined) {
  console.log('没有可用图片，跳过文件夹与上传部分')
  await restore()
  process.exit(process.exitCode ?? 0)
}
const victimName = path.basename(victim)
const statBefore = await fsp.stat(victim)

/* ── 1. 塞进去一个 hidden 名单：必须被剔除，且不再过滤候选 ────────── */

await put({ wallpaper: { hidden: [victim] } })
const afterHiddenPut = await json(`${API}/folders`)
const groupAfter = (afterHiddenPut.body?.groups ?? []).find((item) => item.folder === imageDir)
check('★ 用 hidden 名单 PUT 后，该图**仍然**出现在候选里（过滤已删除）',
  (groupAfter?.items ?? []).some((item) => item.path === victim), victimName)
const onDisk = readDiskConfig()
check('★ config.json 里没有 hidden 键（读盘时被物理删除）',
  !('hidden' in (onDisk.wallpaper ?? {})), JSON.stringify(Object.keys(onDisk.wallpaper ?? {})))

/* ── 2. 文件夹来源的删除语义：什么都不许动 ───────────────────────── */

/* 客户端对文件夹来源**不发任何请求**（只改前端 state），所以这里能验的就是
 * 「宿主侧没有任何删原图的入口」：上传删除端点必须拒绝这个路径。 */
const refused = await json(`${API}/delete-upload`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: victim }),
})
check('★ 上传删除端点拒绝用户目录里的原图（403 + removed:false）',
  refused.status === 403 && refused.body?.removed === false, `status=${refused.status} body=${JSON.stringify(refused.body)}`)
check('★ 被拒绝后磁盘原图完好无损', fs.existsSync(victim), victim)
const statAfterFolder = await fsp.stat(victim)
check('原图的大小与修改时间都没变',
  statAfterFolder.size === statBefore.size && statAfterFolder.mtimeMs === statBefore.mtimeMs,
  `size ${statBefore.size}→${statAfterFolder.size}`)

/* ── 3. 上传来源：真删 ──────────────────────────────────────────── */

await fsp.mkdir(UPLOAD_DIR, { recursive: true })
const probeUpload = path.join(UPLOAD_DIR, `probe-delete-me-${process.pid}.png`)
await fsp.writeFile(probeUpload, Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
))
check('准备：造了一个上传目录里的副本', fs.existsSync(probeUpload), probeUpload)

const uploadScan = await json(`${API}/folders`)
const uploadGroup = (uploadScan.body?.groups ?? []).find((item) => item.uploads === true)
check('★ 上传目录那一组带 uploads:true 标记（客户端据此区分语义）',
  uploadGroup !== undefined && (uploadGroup.items ?? []).some((item) => item.path === probeUpload),
  `uploads=${uploadGroup?.uploads} count=${uploadGroup?.count}`)

const deleted = await json(`${API}/delete-upload`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: probeUpload }),
})
check('★ 上传来源的删除是真删（removed:true）',
  deleted.body?.ok === true && deleted.body?.removed === true,
  `status=${deleted.status} body=${JSON.stringify(deleted.body)}`)
check('★ 文件确实从磁盘上消失', !fs.existsSync(probeUpload), probeUpload)
const afterDelete = await json(`${API}/folders`)
const uploadGroup2 = (afterDelete.body?.groups ?? []).find((item) => item.uploads === true)
check('重新扫描后它不再出现在候选里',
  !(uploadGroup2?.items ?? []).some((item) => item.path === probeUpload))

/* 越权方向：路径逃逸与非法扩展名都要挡住。 */
const escape = await json(`${API}/delete-upload`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: path.join(UPLOAD_DIR, '..', '..', 'config.json') }),
})
check('★ 用 .. 逃逸出上传目录被挡住', escape.status === 403, `status=${escape.status}`)
check('config.json 还在', fs.existsSync(CONFIG_FILE))

/* ── 4. URL 来源：缓存被删、远端不受影响 ───────────────────────── */

// 用本地起一个最小 HTTP 图片服务当「远端」，避免依赖外网。
const { createServer } = await import('node:http')
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
let upstreamHits = 0
const upstream = createServer((req, res) => {
  upstreamHits += 1
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(PNG.length) })
  res.end(PNG)
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/pic.png`

const proxyUrl = `${API}/proxy?url=${encodeURIComponent(upstreamUrl)}`
const firstFetch = await fetch(proxyUrl)
check('代理能取到远端图片', firstFetch.status === 200, `status=${firstFetch.status}`)
check('远端确实被访问了一次', upstreamHits === 1, `hits=${upstreamHits}`)
await firstFetch.arrayBuffer()

await put({ wallpaper: { urls: [upstreamUrl] } })
const cacheDir = path.join(DSH_HOME, 'theme-studio', 'url-cache')
const cachedFiles = await fsp.readdir(cacheDir).catch(() => [])
check('URL 缓存已落盘', cachedFiles.length > 0, `${cachedFiles.length} 个文件`)

const forget = await json(`${API}/forget-url`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: upstreamUrl }),
})
check('forget-url 返回成功', forget.body?.ok === true, JSON.stringify(forget.body))
check('★ 本地缓存副本被删掉', (forget.body?.removedCacheFiles ?? 0) > 0, `removedCacheFiles=${forget.body?.removedCacheFiles}`)
check('★ 该 URL 已从候选列表移除', !(forget.body?.urls ?? []).includes(upstreamUrl), JSON.stringify(forget.body?.urls))

const secondFetch = await fetch(proxyUrl)
await secondFetch.arrayBuffer()
check('★ 再次访问会重新下载（证明删的是本地副本，不是禁用该 URL）',
  secondFetch.status === 200 && upstreamHits === 2, `status=${secondFetch.status} hits=${upstreamHits}`)

upstream.close()
await json(`${API}/forget-url`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: upstreamUrl }),
})

/* ── 收尾 ───────────────────────────────────────────────────────── */

await restore()
console.log('\n配置已还原')
console.log(process.exitCode === 1 ? '\nCANDIDATE REMOVE PROBE FAILED' : '\nCANDIDATE REMOVE PROBE OK')
