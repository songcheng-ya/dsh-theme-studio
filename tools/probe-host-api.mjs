/**
 * 宿主 API 端到端测试：对运行中的探针实例逐个打通配置、扫描、回吐、代理、
 * 上传五条链路，并验证「已登记目录之外的文件一律拒绝」这条安全边界。
 *
 * 用法：node tools/probe-host-api.mjs [port] [folder]
 */

import path from 'node:path'
import os from 'node:os'

const port = process.argv[2] ?? '3081'
const folder = process.argv[3] ?? path.join(os.homedir(), 'Pictures')
const API = `http://127.0.0.1:${port}/theme-studio/api`

const check = (label, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) process.exitCode = 1
}

const json = async (url, init) => {
  const response = await fetch(url, init)
  const text = await response.text()
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    return { status: response.status, body: text.slice(0, 200) }
  }
}

/* 探针会改配置（第 3 步写入壁纸来源与登记目录），结束时必须还原 ——
 * 这是跑在用户真实 profile 上的，不还原就会把用户的壁纸设置改掉。 */
const backup = (await json(`${API}/config`)).body?.config ?? null
const restore = async () => {
  if (backup === null) return
  await json(`${API}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: backup.enabled, glass: backup.glass, wallpaper: backup.wallpaper, accent: backup.accent,
    }),
  }).catch(() => {})
}

/* ── 1. ping ────────────────────────────────────────────────────── */
const ping = await json(`${API}/ping`)
check('ping 返回插件信息', ping.body?.plugin === 'dsh-theme-studio', JSON.stringify(ping.body))

/* ── 2. browse ──────────────────────────────────────────────────── */
const browse = await json(`${API}/browse?path=${encodeURIComponent(folder)}`)
check('browse 打开目录', browse.body?.ok === true, browse.body?.path ?? String(browse.body?.error))
check('browse 报告图片数量', typeof browse.body?.imageCount === 'number', `imageCount=${browse.body?.imageCount}`)
check('browse 返回父目录', typeof browse.body?.parent === 'string', browse.body?.parent)

/* ── 3. config 写入 ─────────────────────────────────────────────── */
const put = await json(`${API}/config`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ wallpaper: { source: 'folder', folders: [folder], recursive: false } }),
})
check('config 写入成功', put.body?.ok === true, JSON.stringify(put.body?.config?.wallpaper?.folders))
/* 判「现存分区的默认值都还在」。原来这里写的是 `glass.chat`，而 `chat`
 * 分区在 0.1.13 就删掉了（宿主 RETIRED_REGIONS 会持续剔除它的残键），
 * 于是这条断言必然失败 —— 是探针过期，不是插件坏了。改成遍历现存分区。 */
const LIVE_REGIONS = ['bars', 'input', 'bubble', 'menu']
const glass = put.body?.config?.glass ?? {}
check('config 保留现存分区的默认值',
  LIVE_REGIONS.every((key) => typeof glass[key]?.blur === 'number' && typeof glass[key]?.opacity === 'number'),
  LIVE_REGIONS.map((key) => `${key}:${glass[key]?.opacity}/${glass[key]?.blur}`).join(' ') || JSON.stringify(glass))
check('config 不再含已移除的 sidebar 分区', put.body?.config?.glass?.sidebar === undefined, JSON.stringify(put.body?.config?.glass?.sidebar))
check('config 不再含已移除的 topbar 分区', put.body?.config?.glass?.topbar === undefined, JSON.stringify(put.body?.config?.glass?.topbar))

/* ── 4. folders 扫描 ────────────────────────────────────────────── */
const folders = await json(`${API}/folders`)
const group = (folders.body?.groups ?? []).find((item) => item.folder === folder)
check('folders 列出登记目录', group !== undefined, JSON.stringify((folders.body?.groups ?? []).map((item) => `${item.folder}:${item.count}`)))
check('folders 扫到图片', (group?.count ?? 0) > 0, `count=${group?.count}`)
const first = group?.items?.[0]
check('条目带 path/name/size', typeof first?.path === 'string' && typeof first?.name === 'string' && typeof first?.size === 'number')

/* ── 5. image 回吐 ──────────────────────────────────────────────── */
if (first !== undefined) {
  const image = await fetch(`${API}/image?path=${encodeURIComponent(first.path)}`)
  const buffer = new Uint8Array(await image.arrayBuffer())
  check('image 返回 200', image.status === 200, `status=${image.status}`)
  check('image 是图片类型', String(image.headers.get('content-type')).startsWith('image/'), String(image.headers.get('content-type')))
  check('image 有 ETag', image.headers.get('etag') !== null, String(image.headers.get('etag')))
  check('image 字节数与磁盘一致', buffer.length === first.size, `${buffer.length} vs ${first.size}`)

  const etag = image.headers.get('etag')
  const cached = await fetch(`${API}/image?path=${encodeURIComponent(first.path)}`, { headers: { 'if-none-match': etag } })
  check('image 支持 304 协商缓存', cached.status === 304, `status=${cached.status}`)

  // 回归防线：`new URL().searchParams.get()` **不做百分号解码**，早期实现直接把它
  // 当路径用，于是任何真的按 URL 编码传参的调用（也就是浏览器里的真实调用）都会
  // 因为解码失败被误判为越权 —— 手测时用未编码路径会漏掉这个 bug，所以这里两种
  // 形态都测，并且专门覆盖带空格与中文的路径。
  const rawPath = await fetch(`${API}/image?path=${first.path}`)
  check('未编码路径（含反斜杠）同样可用', rawPath.status === 200, `status=${rawPath.status}`)

  const tricky = path.join(folder, '含 空格 目录', '图 片.png')
  const trickyResult = await json(`${API}/image?path=${encodeURIComponent(tricky)}`)
  check('含空格与中文的编码路径解码正确', trickyResult.status === 403,
    `status=${trickyResult.status}（403 = 已正确解码、只是文件不存在，而非解码失败误判越权）`)
}

/* ── 6. 安全边界：目录外的文件必须拒绝 ──────────────────────────── */
const outside = path.join(os.homedir(), '.dsh', 'settings.yaml')
const denied = await json(`${API}/image?path=${encodeURIComponent(outside)}`)
check('目录外/非图片一律拒绝', denied.status === 403, `status=${denied.status}`)

const traversal = path.join(folder, '..', '..', 'Windows', 'win.ini')
const traversalResult = await json(`${API}/image?path=${encodeURIComponent(traversal)}`)
check('.. 逃逸被拒绝', traversalResult.status === 403, `status=${traversalResult.status}`)

const missing = await json(`${API}/image`)
check('缺参返回 400', missing.status === 400, `status=${missing.status}`)

/* ── 7. 上传 ────────────────────────────────────────────────────── */
// 1×1 透明 PNG，用来验证上传链路本身而不是图片内容。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
const upload = await json(`${API}/upload?name=probe.png`, { method: 'POST', body: PNG })
check('上传成功并落盘', upload.body?.ok === true && typeof upload.body?.path === 'string', String(upload.body?.path))
if (upload.body?.ok === true) {
  const uploaded = await fetch(`${API}/image?path=${encodeURIComponent(upload.body.path)}`)
  check('上传的图片可以回吐', uploaded.status === 200, `status=${uploaded.status}`)
  const { rm } = await import('node:fs/promises')
  await rm(upload.body.path, { force: true })
  console.log(`       已清理测试上传文件：${upload.body.path}`)
}

/* ── 8. 远程代理（失败不判负，取决于网络） ──────────────────────── */
const proxyBad = await json(`${API}/proxy?url=not-a-url`)
check('代理拒绝非 http(s) 输入', proxyBad.status === 400, `status=${proxyBad.status}`)

await restore()
console.log('\n配置已还原')
console.log(process.exitCode === 1 ? '\nHOST API FAILED' : '\nHOST API OK')
