/**
 * 端到端探针：从探针实例的 index.html 里取出 window.__DSH_BOOT__，
 * 找到本插件对应的 boot 行，校验 URL/external/inject 之后再把 bundle 拉回来。
 *
 * 用法：node tools/probe-boot.mjs <token> [port]
 */

const token = process.argv[2]
const port = process.argv[3] ?? '3081'
if (!token) {
  console.error('usage: node tools/probe-boot.mjs <token> [port]')
  process.exit(2)
}

const origin = `http://127.0.0.1:${port}`

/** dsh web 用一次性 token 换 HttpOnly cookie，之后的请求都要带上它。 */
async function authenticate() {
  const first = await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const cookies = (first.headers.getSetCookie?.() ?? []).map((value) => value.split(';')[0]).join('; ')
  if (cookies.length === 0) throw new Error(`握手失败：HTTP ${first.status}，未拿到 auth cookie`)
  return cookies
}

const cookie = await authenticate()
const html = await (await fetch(`${origin}/?token=${encodeURIComponent(token)}`, { headers: { cookie } })).text()

const marker = 'globalThis["__DSH_BOOT__"]'
const at = html.indexOf(marker)
if (at === -1) {
  console.error('FAIL: no __DSH_BOOT__ in index')
  process.exit(1)
}

const eq = html.indexOf('=', at) + 1
let depth = 0
let end = -1
for (let i = eq; i < html.length; i++) {
  const ch = html[i]
  if (ch === '{' || ch === '[') depth++
  else if (ch === '}' || ch === ']') {
    depth--
    if (depth === 0) {
      end = i + 1
      break
    }
  }
}

const raw = html
  .slice(eq, end)
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>')
  .replaceAll('&quot;', '"')
  .replaceAll('&amp;', '&')
const boot = JSON.parse(raw)

const rows = boot.entries ?? [...(boot.modules ?? []), ...(boot.plugins ?? [])]
const mine = rows.filter((row) => String(row.id).startsWith('dsh-theme-studio'))

const check = (label, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) process.exitCode = 1
}

console.log(`boot: entries=${rows.length}`)
check('boot 图里出现本插件', mine.length > 0, mine.map((row) => row.id).join(',') || 'not found')

if (mine.length === 0) {
  console.log('所有 id：', rows.map((row) => row.id).join(', '))
  process.exit(1)
}

const row = mine[0]
console.log('row =', JSON.stringify({ id: row.id, url: row.url, initialUrl: row.initialUrl, external: row.external, inject: row.inject, immediately: row.immediately }, null, 2))

check('row 带 bundle URL', typeof (row.url ?? row.initialUrl) === 'string')
check('external 已声明 ui-settings', (row.external ?? []).includes('@deepseek-ai/dsh-client-ui-settings'), JSON.stringify(row.external))
check('immediately=true（启动阶段预取）', row.immediately === true, String(row.immediately))

const url = row.url ?? row.initialUrl
const response = await fetch(`${origin}${url}`, { headers: { cookie } })
const bundle = await response.text()
check('bundle 可拉取', response.status === 200, `HTTP ${response.status}, ${bundle.length} bytes`)
check('bundle 是惰性 CJS 包装', bundle.includes('__ModuleLoader__.load(') && bundle.includes('factory: (require)'))
check('bundle 注册 id 正确', bundle.includes("id: 'dsh-theme-studio'") || bundle.includes('id: "dsh-theme-studio"'))
check('bundle 含设置页注册', bundle.includes('settings.section'))
check('bundle 含分区选择器', bundle.includes('Sixlwa_bubble'))
check('bundle 含真实设置页类名', bundle.includes('VOzbGW_panel'))
// 0.1.15 起「边栏」分区重新接管侧栏与顶边栏，两条选择器都该在 bundle 里。
check('bundle 含边栏的两条选择器（侧栏 + 顶边栏）',
  bundle.includes("'.hHd-Xa_root'") && bundle.includes("'.wSkVaW_header'"))
// 0.1.13 / 0.1.14 删掉的分区不得残留选择器。
check('bundle 不含已删分区的选择器（chat / panel）',
  !bundle.includes("'.pI_x6G_centerCol'") && !bundle.includes("'.VOzbGW_panel'"))
check('bundle 含背景层样式', bundle.includes('dsh-theme-studio-bg'))
check('bundle 结尾导出 apply/inject', bundle.includes('exports.apply = apply') && bundle.includes('exports.inject = inject'))
check('响应头是 JS + immutable', String(response.headers.get('content-type')).includes('javascript'), String(response.headers.get('content-type')))

// 不调用 process.exit()：Windows 上在 undici 连接还开着时强退会触发 libuv 断言。
process.exitCode = process.exitCode ?? 0
