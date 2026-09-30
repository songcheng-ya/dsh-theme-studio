/**
 * 侦察：服务端**此刻**广告出去的 bundle，对应磁盘上的哪一版源码？
 *
 * 为什么需要这个：bundle 字节数不能直接和 `lib/client.js` 比 —— 服务端会做包装
 * （惰性 CJS 外壳 / sourcemap 注释），所以「字节数差几字节」既可能是包装差异，
 * 也可能是**版本差异**。上一版探针就卡在这里：追加 39 字节注释后 bundle 只长了
 * 32 字节，还原后又比初始值少 7 字节 —— 无法判定是包装导致还是读到了旧字节。
 *
 * 权威判据用 **sourcemap**：combo URL 支持 `.js.map`，而 sourcemap 的
 * `sourcesContent` 就是服务端当时读到的源码**原文**。把它和磁盘上的文件逐字节比，
 * 就是「服务端手上是哪一版」的确凿答案。
 *
 * 用法：node tools/probe-served-source.mjs <token> <port> [文件路径]
 */

import fs from 'node:fs'
import path from 'node:path'

const token = process.argv[2]
const port = process.argv[3] ?? '3087'
const TARGET = path.resolve(process.argv[4] ?? 'lib/client.js')
if (token === undefined) {
  console.error('usage: node tools/probe-served-source.mjs <token> <port> [file]')
  process.exit(2)
}
const ORIGIN = `http://127.0.0.1:${port}`
const ID = 'dsh-theme-studio'

const check = (label, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) process.exitCode = 1
}

const first = await fetch(`${ORIGIN}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (first.headers.getSetCookie?.() ?? []).map((v) => v.split(';')[0]).join('; ')
const html = await (await fetch(`${ORIGIN}/`, { headers: { cookie } })).text()
const boot = JSON.parse(/globalThis\["__DSH_BOOT__"\]\s*=\s*(\{[^]*?\})<\/script>/.exec(html)[1])
const entry = boot.entries.find((item) => item.id === ID)
console.log(`roster rev = ${entry.rev}`)

const bundle = await (await fetch(ORIGIN + entry.url)).text()
console.log(`bundle 体积 = ${bundle.length} 字节（磁盘源码 ${fs.statSync(TARGET).size} 字节）`)

/* combo URL 的 sourcemap 形式：`client.js` → `client.js.map`，rev 不变。 */
const mapUrl = entry.url.replace('client.js&rev=', 'client.js.map&rev=')
const mapRes = await fetch(ORIGIN + mapUrl)
console.log(`sourcemap: GET ${mapUrl} → ${mapRes.status} ${mapRes.headers.get('content-type')}`)
if (mapRes.status !== 200) {
  check('sourcemap 可取（用来读服务端手上的源码原文）', false, `status=${mapRes.status}`)
  process.exit(1)
}
const map = await mapRes.json()
/* ⚠️ 这是**index map**（顶层是 `sections[]`，每段自己的 `map` 里才有 sources），
 * 不是扁平 map —— 读 `map.sourcesContent` 会得到 undefined。第一版就栽在这里。 */
const inner = map.sections?.[0]?.map ?? map
console.log(`sourcemap: version=${map.version}  sections=${map.sections?.length ?? 0}  sources=${JSON.stringify(inner.sources)}`)

const served = inner.sourcesContent?.[0] ?? ''
const onDisk = fs.readFileSync(TARGET, 'utf8')
console.log(`服务端手上的源码 ${served.length} 字符；磁盘上 ${onDisk.length} 字符`)

check('★ 服务端手上的源码与磁盘上的逐字节一致（改完文件服务端就会跟上）',
  served === onDisk,
  served === onDisk ? '完全一致' : `前 80 字符：服务端「${served.slice(0, 80).replace(/\n/g, '⏎')}」`)

if (served !== onDisk) {
  /* 找出第一处差异，便于判断是「旧一版」还是「包装差异」。 */
  let i = 0
  while (i < Math.min(served.length, onDisk.length) && served[i] === onDisk[i]) i++
  console.log(`  第一处差异在第 ${i} 字符：`)
  console.log(`    服务端：${JSON.stringify(served.slice(i, i + 90))}`)
  console.log(`    磁盘：  ${JSON.stringify(onDisk.slice(i, i + 90))}`)
  const hasOld = served.includes('加成')
  const hasNew = served.includes('条件分区都带')
  console.log(`  服务端源码里还有旧的「加成」措辞：${hasOld}；含新版文案：${hasNew}`)
}

/* 顺带证明 bundle 里确实带着服务端读到的源码（sourcemap 不是凭空造的）。 */
const probeString = 'dsh-theme-studio —— 浏览器（客户端）半侧'
check('sourcemap 的 sourcesContent 就是该 bundle 的源码（不是空壳）',
  served.includes(probeString), served.slice(0, 60).replace(/\n/g, ' '))
