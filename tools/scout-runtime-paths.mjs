/**
 * 侦察：把 `dsh web` 真实运行时的**路径**抓出来。
 *
 * 回答「这个插件在 DSH 里到底从哪儿被加载」——不是源码路径，而是运行时事实：
 *   1. 鉴权与入口页；
 *   2. boot 载荷里那条 `dsh.client` 记录（id / url / rev / inject / immediately）；
 *   3. `/plugins/??<id>/client.js&rev=...` 这条请求的真实响应（状态、类型、缓存头、字节数）；
 *   4. 宿主 API 的前缀与它用的数据目录。
 *
 * boot 载荷的形态（实测）：`<script>globalThis["__DSH_BOOT__"] = {...}</script>`，
 * 里面是 `{ rev, entries: [{ id, url, rev, inject, immediately }] }`。
 *
 * 用法：node tools/scout-runtime-paths.mjs <token> <port>
 */

const token = process.argv[2]
const port = process.argv[3] ?? '3087'
if (token === undefined) {
  console.error('usage: node tools/scout-runtime-paths.mjs <token> <port>')
  process.exit(2)
}
const ORIGIN = `http://127.0.0.1:${port}`
const ID = 'dsh-theme-studio'

const first = await fetch(`${ORIGIN}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (first.headers.getSetCookie?.() ?? []).map((v) => v.split(';')[0]).join('; ')
console.log(`1) 鉴权：GET /?token=... → ${first.status}，拿到 cookie ${cookie.split('=')[0]}`)

const html = await (await fetch(`${ORIGIN}/`, { headers: { cookie } })).text()
const boot = JSON.parse(/globalThis\["__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\})<\/script>/.exec(html)[1])
console.log(`2) boot：rev=${boot.rev}  entries=${boot.entries.length}`)

const index = boot.entries.findIndex((entry) => entry.id === ID)
const mine = boot.entries[index]
console.log(`   本插件在 roster 里第 ${index} 条：`)
console.log(JSON.stringify(mine, null, 2).split('\n').map((line) => '   ' + line).join('\n'))

const res = await fetch(ORIGIN + mine.url)
const body = await res.text()
console.log(`3) 请求 ${mine.url}`)
console.log(`   → ${res.status}  ${res.headers.get('content-type')}`)
console.log(`   cache-control: ${res.headers.get('cache-control')}`)
console.log(`   体积 ${body.length} 字节；开头：${body.slice(0, 80).replace(/\n/g, ' ')}`)

const ping = await fetch(`${ORIGIN}/theme-studio/api/ping`)
const payload = await ping.json()
console.log(`4) 宿主 API：GET /theme-studio/api/ping → ${ping.status} ${JSON.stringify(payload)}`)

/* 顺带证明「路由是精确匹配」：换一个 rev 就该 404（不可缓存穿透）。 */
const wrong = await fetch(`${ORIGIN}${mine.url.replace(/rev=[^&]+$/, 'rev=deadbeef')}`)
console.log(`   同一 URL 换个 rev → ${wrong.status}（路由按 pathname+search 精确匹配，rev 变了就是未命中）`)
