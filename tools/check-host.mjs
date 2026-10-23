/**
 * 宿主侧回归测试：请求级安全闸门 + 版本号一致性。
 *
 * 覆盖审计报告中「P0 第 2 条（CSRF / Origin）」与「P3 第 1 条（版本号）」：
 *   - 跨站 Origin 的写请求必须 403，且配置不能被改动；
 *   - 同源 Origin 的正常 JSON 写请求必须放行；
 *   - 不带 Origin 的 JSON 写请求同样放行：非浏览器客户端路径，CSRF 防护由 Host
 *     白名单 + Origin 存在时校验 + JSON Content-Type 三件事共同承担；
 *   - 没有 config.json 时首次 GET 只回默认值、不创建文件（读不写盘）；
 *   - JSON 接口拒绝 text/plain（浏览器跨站「简单请求」不带预检就能发的那种）；
 *   - 未声明的方法返回 405 + Allow；
 *   - HEAD 与 GET 同逻辑但不带响应体；
 *   - /api/ping 的版本号与 package.json 同源，且不再泄露 dataDir。
 *
 * 用真实 http.Server + fetch 跑，而不是直接调 handler：405/Allow、HEAD 空 body、
 * 415 这些行为只有走完整 HTTP 栈才成立。
 *
 * 本文件后面还有几段独立 section：
 *   · H2（第 8–15 条）：/api/proxy 的 SSRF / SVG / 缓存；
 *   · H3（第 16–21 条）：/api/browse 的浏览范围、错误信息脱敏、路径包含判断
 *     （审计 P0 第 4 条 + P3 第 9 条）；
 *   · H4（第 22–26 条 + 24a–24h）：配置持久化 —— 并发写串行化、损坏配置只备份
 *     并拒绝覆盖（不静默回默认值）、reset 作为唯一恢复路径、ENOENT 读不写盘、
 *     写入输入校验（审计 P1 第 6/7 条）；
 *   · H5（第 27–32 条 + 27a）：/api/image 的查询参数解码与缓存验证 —— 文件名里
 *     真的含 `%XX`、未编码空格路径、If-None-Match 多值/弱比较/`*`、
 *     Last-Modified / If-Modified-Since、同长度改写后 ETag 必须变化；另外把
 *     「不存在的文件也回 403（不是 404）」这条刻意行为固定下来（审计 P1 第 8/9 条）；
 *   · H6（第 33–39 条）：/api/upload —— magic bytes 内容校验、扩展名由识别结果
 *     决定、空 body 400、文件数/总字节配额，以及超限时必须是 413 JSON 而不是
 *     掐断连接（审计 P0 第 5 条 + P1 第 14 条）；
 *   · H7（第 40–45 条）：/api/purge-cache、delete-upload / forget-url 的
 *     current/fixed 清理语义、scope / wallpaper.rotate 死配置退役、扫描截断可见
 *     （审计 P1 第 15/16/17 条 + P3 第 9 条）；
 *   · H8（第 46–63 条）：Host 白名单 / DNS rebinding —— 恶意域名 Host 的
 *     GET/HEAD/写请求一律 403，localhost / IP 字面量 / 显式允许域名正常，
 *     `*.` 通配不匹配裸域，且校验发生在读配置之前（审计 H8）；
 *   · H9（第 64–70 条）：/api/proxy 的 ETag 必须来自响应体内容 —— 同一 URL 换成
 *     同长度不同内容的 PNG 后旧 ETag 必须失效，`*` / 弱比较 / 逗号列表的协商
 *     与 /api/image 同语义（审计 H9）。
 *
 * 用法：node tools/check-host.mjs
 */

import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHost } from './lib/host-harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

const results = []
let failed = false

/**
 * 记录一条断言并打印。
 * @param label - 断言说明。
 * @param ok - 是否通过。
 * @param detail - 实际值，失败时用来定位。
 */
function check(label, ok, detail) {
  results.push(ok)
  if (!ok) failed = true
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * 读一次配置（GET），用于比较请求前后是否被改动。
 * @param origin - 宿主 origin。
 * @returns `{ status, body }`。
 */
async function readConfig(origin) {
  const response = await fetch(`${origin}/theme-studio/api/config`)
  return { status: response.status, body: await response.json() }
}

/**
 * 起一个本地上游图片服务，给 /api/proxy 的 SSRF 与内容校验用例当目标。
 *
 * 所有路径都由测试固定：`/x.png` 返回合法 PNG，`/evil.svg` 返回 SVG，
 * `/html-png` 故意用 text/html 头包 PNG 体，`/png-html` 反过来；
 * 两条重定向分别指向内网地址和同一服务的 PNG，用来验证「每跳重校验」。
 * 记录每个路径被请求的次数，缓存用例据此断言第二次没有回源。
 *
 * `/same-length.png` 的响应体可由 setPng 在用例中替换：H9 用它验证「同一 URL、
 * 相同字节数、不同内容」时代理必须换 ETag 并重新回吐实体。
 *
 * @returns `{ origin, hits, setPng, close }`。
 */
async function startUpstream() {
  const hits = new Map()
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  )
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8')
  const html = Buffer.from('<!doctype html><script>alert(1)</script>', 'utf8')
  /** `/same-length.png` 当前返回的字节；H9 会在清缓存后换成同长度的另一张图。 */
  let mutable = png

  const server = http.createServer((req, res) => {
    const pathname = new URL(String(req.url ?? '/'), 'http://127.0.0.1').pathname
    hits.set(pathname, (hits.get(pathname) ?? 0) + 1)
    if (pathname === '/same-length.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(mutable.length) })
      res.end(mutable)
      return
    }
    if (pathname === '/x.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(png.length) })
      res.end(png)
      return
    }
    if (pathname === '/evil.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': String(svg.length) })
      res.end(svg)
      return
    }
    if (pathname === '/html-png') {
      // 头撒谎、体是合法 PNG：代理必须以 magic 为准放行，并把类型改成 image/png。
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': String(png.length) })
      res.end(png)
      return
    }
    if (pathname === '/png-html') {
      // 头撒谎、体是 HTML：代理必须以 magic 为准拒绝。
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(html.length) })
      res.end(html)
      return
    }
    if (pathname === '/redir-private') {
      res.writeHead(302, { Location: 'http://10.255.255.1/' })
      res.end()
      return
    }
    if (pathname === '/redir-png') {
      // 同一服务内的相对 Location：1 跳后应当拿到合法 PNG。
      res.writeHead(302, { Location: '/x.png' })
      res.end()
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  return {
    origin: `http://127.0.0.1:${port}`,
    hits: (pathname) => hits.get(pathname) ?? 0,
    /** 替换 `/same-length.png` 的响应体（H9 用它模拟上游同长度换图）。 */
    setPng: (next) => {
      mutable = next
    },
    close: async () => {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * 取一个「刚被释放」的本地端口：先 listen(0) 让系统分配一个空闲端口，再关掉服务器。
 *
 * 用来模拟「连接被拒绝」的上游：/api/proxy 指向它必须 502，且响应体不能出现
 * 地址与端口（审计 P0 第 3 条：错误文案本身就是内网端口探测器）。
 * @returns 端口号。
 */
async function findClosedLoopbackPort() {
  const server = http.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve) => server.close(() => resolve()))
  return port
}

/**
 * 解析 JSON 文本；失败返回空对象。
 *
 * 断言里直接 JSON.parse 会让一条坏响应把整段测试抛进外层 catch，后面的用例
 * 全部不执行；这里让坏响应变成「字段缺失」，由对应断言正常判 FAIL。
 * @param text - 响应体。
 * @returns 解析出的对象或 {}。
 */
function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/**
 * 用 node:http 发一个可以自定义 Host 头的请求。
 *
 * 为什么不用 fetch：fetch 规范把 Host 列为脚本禁止设置的请求头，而 DNS rebinding
 * 用例必须伪造 Host（TCP 连接仍然打到 127.0.0.1 上的测试宿主）。setHost: false
 * 关掉 Node 自动生成 Host，再由 headers.Host 显式给出。
 *
 * @param origin - 宿主 origin（http://127.0.0.1:<port>）。
 * @param pathname - 路径 + 查询串。
 * @param options - `{ method?, host?, headers?, body? }`；host 省略时不发 Host 头。
 * @returns `{ status, body }`（body 按 utf8 解码）。
 */
function rawRequest(origin, pathname, options = {}) {
  const { method = 'GET', host, headers = {}, body = null } = options
  const target = new URL(origin)
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: pathname,
        method,
        setHost: false,
        headers: { ...headers, ...(host === undefined ? {} : { Host: host }) },
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    request.on('error', reject)
    if (body !== null) request.write(body)
    request.end()
  })
}

/**
 * 用裸 TCP 发一条 HTTP/1.0 请求，可以完全不带 Host 头。
 *
 * Node 的 http.Server 对 HTTP/1.1 缺失 Host 会自己在入口回 400，根本进不到插件；
 * HTTP/1.0 才允许没有 Host，用来验证「Host 缺失 → 403」是插件自己这一层生效。
 * @param origin - 宿主 origin。
 * @param pathname - 请求路径。
 * @returns 完整响应文本（含状态行与头）。
 */
function rawHttp10(origin, pathname) {
  const target = new URL(origin)
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(target.port), target.hostname, () => {
      socket.write(`GET ${pathname} HTTP/1.0\r\n\r\n`)
    })
    let response = ''
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8')
    })
    socket.on('end', () => resolve(response))
    socket.on('error', reject)
  })
}

let host
try {
  const started = await startHost()
  host = started
  const { origin } = started

  /* 0) 第一次 GET /api/config：临时 DSH_HOME 里没有 config.json，必须走 ENOENT
   * 分支回默认值，且绝不落盘。这里留 150ms 观察窗口（与第 25 条同一理由），
   * 旧实现「读触发迁移写」会在这个窗口内把 theme-studio/config.json 写出来。 */
  const firstRead = await readConfig(origin)
  const configFile = path.join(started.home, 'theme-studio', 'config.json')
  await new Promise((resolve) => setTimeout(resolve, 150))
  check(
    '0) 没有 config.json 时首次 GET /api/config → 200，且不会创建该文件（读不写盘）',
    firstRead.status === 200 && !fs.existsSync(configFile),
    `status=${firstRead.status} exists=${fs.existsSync(configFile)}`,
  )

  /* 1) 版本号与元数据：ping 必须读 package.json，且不能回 dataDir。 */
  const ping = await fetch(`${origin}/theme-studio/api/ping`)
  const pingBody = await ping.json()
  check(
    '1) /api/ping 的 version 等于 package.json 的 version，且响应里没有 dataDir',
    ping.status === 200 &&
      pingBody.version === pkg.version &&
      !Object.prototype.hasOwnProperty.call(pingBody, 'dataDir'),
    `status=${ping.status} version=${pingBody.version} keys=${Object.keys(pingBody).join(',')}`,
  )

  /* 2) 跨站写请求：Origin 与 Host 不一致 → 403，且配置不能变。 */
  const beforeCrossSite = await readConfig(origin)
  const crossSite = await fetch(`${origin}/theme-studio/api/config`, {
    method: 'POST',
    headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ glass: { bars: { opacity: 0.123 } } }),
  })
  const crossSiteBody = await crossSite.json()
  const afterCrossSite = await readConfig(origin)
  check(
    '2) Origin: http://evil.example 的 POST /api/config → 403 且配置未被改动',
    crossSite.status === 403 &&
      crossSiteBody.ok === false &&
      JSON.stringify(beforeCrossSite.body.config) === JSON.stringify(afterCrossSite.body.config),
    `status=${crossSite.status} error=${crossSiteBody.error} opacity=${afterCrossSite.body.config?.glass?.bars?.opacity}`,
  )

  /* 3) 同源写请求：Node fetch 默认不发 Origin，必须手动加头才走到校验分支。 */
  const sameOrigin = await fetch(`${origin}/theme-studio/api/config`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ glass: { bars: { opacity: 0.234 } } }),
  })
  const sameOriginBody = await sameOrigin.json()
  check(
    '3) 同源 Origin（手动加头）的 JSON POST /api/config → 200',
    sameOrigin.status === 200 && sameOriginBody.config?.glass?.bars?.opacity === 0.234,
    `status=${sameOrigin.status} opacity=${sameOriginBody.config?.glass?.bars?.opacity}`,
  )

  /* 4) 同源但类型是 text/plain：浏览器跨站简单请求的典型形态，必须 415 且不落盘。 */
  const plain = await fetch(`${origin}/theme-studio/api/config`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'text/plain' },
    body: JSON.stringify({ glass: { bars: { opacity: 0.345 } } }),
  })
  const plainBody = await plain.json()
  const afterPlain = await readConfig(origin)
  check(
    '4) 同源但 Content-Type: text/plain 的 POST /api/config → 415 且未写入',
    plain.status === 415 && afterPlain.body.config?.glass?.bars?.opacity === 0.234,
    `status=${plain.status} error=${plainBody.error} opacity=${afterPlain.body.config?.glass?.bars?.opacity}`,
  )

  /* 4a) 刻意行为：curl / 脚本 / 测试这类非浏览器客户端不会发 Origin，必须放行。
   * CSRF 防护由三件事共同承担 —— Host 白名单（挡 DNS rebinding）、Origin 存在时
   * 必须与 Host 同值、JSON 接口强制 application/json（浏览器跨站只能发 text/plain
   * 简单请求，被第 4 条的 415 挡掉；真要发 JSON 必先过预检）。没有 Origin 的请求
   * 如果也拒绝，所有命令行用法都会失效，而防护并没有变强。 */
  const noOrigin = await fetch(`${origin}/theme-studio/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ glass: { bars: { opacity: 0.456 } } }),
  })
  const noOriginBody = await noOrigin.json()
  const afterNoOrigin = await readConfig(origin)
  check(
    '4a) 不带 Origin 的 JSON POST /api/config → 200（非浏览器客户端放行）',
    noOrigin.status === 200 &&
      noOriginBody.config?.glass?.bars?.opacity === 0.456 &&
      afterNoOrigin.body.config?.glass?.bars?.opacity === 0.456,
    `status=${noOrigin.status} opacity=${noOriginBody.config?.glass?.bars?.opacity} persisted=${afterNoOrigin.body.config?.glass?.bars?.opacity}`,
  )

  /* 5) 未声明的方法：DELETE 打只读接口 → 405 + Allow。 */
  const deleted = await fetch(`${origin}/theme-studio/api/folders`, { method: 'DELETE' })
  const allow = deleted.headers.get('allow') ?? ''
  const deletedBody = await deleted.json()
  check(
    '5) DELETE /api/folders → 405 且带 Allow 头',
    deleted.status === 405 && allow.length > 0,
    `status=${deleted.status} allow=${JSON.stringify(allow)} error=${deletedBody.error}`,
  )

  /* 6) HEAD 复用 GET 逻辑：状态与响应头照发，body 必须为空。 */
  const head = await fetch(`${origin}/theme-studio/api/ping`, { method: 'HEAD' })
  const headBody = await head.text()
  check(
    '6) HEAD /api/ping → 200、响应头为 JSON 且 body 为空',
    head.status === 200 &&
      headBody === '' &&
      (head.headers.get('content-type') ?? '').includes('application/json'),
    `status=${head.status} body=${JSON.stringify(headBody)} content-type=${head.headers.get('content-type')}`,
  )

  /* 7) 普通 GET 读配置仍然正常（闸门不能把只读路径也挡掉）。 */
  const gotConfig = await readConfig(origin)
  check(
    '7) 普通 GET /api/config → 200',
    gotConfig.status === 200 && gotConfig.body.ok === true,
    `status=${gotConfig.status}`,
  )

  /* ═════════ H2：/api/proxy 的 SSRF / SVG / 缓存正确性 ═════════
   *
   * 上游是本进程起的回环 http 服务，所以必须用 DSH_THEME_STUDIO_ALLOW_LOOPBACK=1
   * 测试钩子放行 127.0.0.1；第一条用例专门验证「不设钩子时仍然 403」。
   * 两套策略用两个隔离宿主：开关在 startHost({ env }) 导入插件前写入 process.env。
   */
  {
    const upstream = await startUpstream()
    let envHost
    const proxyUrl = (hostOrigin, target) =>
      `${hostOrigin}/theme-studio/api/proxy?url=${encodeURIComponent(target)}`

    try {
      /* 8) 未设置测试钩子时，回环上游必须被 SSRF 校验拒绝。 */
      const previousHook = process.env.DSH_THEME_STUDIO_ALLOW_LOOPBACK
      delete process.env.DSH_THEME_STUDIO_ALLOW_LOOPBACK
      let blockedStatus = 0
      let blockedError = ''
      try {
        const blocked = await fetch(proxyUrl(origin, `${upstream.origin}/x.png`), {
          signal: AbortSignal.timeout(3000),
        })
        blockedStatus = blocked.status
        const body = await blocked.json().catch(() => ({}))
        blockedError = String(body.error ?? '')
      } catch (error) {
        blockedError = String(error?.message ?? error)
      } finally {
        if (previousHook === undefined) delete process.env.DSH_THEME_STUDIO_ALLOW_LOOPBACK
        else process.env.DSH_THEME_STUDIO_ALLOW_LOOPBACK = previousHook
      }
      check(
        '8) 未设置 DSH_THEME_STUDIO_ALLOW_LOOPBACK 时代理 127.0.0.1 → 403（SSRF 拦截）',
        blockedStatus === 403 && /内网|环回/.test(blockedError),
        `status=${blockedStatus} error=${blockedError}`,
      )

      // 后面的用例需要访问回环上游，换一个带测试钩子的宿主。
      await host.close()
      envHost = await startHost({ env: { DSH_THEME_STUDIO_ALLOW_LOOPBACK: '1' } })
      const loopbackOrigin = envHost.origin

      /* 9) SVG：上游类型就是 image/svg+xml，必须 415，不能回吐成同源文档。 */
      const svgResponse = await fetch(proxyUrl(loopbackOrigin, `${upstream.origin}/evil.svg`))
      const svgBody = await svgResponse.json()
      check(
        '9) 上游 image/svg+xml → 415 且原因说明拒绝 SVG',
        svgResponse.status === 415 && /SVG/i.test(String(svgBody.error)),
        `status=${svgResponse.status} error=${svgBody.error}`,
      )

      /* 10) 上游头是 text/html、体是合法 PNG：以 magic 为准 → 200 image/png。 */
      const disguised = await fetch(proxyUrl(loopbackOrigin, `${upstream.origin}/html-png`))
      const disguisedBytes = Buffer.from(await disguised.arrayBuffer())
      check(
        '10) 上游 text/html + PNG 体 → 200 且 Content-Type: image/png（以 magic 为准）',
        disguised.status === 200 &&
          disguised.headers.get('content-type') === 'image/png' &&
          disguisedBytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
        `status=${disguised.status} content-type=${disguised.headers.get('content-type')} bytes=${disguisedBytes.length}`,
      )

      /* 11) 上游头是 image/png、体是 HTML：文件头不认 → 415。 */
      const fake = await fetch(proxyUrl(loopbackOrigin, `${upstream.origin}/png-html`))
      const fakeBody = await fake.json()
      check(
        '11) 上游 image/png + HTML 体 → 415（文件头不是位图）',
        fake.status === 415 && /位图/.test(String(fakeBody.error)),
        `status=${fake.status} error=${fakeBody.error}`,
      )

      /* 12) 成功响应必须带 nosniff / attachment / CSP 三个硬化头。 */
      const hardened = await fetch(proxyUrl(loopbackOrigin, `${upstream.origin}/x.png`))
      const nosniff = hardened.headers.get('x-content-type-options')
      const disposition = hardened.headers.get('content-disposition') ?? ''
      const csp = hardened.headers.get('content-security-policy') ?? ''
      check(
        '12) 成功响应含 nosniff / attachment / CSP',
        hardened.status === 200 &&
          nosniff === 'nosniff' &&
          disposition === 'attachment; filename="wallpaper"' &&
          csp === "default-src 'none'; sandbox",
        `status=${hardened.status} nosniff=${nosniff} disposition=${JSON.stringify(disposition)} csp=${JSON.stringify(csp)}`,
      )

      /* 13) 同一 URL 连拉两次：第二次不应再打到上游；meta 必须记 fetchedAt。 */
      const cacheTarget = `${upstream.origin}/x.png`
      const hitsBefore = upstream.hits('/x.png')
      const firstCached = await fetch(proxyUrl(loopbackOrigin, cacheTarget))
      const secondCached = await fetch(proxyUrl(loopbackOrigin, cacheTarget))
      const hitsAfter = upstream.hits('/x.png')
      let cacheMeta = null
      try {
        const cacheDir = path.join(envHost.home, 'theme-studio', 'url-cache')
        for (const name of fs.readdirSync(cacheDir)) {
          if (!name.endsWith('.json')) continue
          const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, name), 'utf8'))
          if (meta?.url === cacheTarget) cacheMeta = meta
        }
      } catch {
        cacheMeta = null
      }
      check(
        '13) 同一 URL 连续两次不重复回源，且 .json 记录 fetchedAt',
        firstCached.status === 200 &&
          secondCached.status === 200 &&
          hitsAfter === hitsBefore &&
          typeof cacheMeta?.fetchedAt === 'number' &&
          Date.now() - cacheMeta.fetchedAt < 60_000,
        `hits=${hitsBefore}→${hitsAfter} fetchedAt=${cacheMeta?.fetchedAt} ext=${cacheMeta?.ext}`,
      )

      /* 14) 重定向到 10.255.255.1：即使 loopback 钩子打开也必须拒绝，且不能挂住。 */
      const redirectStarted = Date.now()
      let redirectStatus = 0
      let redirectError = ''
      let redirectTimedOut = false
      try {
        const redirectResponse = await fetch(proxyUrl(loopbackOrigin, `${upstream.origin}/redir-private`), {
          signal: AbortSignal.timeout(2000),
        })
        redirectStatus = redirectResponse.status
        const body = await redirectResponse.json().catch(() => ({}))
        redirectError = String(body.error ?? '')
      } catch (error) {
        redirectTimedOut = true
        redirectError = String(error?.message ?? error)
      }
      const redirectElapsed = Date.now() - redirectStarted
      check(
        '14) 重定向到私网 10.255.255.1 → 403/502，2s 内返回且不发起连接',
        !redirectTimedOut &&
          (redirectStatus === 403 || redirectStatus === 502) &&
          redirectElapsed < 2000 &&
          /内网|保留|重定向/.test(redirectError),
        `status=${redirectStatus} elapsed=${redirectElapsed}ms error=${redirectError}`,
      )

      /* 15) 重定向到同一上游的 PNG（1 跳）→ 200。 */
      const redirected = await fetch(proxyUrl(loopbackOrigin, `${upstream.origin}/redir-png`), {
        signal: AbortSignal.timeout(3000),
      })
      const redirectedBytes = Buffer.from(await redirected.arrayBuffer())
      check(
        '15) 重定向到同一上游的 PNG（1 跳）→ 200 image/png',
        redirected.status === 200 &&
          redirected.headers.get('content-type') === 'image/png' &&
          redirectedBytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
        `status=${redirected.status} content-type=${redirected.headers.get('content-type')} bytes=${redirectedBytes.length}`,
      )
    } finally {
      if (envHost !== undefined) {
        try {
          await envHost.close()
        } catch (error) {
          console.error('关闭代理测试宿主失败：', error)
        }
      }
      await upstream.close().catch((error) => console.error('关闭测试上游失败：', error))
    }
  }

  /* ═════════ H3：/api/browse 的浏览范围 + 错误信息脱敏 ═════════
   *
   * 审计 P0 第 4 条：原本 /api/browse 直接 readdir 任意路径（`path=C:\` 都能列出
   * 23 个目录），等于一个无需登录的全盘目录浏览器。现在的白名单是
   * 「用户主目录 + 配置里登记的目录」之内及其祖先目录（上一级导航用），盘根与
   * 系统目录一律 403；失败响应不得回显宿主绝对路径。
   *
   * 代理用例（第 21 条）需要访问回环上游，所以这里用一个带
   * DSH_THEME_STUDIO_ALLOW_LOOPBACK=1 的独立宿主；前三步会用 PUT /api/config
   * 登记临时目录（放在本宿主的临时 DSH_HOME 下，不碰用户真实配置）。
   */
  {
    let h3Host
    try {
      h3Host = await startHost({ env: { DSH_THEME_STUDIO_ALLOW_LOOPBACK: '1' } })
      const h3Origin = h3Host.origin

      /* 这里不需要预热读配置：临时 DSH_HOME 里没有 config.json，首次读只会回默认值、
       * 不会留下任何后台写；目录登记由第 18 条的 PUT /api/config 完成。 */
      const browseUrl = (target) =>
        `${h3Origin}/theme-studio/api/browse?path=${encodeURIComponent(target)}`

      /* 16) 盘根必须 403：这是审计里「全盘目录浏览器」的入口。 */
      const rootResponse = await fetch(browseUrl('C:\\'))
      const rootBody = await rootResponse.json()
      check(
        '16) GET /api/browse?path=C:\\ → 403 且不回显路径',
        rootResponse.status === 403 &&
          rootBody.ok === false &&
          !('path' in rootBody) &&
          !('dirs' in rootBody),
        `status=${rootResponse.status} error=${rootBody.error} keys=${Object.keys(rootBody).join(',')}`,
      )

      /* 17) 主目录是白名单的默认根（空 path 也走这里）。 */
      const homeResponse = await fetch(browseUrl(os.homedir()))
      const homeBody = await homeResponse.json()
      check(
        '17) GET /api/browse?path=<os.homedir()> → 200 且 ok=true',
        homeResponse.status === 200 && homeBody.ok === true && Array.isArray(homeBody.dirs),
        `status=${homeResponse.status} ok=${homeBody.ok} dirs=${(homeBody.dirs ?? []).length}`,
      )

      /* 18) 通过 PUT /api/config 登记临时目录：它本身与它的父目录（祖先）都可浏览。 */
      const registered = path.join(h3Host.home, 'browse-root')
      await fs.promises.mkdir(path.join(registered, 'sub'), { recursive: true })
      const putResponse = await fetch(`${h3Origin}/theme-studio/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallpaper: { folders: [registered] } }),
      })
      const putBody = await putResponse.json()
      const registeredResponse = await fetch(browseUrl(registered))
      const registeredBody = await registeredResponse.json()
      const ancestor = path.dirname(registered)
      const ancestorResponse = await fetch(browseUrl(ancestor))
      const ancestorBody = await ancestorResponse.json()
      check(
        '18) 登记临时目录后 browse 它 → 200，browse 父目录（祖先）→ 200',
        putResponse.status === 200 &&
          (putBody.config?.wallpaper?.folders ?? []).includes(registered) &&
          registeredResponse.status === 200 &&
          registeredBody.ok === true &&
          (registeredBody.dirs ?? []).some((dir) => dir.name === 'sub') &&
          ancestorResponse.status === 200 &&
          ancestorBody.ok === true,
        `put=${putResponse.status} rootStatus=${registeredResponse.status} rootOk=${registeredBody.ok} dirs=${(registeredBody.dirs ?? []).length} parentStatus=${ancestorResponse.status} parentOk=${ancestorBody.ok}`,
      )

      /* 19) 系统目录即使真实存在也不在白名单里。 */
      const windowsResponse = await fetch(browseUrl('C:\\Windows'))
      const windowsBody = await windowsResponse.json()
      check(
        '19) GET /api/browse?path=C:\\Windows → 403',
        windowsResponse.status === 403 && windowsBody.ok === false && !('path' in windowsBody),
        `status=${windowsResponse.status} error=${windowsBody.error}`,
      )

      /* 20) 文件路径不是目录：ok:false，且响应体里不能出现宿主绝对路径。 */
      const filePath = path.join(registered, 'not-a-directory.png')
      await fs.promises.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      const fileResponse = await fetch(browseUrl(filePath))
      const fileBody = await fileResponse.json()
      const fileText = JSON.stringify(fileBody)
      check(
        '20) browse 一个文件路径 → ok:false 且响应不含宿主路径',
        fileBody.ok === false &&
          !('path' in fileBody) &&
          !fileText.includes(h3Host.home) &&
          !fileText.includes('C:\\Windows'),
        `status=${fileResponse.status} body=${fileText.slice(0, 160)}`,
      )

      /* 21) 代理一个已关闭的回环端口：502，响应文本里不能出现地址与端口号。 */
      const closedPort = await findClosedLoopbackPort()
      const closedTarget = `http://127.0.0.1:${closedPort}/x.png`
      const closedResponse = await fetch(
        `${h3Origin}/theme-studio/api/proxy?url=${encodeURIComponent(closedTarget)}`,
        { signal: AbortSignal.timeout(5000) },
      )
      const closedText = await closedResponse.text()
      check(
        '21) 代理已关闭的本地端口 → 502 且不含 127.0.0.1 / 端口号',
        closedResponse.status === 502 &&
          closedText.includes('拉取失败') &&
          !closedText.includes('127.0.0.1') &&
          !closedText.includes(String(closedPort)),
        `status=${closedResponse.status} body=${closedText.slice(0, 160)}`,
      )
    } finally {
      if (h3Host !== undefined) {
        try {
          await h3Host.close()
        } catch (error) {
          console.error('关闭浏览/脱敏测试宿主失败：', error)
        }
      }
    }
  }

  /* ═════ H4：配置持久化（并发写 / 损坏拒绝覆盖 / 读不写盘 / 输入校验） ═════════
   *
   * 审计 P1 第 6 条：损坏的 config.json 被静默覆盖成出厂配置、接口仍回 200 默认值；
   * 审计 P1 第 7 条：同一进程并发写共用 `${pid}.tmp`，导致 500 与内存/磁盘分叉。
   *
   * 三条独立用例各起一个隔离宿主（每次 import 都拿到全新的 configCache）：
   *   · h4Host      并发写 + 输入校验；
   *   · corruptHost 损坏配置的备份、500 拒绝覆盖与 reset 恢复；
   *   · missingHost 文件不存在时读操作不得写盘。
   * 后两个用例结束立刻 close；h4Host 的最后一条输入校验要用到前面的结果，所以留到
   * finally 统一关闭。close 会删掉临时 DSH_HOME，不能让后台写跨过 close。
   */
  {
    let h4Host
    let corruptHost
    let missingHost
    try {
      /* ── 22/23) 20 个并发 PUT：全部成功、无残留 tmp、cache/磁盘/GET 三方一致 ──
       *
       * 每个请求都写一个**独有的顶层键** + 自己的 accent.rgb。串行队列下，最后完成的
       * 那次响应必然包含全部 20 个键（它读到了前面 19 次合并后的 cache）；靠这个
       * 特征就能认出「最后一次写」，而不依赖网络到达顺序。 */
      h4Host = await startHost()
      const h4Origin = h4Host.origin
      const h4Dir = path.join(h4Host.home, 'theme-studio')
      const h4ConfigFile = path.join(h4Dir, 'config.json')
      const concurrent = 20
      const markerPrefix = 'h4mark'
      const markers = Array.from({ length: concurrent }, (_, index) => `${markerPrefix}${index}`)
      const responses = await Promise.all(
        markers.map((marker, index) =>
          fetch(`${h4Origin}/theme-studio/api/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              [marker]: index,
              accent: { rgb: [index, 128 + index, 255 - index] },
              glass: { border: Number((index / 100).toFixed(2)) },
            }),
          }).then(async (response) => ({ status: response.status, body: await response.json() })),
        ),
      )
      const afterConcurrent = await readConfig(h4Origin)
      const leftoverTmp = fs.existsSync(h4Dir) ? fs.readdirSync(h4Dir).filter((name) => name.endsWith('.tmp')) : []
      const diskText = fs.readFileSync(h4ConfigFile, 'utf8')
      const diskConfig = JSON.parse(diskText)
      check(
        '22) 20 并发 PUT /api/config 全部 200，GET 与磁盘一致且无残留 *.tmp',
        responses.every((item) => item.status === 200 && item.body.ok === true) &&
          afterConcurrent.status === 200 &&
          markers.every((key) => key in (afterConcurrent.body.config ?? {})) &&
          JSON.stringify(afterConcurrent.body.config) === JSON.stringify(diskConfig) &&
          leftoverTmp.length === 0,
        `statuses=${responses.map((item) => item.status).join(',')} tmp=${leftoverTmp.join(',') || 'none'} keys=${Object.keys(afterConcurrent.body.config ?? {}).length}`,
      )

      /* 「最后一次写」＝唯一一个响应里已经包含全部 marker 的请求。它的 config 必须
       * 与最终 GET 完全一致 —— 证明 cache 没有被先完成的写回退，磁盘也没有落后。 */
      const winners = responses.filter(
        (item) => item.body.config !== undefined && markers.every((key) => key in item.body.config),
      )
      check(
        '23) 并发写入后 config.json 可解析，最后完成的那次响应与最终 GET 一致',
        winners.length === 1 &&
          JSON.stringify(winners[0].body.config) === JSON.stringify(afterConcurrent.body.config) &&
          JSON.stringify(diskConfig) === JSON.stringify(afterConcurrent.body.config),
        `winners=${winners.length} border=${afterConcurrent.body.config?.glass?.border} diskBorder=${diskConfig?.glass?.border}`,
      )

      /* ── 24a–24h) 损坏配置：只备份、绝不静默回默认值，reset 是唯一恢复路径 ──
       *
       * 用半截 JSON 复现审计 P1 第 6 条：旧实现 catch 成 {}，先把默认配置写回
       * config.json，再返回 200 默认值 —— 客户端完全不知道出过事，用户之后随手
       * 保存一次，备份之外就再无原始数据。新语义：原字节一动不动，所有依赖配置
       * 的接口 500 + code=CONFIG_CORRUPT（固定中文文案，只含备份基名），只有
       * POST /api/reset 能备份后写回出厂值并恢复接口。 */
      corruptHost = await startHost()
      const corruptOrigin = corruptHost.origin
      const corruptDir = path.join(corruptHost.home, 'theme-studio')
      const corruptFile = path.join(corruptDir, 'config.json')
      await fs.promises.mkdir(corruptDir, { recursive: true })
      const corruptBytes = Buffer.from('{"version":2, "glass": {"bars": {"opacity": 0.3}', 'utf8')
      await fs.promises.writeFile(corruptFile, corruptBytes)
      const listBackups = () =>
        fs.readdirSync(corruptDir).filter((name) => name.startsWith('config.json.corrupt-'))

      /* 24a) 第一次 GET：必须 500 + code，不能是 200 默认值；文案含「配置损坏」与
       * 备份文件基名，且绝不能出现盘符 / 反斜杠 / 绝对路径。 */
      const corruptResponse = await fetch(`${corruptOrigin}/theme-studio/api/config`)
      const corruptBody = await corruptResponse.json()
      const corruptError = String(corruptBody.error ?? '')
      const backups = listBackups()
      const backupName = backups[0] ?? ''
      const errorHasPath =
        corruptError.includes(corruptDir) || corruptError.includes('\\') || /[A-Za-z]:[\\/]/.test(corruptError)
      check(
        '24a) 损坏配置 → GET /api/config 500 + CONFIG_CORRUPT，文案含备份基名且不含绝对路径',
        corruptResponse.status === 500 &&
          corruptBody.ok === false &&
          corruptBody.code === 'CONFIG_CORRUPT' &&
          corruptError.includes('配置损坏') &&
          /config\.json\.corrupt-\d{8}-\d{6}/.test(backupName) &&
          corruptError.includes(backupName) &&
          !errorHasPath,
        `status=${corruptResponse.status} code=${corruptBody.code} error=${corruptError.slice(0, 160)} backup=${backupName || 'none'}`,
      )

      /* 24b) 原文件字节必须与写入时逐字节相等（没被默认配置覆盖）；备份同时存在
       * 且与原始坏字节逐字节相等。 */
      check(
        '24b) 损坏时 config.json 原字节未被覆盖，备份与原坏字节逐字节相等',
        backups.length === 1 &&
          fs.readFileSync(corruptFile).equals(corruptBytes) &&
          fs.readFileSync(path.join(corruptDir, backups[0])).equals(corruptBytes),
        `backups=${backups.join(',') || 'none'} unchanged=${fs.readFileSync(corruptFile).equals(corruptBytes)}`,
      )

      /* 24c) 第二次 GET：仍 500；备份只做一次（不能每次读都堆一份 corrupt-*）。 */
      const corruptAgain = await fetch(`${corruptOrigin}/theme-studio/api/config`)
      const corruptAgainBody = await corruptAgain.json()
      check(
        '24c) 第二次 GET 仍 500，备份文件仍只有 1 个（不重复备份）',
        corruptAgain.status === 500 &&
          corruptAgainBody.code === 'CONFIG_CORRUPT' &&
          listBackups().length === 1,
        `status=${corruptAgain.status} backups=${listBackups().length}`,
      )

      /* 24d) 写接口：合法 JSON patch 也必须 500，且不产生任何落盘。写方法闸门要求
       * 同源 Origin + application/json。 */
      const corruptPut = await fetch(`${corruptOrigin}/theme-studio/api/config`, {
        method: 'PUT',
        headers: { Origin: corruptOrigin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accent: { rgb: [7, 8, 9] }, h4CorruptShouldNotPersist: true }),
      })
      const corruptPutBody = await corruptPut.json()
      check(
        '24d) 损坏时 PUT /api/config → 500 CONFIG_CORRUPT，原文件仍未被改写',
        corruptPut.status === 500 &&
          corruptPutBody.code === 'CONFIG_CORRUPT' &&
          fs.readFileSync(corruptFile).equals(corruptBytes),
        `status=${corruptPut.status} code=${corruptPutBody.code} unchanged=${fs.readFileSync(corruptFile).equals(corruptBytes)}`,
      )

      /* 24e) 其它读配置的接口同样 500，不能走「默认值路径」；文案与 GET 完全一致。 */
      const corruptFolders = await fetch(`${corruptOrigin}/theme-studio/api/folders`)
      const corruptFoldersBody = await corruptFolders.json()
      check(
        '24e) 损坏时 GET /api/folders 也 500 CONFIG_CORRUPT，文案与 GET /api/config 一致',
        corruptFolders.status === 500 &&
          corruptFoldersBody.code === 'CONFIG_CORRUPT' &&
          corruptFoldersBody.error === corruptError,
        `status=${corruptFolders.status} code=${corruptFoldersBody.code}`,
      )

      /* 24f) 健康检查不读配置：损坏时必须仍然 200。 */
      const corruptPing = await fetch(`${corruptOrigin}/theme-studio/api/ping`)
      const corruptPingBody = await corruptPing.json()
      check(
        '24f) 损坏时 GET /api/ping 不受影响 → 200',
        corruptPing.status === 200 && corruptPingBody.ok === true,
        `status=${corruptPing.status} ok=${corruptPingBody.ok}`,
      )

      /* 24g) 唯一恢复路径：reset 备份成功后才写回 defaultConfig，并解除损坏状态。 */
      const corruptDefaults = corruptHost.api.defaultConfig()
      const corruptReset = await fetch(`${corruptOrigin}/theme-studio/api/reset`, {
        method: 'POST',
        headers: { Origin: corruptOrigin, 'Content-Type': 'application/json' },
        body: '{}',
      })
      const corruptResetBody = await corruptReset.json()
      let resetDiskConfig = null
      try {
        resetDiskConfig = JSON.parse(fs.readFileSync(corruptFile, 'utf8'))
      } catch {
        resetDiskConfig = null
      }
      const afterResetGet = await fetch(`${corruptOrigin}/theme-studio/api/config`)
      const afterResetGetBody = await afterResetGet.json()
      check(
        '24g) 损坏后 POST /api/reset → 200，config.json 写回 defaultConfig，GET /api/config 恢复 200',
        corruptReset.status === 200 &&
          corruptResetBody.ok === true &&
          JSON.stringify(corruptResetBody.config) === JSON.stringify(corruptDefaults) &&
          resetDiskConfig !== null &&
          JSON.stringify(resetDiskConfig) === JSON.stringify(corruptDefaults) &&
          afterResetGet.status === 200 &&
          JSON.stringify(afterResetGetBody.config) === JSON.stringify(corruptDefaults),
        `reset=${corruptReset.status} get=${afterResetGet.status} diskValid=${resetDiskConfig !== null} backups=${listBackups().length}`,
      )

      /* 24h) reset 之后写接口恢复正常：PUT 能落盘，GET 也能读到。 */
      const afterResetPut = await fetch(`${corruptOrigin}/theme-studio/api/config`, {
        method: 'PUT',
        headers: { Origin: corruptOrigin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accent: { rgb: [9, 8, 7] } }),
      })
      const afterResetPutBody = await afterResetPut.json()
      let afterResetPutDisk = null
      try {
        afterResetPutDisk = JSON.parse(fs.readFileSync(corruptFile, 'utf8'))
      } catch {
        afterResetPutDisk = null
      }
      check(
        '24h) reset 之后 PUT /api/config 恢复正常：200 且磁盘上出现新值',
        afterResetPut.status === 200 &&
          afterResetPutBody.ok === true &&
          JSON.stringify(afterResetPutBody.config?.accent?.rgb) === JSON.stringify([9, 8, 7]) &&
          JSON.stringify(afterResetPutDisk?.accent?.rgb) === JSON.stringify([9, 8, 7]),
        `status=${afterResetPut.status} rgb=${JSON.stringify(afterResetPutBody.config?.accent?.rgb)} disk=${JSON.stringify(afterResetPutDisk?.accent?.rgb)}`,
      )
      await corruptHost.close()
      corruptHost = undefined

      /* ── 25) ENOENT：读配置只返回默认值，绝不能凭空创建 config.json ──
       *
       * 先放一份合法配置再删掉，确保进入的是「文件不存在」分支而不是「首次使用碰巧
       * 没有文件」。旧实现会因为 migrated !== raw 而触发一次迁移写，把文件重新创建。 */
      missingHost = await startHost()
      const missingOrigin = missingHost.origin
      const missingDir = path.join(missingHost.home, 'theme-studio')
      const missingFile = path.join(missingDir, 'config.json')
      await fs.promises.mkdir(missingDir, { recursive: true })
      await fs.promises.writeFile(missingFile, '{"version":2,"enabled":true}\n')
      await fs.promises.rm(missingFile)
      const missingResponse = await fetch(`${missingOrigin}/theme-studio/api/config`)
      const missingBody = await missingResponse.json()
      // 给任何「读触发写」留出窗口：旧实现在这里一定会重新创建文件。
      await new Promise((resolve) => setTimeout(resolve, 150))
      const missingDefaults = missingHost.api.defaultConfig()
      check(
        '25) config.json 不存在 → GET 返回默认值且不会凭空创建文件（读不写盘）',
        missingResponse.status === 200 &&
          JSON.stringify(missingBody.config) === JSON.stringify(missingDefaults) &&
          !fs.existsSync(missingFile),
        `status=${missingResponse.status} exists=${fs.existsSync(missingFile)} keys=${Object.keys(missingBody.config ?? {}).length}`,
      )
      await missingHost.close()
      missingHost = undefined

      /* ── 26) 非对象的 patch：必须是 400，而不是被兜底成 500 ── */
      const arrayPut = await fetch(`${h4Origin}/theme-studio/api/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '[]',
      })
      const arrayBody = await arrayPut.json()
      const afterArray = await readConfig(h4Origin)
      check(
        '26) PUT /api/config body 为 [] → 400（不是 500）且配置未被改写',
        arrayPut.status === 400 &&
          arrayBody.ok === false &&
          /对象/.test(String(arrayBody.error)) &&
          JSON.stringify(afterArray.body.config) === JSON.stringify(afterConcurrent.body.config),
        `status=${arrayPut.status} error=${arrayBody.error}`,
      )
    } finally {
      for (const [instance, label] of [
        [missingHost, '缺失配置'],
        [corruptHost, '损坏配置'],
        [h4Host, '并发写'],
      ]) {
        if (instance === undefined) continue
        try {
          await instance.close()
        } catch (error) {
          console.error(`关闭${label}测试宿主失败：`, error)
        }
      }
    }
  }

  /* ═════════ H5：/api/image 的查询解码 + 缓存验证 ═════════
   *
   * 审计 P1 第 9 条：queryParam 在 searchParams 已经解码之后又 decodeURIComponent
   * 一次，文件名里真的含 `%20` 时被解成空格，请求 403。
   * 审计 P1 第 8 条：ETag 只看「字节数 + 路径」，同长度改写文件后永远 304，
   * 浏览器继续显示旧壁纸。
   *
   * 起一个隔离宿主，在它的临时 DSH_HOME 下建 pics/ 并通过 PUT /api/config 登记，
   * 全程不碰用户真实目录。图片内容用同一份 1×1 PNG，便于按字节比较。
   */
  {
    let h5Host
    try {
      h5Host = await startHost()
      const h5Origin = h5Host.origin
      const h5Api = `${h5Origin}/theme-studio/api`

      /* 同样不需要预热读配置：首次读（无 config.json）不写盘，下面登记目录的
       * PUT /api/config 会自己创建数据目录。 */
      const pics = path.join(h5Host.home, 'pics')
      await fs.promises.mkdir(pics, { recursive: true })
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      )
      const plainPath = path.join(pics, 'plain.png')
      // 文件名里是**字面**的 `%20` 三个字符，不是空格。
      const percentPath = path.join(pics, 'c%20d.png')
      // 文件名里是真的空格，用来测「未编码路径直接拼进 query」。
      const spacePath = path.join(pics, 'a b.png')
      await fs.promises.writeFile(plainPath, png)
      await fs.promises.writeFile(percentPath, png)
      await fs.promises.writeFile(spacePath, png)

      const register = await fetch(`${h5Api}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallpaper: { folders: [pics] } }),
      })
      const registerBody = await register.json()
      const imageUrl = (file) => `${h5Api}/image?path=${encodeURIComponent(file)}`

      /* 27) 浏览器真实调用：encodeURIComponent 编一次，宿主只解一次。
       *     c%20d.png 若被二次解码会变成 c d.png → 403，是本条的回归点。 */
      const [plainResponse, percentResponse] = await Promise.all([
        fetch(imageUrl(plainPath)),
        fetch(imageUrl(percentPath)),
      ])
      const [plainBytes, percentBytes] = await Promise.all([
        plainResponse.arrayBuffer().then((buffer) => Buffer.from(buffer)),
        percentResponse.arrayBuffer().then((buffer) => Buffer.from(buffer)),
      ])
      check(
        '27) 编码后的路径：plain.png 与文件名含字面 %20 的 c%20d.png 都 200',
        register.status === 200 &&
          (registerBody.config?.wallpaper?.folders ?? []).includes(pics) &&
          plainResponse.status === 200 &&
          percentResponse.status === 200 &&
          plainBytes.equals(png) &&
          percentBytes.equals(png),
        `put=${register.status} plain=${plainResponse.status}/${plainBytes.length}B percent=${percentResponse.status}/${percentBytes.length}B`,
      )

      /* 27a) 刻意行为：请求「目录存在、文件不存在」的路径，必须回 403 而不是 404。
       * 状态码层面不再用 404 单独标记「不存在」——越权路径同样是 403，避免攻击者
       * 拿状态码做存在性探测。文案固定为「文件不存在或不可读」，不含任何绝对路径；
       * body.path 只是回显调用方自己传进来的参数（调用方本来就知道这个值），不构成
       * 宿主侧新增信息泄露。 */
      const ghostFile = path.join(pics, 'ghost-not-exists.png')
      const ghostResponse = await fetch(imageUrl(ghostFile))
      const ghostBody = await ghostResponse.json()
      const ghostError = String(ghostBody.error ?? '')
      check(
        '27a) /api/image 请求不存在的文件 → 403（不是 404），且文案不含绝对路径',
        ghostResponse.status === 403 &&
          ghostBody.ok === false &&
          ghostError === '文件不存在或不可读' &&
          !ghostError.includes(h5Host.home) &&
          !ghostError.includes(pics) &&
          !/[A-Za-z]:[\\/]/.test(ghostError) &&
          !ghostError.includes('\\'),
        `status=${ghostResponse.status} error=${ghostError}`,
      )

      /* 28) 未编码形态：把带空格的 Windows 路径直接拼进 query。URL 解析器会把
       *     空格规范化成 %20，searchParams 再解回空格 —— 不经过 decodeURIComponent
       *     也应该能拿到同一个文件。 */
      const rawSpace = await fetch(`${h5Api}/image?path=${spacePath}`)
      const rawSpaceBytes = Buffer.from(await rawSpace.arrayBuffer())
      check(
        '28) 未编码、文件名带空格的路径直接拼进 query → 200（searchParams 规范化）',
        rawSpace.status === 200 && rawSpaceBytes.equals(png),
        `status=${rawSpace.status} bytes=${rawSpaceBytes.length}`,
      )

      /* 29) 首次 200 的缓存头 + 精确 If-None-Match 的 304。304 必须无 body，
       *     且 ETag / Cache-Control 要随 304 一起回，否则浏览器无法续期缓存。 */
      const initial = await fetch(imageUrl(plainPath))
      const etag = initial.headers.get('etag')
      const lastModified = initial.headers.get('last-modified')
      const cacheControl = initial.headers.get('cache-control')
      const initialBytes = Buffer.from(await initial.arrayBuffer())
      const cached = await fetch(imageUrl(plainPath), { headers: { 'if-none-match': etag } })
      const cachedBody = await cached.text()
      check(
        '29) 200 带 ETag / Last-Modified / private max-age=60；If-None-Match 命中 → 304 且无 body',
        initial.status === 200 &&
          initialBytes.equals(png) &&
          etag !== null &&
          lastModified !== null &&
          cacheControl === 'private, max-age=60' &&
          cached.status === 304 &&
          cachedBody === '' &&
          cached.headers.get('etag') === etag &&
          cached.headers.get('cache-control') === 'private, max-age=60' &&
          cached.headers.get('last-modified') === lastModified,
        `status=${initial.status}→${cached.status} etag=${etag} lm=${JSON.stringify(lastModified)} cache=${cacheControl} body=${JSON.stringify(cachedBody)}`,
      )

      /* 30) If-None-Match 的三种形态：*、W/ 弱比较、逗号分隔多值。
       *     多值里前一个是过期标签，后一个才是当前 ETag —— 必须仍判 304。 */
      const [wildcard, weak, list] = await Promise.all([
        fetch(imageUrl(plainPath), { headers: { 'if-none-match': '*' } }),
        fetch(imageUrl(plainPath), { headers: { 'if-none-match': `W/${etag}` } }),
        fetch(imageUrl(plainPath), { headers: { 'if-none-match': `"stale", ${etag}` } }),
      ])
      check(
        '30) If-None-Match 支持 *、W/ 弱比较与逗号分隔多值 → 均 304',
        wildcard.status === 304 && weak.status === 304 && list.status === 304,
        `wildcard=${wildcard.status} weak=${weak.status} list=${list.status}`,
      )

      /* 31) 没有 If-None-Match 时退回 If-Modified-Since：拿 200 的 Last-Modified
       *     原样回传，同一秒内应判未修改（HTTP 日期只到秒）。 */
      const ims = await fetch(imageUrl(plainPath), {
        headers: { 'if-modified-since': lastModified },
      })
      check(
        '31) 无 If-None-Match 时 If-Modified-Since 命中 → 304',
        ims.status === 304,
        `status=${ims.status} if-modified-since=${JSON.stringify(lastModified)}`,
      )

      /* 32) 同长度改写：等 40ms 让 mtimeMs 跨过时间戳粒度，再把最后一个字节
       *     取反（字节数不变）。ETag 必须变化，且返回的必须是新字节 —— 这正是
       *     审计 P1 第 8 条「改图后永远 304」的回归点。 */
      await new Promise((resolve) => setTimeout(resolve, 40))
      const rewritten = Buffer.from(png)
      rewritten[rewritten.length - 1] ^= 0xff
      await fs.promises.writeFile(plainPath, rewritten)
      const changed = await fetch(imageUrl(plainPath))
      const changedBytes = Buffer.from(await changed.arrayBuffer())
      const changedEtag = changed.headers.get('etag')
      check(
        '32) 同长度改写文件后 ETag 变化 → 200 且返回新字节',
        changed.status === 200 &&
          changedEtag !== null &&
          changedEtag !== etag &&
          changedBytes.equals(rewritten),
        `status=${changed.status} etag=${etag}→${changedEtag} bytes=${changedBytes.length}`,
      )
    } finally {
      if (h5Host !== undefined) {
        try {
          await h5Host.close()
        } catch (error) {
          console.error('关闭图片缓存测试宿主失败：', error)
        }
      }
    }
  }

  /* ═════════ H6：上传链路（内容校验 / 配额 / 超限不掐断连接） ═════════
   *
   * 审计 P0 第 5 条：上传只按 name 后缀决定扩展名，内容一个字节都不验；
   * 审计 P1 第 14 条：超过上限时 readBody reject 后立刻 req.destroy()，路由的
   * JSON 响应根本写不回去，fetch 只能抛 UND_ERR_SOCKET。
   *
   * 用四个隔离宿主覆盖不同上限，全部走环境变量测试钩子，不碰真实用户目录：
   *   · h6Host      默认上限：magic 内容校验、扩展名由内容决定、空 body；
   *   · h6LimitHost 单次上传上限 1MB：超限必须是 413 JSON，之后服务仍可用；
   *   · h6FilesHost 文件数配额 2：预置 2 个文件后再传必须 413 且不写盘；
   *   · h6TotalHost 总字节配额 10：合法图片也必须 413 且不写盘。
   */
  {
    let h6Host
    let h6LimitHost
    let h6FilesHost
    let h6TotalHost
    /** 与 H2/H5 同一份 1×1 PNG（70 字节），同时服务内容校验与配额用例。 */
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    )

    /**
     * 列出宿主上传目录里的直接子文件（不递归）。
     * @param instance - startHost 的返回值。
     * @returns Dirent 数组；目录不存在时为空数组。
     */
    const listUploads = (instance) => {
      const dir = path.join(instance.home, 'theme-studio', 'wallpapers')
      try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile())
      } catch {
        return []
      }
    }

    /**
     * 比较磁盘文件内容；读取失败一律当作不相等（断言里不抛异常）。
     * @param file - 绝对路径。
     * @param expected - 期望字节。
     * @returns 是否逐字节相等。
     */
    const fileEquals = (file, expected) => {
      try {
        return fs.readFileSync(file).equals(expected)
      } catch {
        return false
      }
    }

    try {
      /* ── 33/34) 超限必须 413 JSON，且连接/服务不能被破坏 ──
       * 上限压到 1MB 再 POST 2MB：旧实现的 fetch 直接失败（没有状态码、没有可读错误）。 */
      h6LimitHost = await startHost({ env: { DSH_THEME_STUDIO_MAX_UPLOAD_BYTES: '1048576' } })
      let bigStatus = 0
      let bigError = ''
      let bigSocketFailed = false
      try {
        const bigResponse = await fetch(`${h6LimitHost.origin}/theme-studio/api/upload?name=big.png`, {
          method: 'POST',
          headers: { 'Content-Type': 'image/png' },
          body: Buffer.alloc(2 * 1024 * 1024, 0x61),
        })
        bigStatus = bigResponse.status
        const bigBody = await bigResponse.json().catch(() => ({}))
        bigError = String(bigBody.error ?? '')
      } catch (error) {
        // 旧实现走到这里：UND_ERR_SOCKET / fetch failed。出现即失败。
        bigSocketFailed = true
        bigError = String(error?.message ?? error)
      }
      check(
        '33) DSH_THEME_STUDIO_MAX_UPLOAD_BYTES=1MB 时 POST 2MB → 413 JSON（不是 socket error）',
        !bigSocketFailed && bigStatus === 413 && /请求体过大/.test(bigError),
        `socketFailed=${bigSocketFailed} status=${bigStatus} error=${bigError}`,
      )

      /* 34) 同一个宿主（同一条 keep-alive 池）立刻发一个正常 GET：服务必须完好。 */
      const pingAfterBig = await fetch(`${h6LimitHost.origin}/theme-studio/api/ping`)
      const pingAfterBigBody = await pingAfterBig.json()
      check(
        '34) 413 之后紧接着 GET /api/ping → 200，连接/服务未被破坏',
        pingAfterBig.status === 200 && pingAfterBigBody.ok === true,
        `status=${pingAfterBig.status} ok=${pingAfterBigBody.ok}`,
      )

      /* ── 35/36/37) 默认上限宿主：magic 校验、扩展名由内容决定、空 body ── */
      h6Host = await startHost()
      const uploadUrl = (name) =>
        `${h6Host.origin}/theme-studio/api/upload?name=${encodeURIComponent(name)}`

      /* 35) PNG 内容 + name=evil.jpg：扩展名必须被识别结果改写为 .png，
       *     落盘字节与原图一致 —— 客户端再也不能用 name 伪造类型。 */
      const disguisedUpload = await fetch(uploadUrl('evil.jpg'), {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: png,
      })
      const disguisedBody = await disguisedUpload.json()
      const storedPath = String(disguisedBody.path ?? '')
      const filesAfterPng = listUploads(h6Host)
      check(
        '35) 1×1 PNG 以 name=evil.jpg 上传 → 200，path 以 .png 结尾（扩展名由 magic 决定）',
        disguisedUpload.status === 200 &&
          disguisedBody.ok === true &&
          storedPath.endsWith('.png') &&
          !storedPath.endsWith('.jpg') &&
          disguisedBody.bytes === png.length &&
          disguisedBody.type === 'image/png' &&
          filesAfterPng.length === 1 &&
          fileEquals(storedPath, png),
        `status=${disguisedUpload.status} path=${storedPath} type=${disguisedBody.type} bytes=${disguisedBody.bytes} files=${filesAfterPng.length}`,
      )

      /* 36) HTML 文本 + name=x.png：没通过 magic，必须 415 且目录里不新增文件。 */
      const htmlUpload = await fetch(uploadUrl('x.png'), {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: '<!doctype html><script>alert(1)</script>',
      })
      const htmlBody = await htmlUpload.json()
      const filesAfterHtml = listUploads(h6Host)
      check(
        '36) HTML 文本以 name=x.png 上传 → 415，且上传目录没有新增文件',
        htmlUpload.status === 415 &&
          htmlBody.ok === false &&
          /图片|位图/.test(String(htmlBody.error)) &&
          filesAfterHtml.length === filesAfterPng.length,
        `status=${htmlUpload.status} error=${htmlBody.error} files=${filesAfterPng.length}→${filesAfterHtml.length}`,
      )

      /* 37) 空 body：400，不写盘。 */
      const emptyUpload = await fetch(uploadUrl('empty.png'), { method: 'POST' })
      const emptyBody = await emptyUpload.json()
      const filesAfterEmpty = listUploads(h6Host)
      check(
        '37) 空 body 上传 → 400，且不写盘',
        emptyUpload.status === 400 &&
          emptyBody.ok === false &&
          filesAfterEmpty.length === filesAfterPng.length,
        `status=${emptyUpload.status} error=${emptyBody.error} files=${filesAfterEmpty.length}`,
      )

      /* ── 38) 文件数配额：预置 2 个文件、上限 2 → 413，目录仍是 2 个 ── */
      h6FilesHost = await startHost({ env: { DSH_THEME_STUDIO_MAX_UPLOAD_FILES: '2' } })
      const filesDir = path.join(h6FilesHost.home, 'theme-studio', 'wallpapers')
      await fs.promises.mkdir(filesDir, { recursive: true })
      await fs.promises.writeFile(path.join(filesDir, 'seed-1.png'), png)
      await fs.promises.writeFile(path.join(filesDir, 'seed-2.png'), png)
      const fileQuotaUpload = await fetch(
        `${h6FilesHost.origin}/theme-studio/api/upload?name=third.png`,
        { method: 'POST', body: png },
      )
      const fileQuotaBody = await fileQuotaUpload.json()
      const filesAfterQuota = listUploads(h6FilesHost)
      check(
        '38) DSH_THEME_STUDIO_MAX_UPLOAD_FILES=2 且已有 2 个文件 → 413（提示清理本地缓存），目录仍是 2 个',
        fileQuotaUpload.status === 413 &&
          fileQuotaBody.ok === false &&
          /清理本地缓存/.test(String(fileQuotaBody.error)) &&
          filesAfterQuota.length === 2 &&
          filesAfterQuota.every((entry) => entry.name.startsWith('seed-')),
        `status=${fileQuotaUpload.status} error=${fileQuotaBody.error} files=${filesAfterQuota.map((entry) => entry.name).join(',') || 'none'}`,
      )

      /* ── 39) 总字节配额：上限 10 字节，一张 70 字节的合法 PNG 也必须 413 ── */
      h6TotalHost = await startHost({ env: { DSH_THEME_STUDIO_MAX_UPLOAD_TOTAL_BYTES: '10' } })
      const totalQuotaUpload = await fetch(
        `${h6TotalHost.origin}/theme-studio/api/upload?name=tiny.png`,
        { method: 'POST', body: png },
      )
      const totalQuotaBody = await totalQuotaUpload.json()
      const filesAfterTotal = listUploads(h6TotalHost)
      check(
        '39) DSH_THEME_STUDIO_MAX_UPLOAD_TOTAL_BYTES=10 时上传 70B PNG → 413 且不写盘',
        totalQuotaUpload.status === 413 &&
          totalQuotaBody.ok === false &&
          /清理本地缓存/.test(String(totalQuotaBody.error)) &&
          filesAfterTotal.length === 0,
        `status=${totalQuotaUpload.status} error=${totalQuotaBody.error} files=${filesAfterTotal.length}`,
      )
    } finally {
      for (const [instance, label] of [
        [h6TotalHost, '上传总配额'],
        [h6FilesHost, '上传文件数配额'],
        [h6LimitHost, '上传超限'],
        [h6Host, '上传内容校验'],
      ]) {
        if (instance === undefined) continue
        try {
          await instance.close()
        } catch (error) {
          console.error(`关闭${label}测试宿主失败：`, error)
        }
      }
    }
  }
  /* ═════════ H7：端点清理语义 + 死配置 + 扫描截断可见 ═════════
   *
   * 对应审计 P1 第 15/16/17 条与 P3 第 9 条：
   *   · `scope` / `wallpaper.rotate` 是死配置，客户端已删（C1/C3），宿主也必须退役；
   *   · 清理本地副本不该顺带重置配置（P1 第 15 条），新增独立的 /api/purge-cache；
   *   · delete-upload / forget-url 删掉的正好是 current 时，fixed 与 current 必须一起清空；
   *   · 扫描达到上限必须显式回 truncated，而不是静默截断（P1 第 16 条）。
   *
   * 全部在隔离宿主上跑，配置与文件都在临时 DSH_HOME 里，不碰用户真实数据。
   */
  {
    let h7Host
    let h7ScanHost
    /** 与前面几段共用的 1×1 PNG（70 字节）。 */
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    )
    /**
     * 列出目录的直接子项；目录不存在时返回空数组。
     * @param dir - 绝对路径。
     * @returns 名称数组。
     */
    const listEntries = (dir) => {
      try {
        return fs.readdirSync(dir)
      } catch {
        return []
      }
    }

    try {
      h7Host = await startHost()
      const h7Origin = h7Host.origin
      const h7Api = `${h7Origin}/theme-studio/api`
      const h7DataDir = path.join(h7Host.home, 'theme-studio')

      /* 40) 死配置：出厂默认没有；PUT 甚至把它写进来，也必须被 dropRetiredKeys 清掉。
       * 同时带一个合法的 accent.rgb，确认清理只删废弃键、没有把整个 patch 丢掉。 */
      const defaultsResponse = await fetch(`${h7Api}/config`)
      const defaults = (await defaultsResponse.json()).config ?? {}
      const deadPut = await fetch(`${h7Api}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'html', wallpaper: { rotate: 'daily' }, accent: { rgb: [7, 8, 9] } }),
      })
      const deadPutBody = await deadPut.json()
      const afterDeadPut = (await readConfig(h7Origin)).body.config ?? {}
      check(
        '40) 出厂与 PUT 写回后的配置都不含 scope / wallpaper.rotate（宿主死配置已退役）',
        defaultsResponse.status === 200 &&
          !('scope' in defaults) &&
          !('rotate' in (defaults.wallpaper ?? {})) &&
          deadPut.status === 200 &&
          !('scope' in (deadPutBody.config ?? {})) &&
          !('rotate' in (deadPutBody.config?.wallpaper ?? {})) &&
          !('scope' in afterDeadPut) &&
          !('rotate' in (afterDeadPut.wallpaper ?? {})) &&
          JSON.stringify(afterDeadPut.accent?.rgb) === '[7,8,9]',
        `status=${deadPut.status} defaultScope=${'scope' in defaults} defaultRotate=${'rotate' in (defaults.wallpaper ?? {})} putScope=${'scope' in afterDeadPut} putRotate=${'rotate' in (afterDeadPut.wallpaper ?? {})} rgb=${JSON.stringify(afterDeadPut.accent?.rgb)}`,
      )

      /* 41) purge-cache：先上传一张（wallpapers/ 有真实文件），再手工造 url-cache
       * 条目（其中一个是子目录，验证直接子项会被递归删）。配置里故意把 current/fixed
       * 指向马上要被删的上传文件 —— purge 只允许清副本，配置一个字节都不能变。 */
      const purgeUploadResponse = await fetch(`${h7Api}/upload?name=purge.png`, { method: 'POST', body: png })
      const purgeUpload = await purgeUploadResponse.json()
      const cacheDir = path.join(h7DataDir, 'url-cache')
      await fs.promises.mkdir(path.join(cacheDir, 'nested'), { recursive: true })
      await fs.promises.writeFile(path.join(cacheDir, 'cached.png'), png)
      await fs.promises.writeFile(path.join(cacheDir, 'cached.json'), '{"ext":".png"}')
      await fs.promises.writeFile(path.join(cacheDir, 'nested', 'deep.png'), png)
      await fetch(`${h7Api}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallpaper: {
            current: String(purgeUpload.path ?? ''),
            fixed: String(purgeUpload.path ?? ''),
            folders: [path.join(h7Host.home, 'purge-marker-folder')],
            urls: ['https://example.invalid/purge-a.png'],
          },
        }),
      })
      const beforePurge = (await readConfig(h7Origin)).body.config
      const purgeResponse = await fetch(`${h7Api}/purge-cache`, {
        method: 'POST',
        // 同源 Origin + JSON：与面板里的真实调用形态一致（H1 的闸门必须放行）。
        headers: { Origin: h7Origin, 'Content-Type': 'application/json' },
        body: '{}',
      })
      const purgeBody = await purgeResponse.json()
      const afterPurge = (await readConfig(h7Origin)).body.config
      const uploadDir = path.join(h7DataDir, 'wallpapers')
      const purgeConfigSame = JSON.stringify(beforePurge) === JSON.stringify(afterPurge)
      check(
        '41) POST /api/purge-cache 删除上传副本与 url-cache 直接子项，配置完全不变',
        purgeUploadResponse.status === 200 &&
          purgeResponse.status === 200 &&
          purgeBody.ok === true &&
          Number.isInteger(purgeBody.removedFiles) &&
          purgeBody.removedFiles >= 4 &&
          purgeBody.removedBytes >= png.length * 3 &&
          !fs.existsSync(String(purgeUpload.path ?? '')) &&
          listEntries(uploadDir).length === 0 &&
          listEntries(cacheDir).length === 0 &&
          purgeConfigSame,
        `status=${purgeResponse.status} removedFiles=${purgeBody.removedFiles} removedBytes=${purgeBody.removedBytes} uploads=${listEntries(uploadDir).length} cache=${listEntries(cacheDir).length} configSame=${purgeConfigSame}`,
      )

      /* 42) delete-upload：current 指向被删文件、fixed 指向另一个位置。
       * 旧实现只比较 fixed，于是 current 会留成悬空路径 —— 这里两个都必须清空。 */
      const currentUploadResponse = await fetch(`${h7Api}/upload?name=current.png`, { method: 'POST', body: png })
      const currentUpload = await currentUploadResponse.json()
      const fixedOther = path.join(h7Host.home, 'fixed-other.png')
      await fetch(`${h7Api}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallpaper: { current: currentUpload.path, fixed: fixedOther } }),
      })
      const deleteResponse = await fetch(`${h7Api}/delete-upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentUpload.path }),
      })
      const deleteBody = await deleteResponse.json()
      const afterDelete = (await readConfig(h7Origin)).body.config ?? {}
      check(
        '42) delete-upload 删除 current 指向的文件 → current 与 fixed 一起清空',
        currentUploadResponse.status === 200 &&
          deleteResponse.status === 200 &&
          deleteBody.ok === true &&
          deleteBody.removed === true &&
          !fs.existsSync(String(currentUpload.path ?? '')) &&
          afterDelete.wallpaper?.current === '' &&
          afterDelete.wallpaper?.fixed === '',
        `status=${deleteResponse.status} removed=${deleteBody.removed} current=${JSON.stringify(afterDelete.wallpaper?.current)} fixed=${JSON.stringify(afterDelete.wallpaper?.fixed)}`,
      )

      /* 43) forget-url：current 指向被移除的 URL、fixed 指向另一条 URL。
       * urls 里只能少掉目标那条，current/fixed 必须一起清空（同上的清理语义）。 */
      const forgetUrl = 'https://example.invalid/wallpaper-a.png'
      const keepUrl = 'https://example.invalid/wallpaper-b.png'
      await fetch(`${h7Api}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallpaper: { urls: [forgetUrl, keepUrl], current: forgetUrl, fixed: keepUrl } }),
      })
      const forgetResponse = await fetch(`${h7Api}/forget-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: forgetUrl }),
      })
      const forgetBody = await forgetResponse.json()
      const afterForget = (await readConfig(h7Origin)).body.config ?? {}
      const forgottenUrls = afterForget.wallpaper?.urls ?? []
      check(
        '43) forget-url 删除 current 指向的 URL → urls 移除且 current/fixed 清空',
        forgetResponse.status === 200 &&
          forgetBody.ok === true &&
          Array.isArray(forgetBody.urls) &&
          !forgetBody.urls.includes(forgetUrl) &&
          forgetBody.urls.includes(keepUrl) &&
          !forgottenUrls.includes(forgetUrl) &&
          forgottenUrls.includes(keepUrl) &&
          afterForget.wallpaper?.current === '' &&
          afterForget.wallpaper?.fixed === '',
        `status=${forgetResponse.status} urls=${JSON.stringify(forgetBody.urls)} current=${JSON.stringify(afterForget.wallpaper?.current)} fixed=${JSON.stringify(afterForget.wallpaper?.fixed)}`,
      )

      /* 44) 扫描截断：上限压到 2，目录里放 3 张图。旧实现只回 2 条、没有任何标记，
       * 面板无法告诉用户「图库被截断了」。截断标记与顶层 limit 必须同时出现。 */
      h7ScanHost = await startHost({ env: { DSH_THEME_STUDIO_MAX_SCAN_FILES: '2' } })
      const scanApi = `${h7ScanHost.origin}/theme-studio/api`
      const scanDir = path.join(h7ScanHost.home, 'scan-pics')
      await fs.promises.mkdir(scanDir, { recursive: true })
      for (const name of ['a.png', 'b.png', 'c.png']) {
        await fs.promises.writeFile(path.join(scanDir, name), png)
      }
      await fetch(`${scanApi}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallpaper: { folders: [scanDir] } }),
      })
      const foldersResponse = await fetch(`${scanApi}/folders`)
      const foldersBody = await foldersResponse.json()
      const scanGroup = (foldersBody.groups ?? []).find((group) => group.folder === scanDir)
      const scanDetail =
        scanGroup === undefined
          ? 'group=missing'
          : `scanned=${scanGroup.scanned} items=${(scanGroup.items ?? []).length} truncated=${scanGroup.truncated}`
      check(
        '44) DSH_THEME_STUDIO_MAX_SCAN_FILES=2 + 3 张图 → 该组 truncated:true、scanned<=2，顶层 limit=2',
        foldersResponse.status === 200 &&
          foldersBody.ok === true &&
          foldersBody.limit === 2 &&
          scanGroup !== undefined &&
          scanGroup.truncated === true &&
          scanGroup.scanned === (scanGroup.items ?? []).length &&
          scanGroup.scanned <= 2,
        `status=${foldersResponse.status} limit=${foldersBody.limit} ${scanDetail}`,
      )

      /* 45) 方法闸门：purge-cache 只声明了 POST，GET 必须由 route() 包装层返回 405。 */
      const purgeGet = await fetch(`${h7Api}/purge-cache`)
      const purgeAllow = purgeGet.headers.get('allow') ?? ''
      check(
        '45) GET /api/purge-cache → 405 且 Allow 头只允许 POST',
        purgeGet.status === 405 && purgeAllow.includes('POST'),
        `status=${purgeGet.status} allow=${JSON.stringify(purgeAllow)}`,
      )
    } finally {
      for (const [instance, label] of [
        [h7ScanHost, '扫描截断'],
        [h7Host, '端点清理语义'],
      ]) {
        if (instance === undefined) continue
        try {
          await instance.close()
        } catch (error) {
          console.error(`关闭${label}测试宿主失败：`, error)
        }
      }
    }
  }

  /* ═════════ H8：Host 白名单 / DNS rebinding ═════════
   *
   * 审计 H8：只比对 Origin 与 Host 是否同值挡不住 DNS rebinding —— evil.example
   * 重绑到 127.0.0.1 后，浏览器发出的 Host 与 Origin 都是 evil.example:3080，
   * 同源校验必然通过。现在所有路由（含 GET/HEAD 与写方法）在入口先校验 Host：
   * localhost / IP 字面量 / DSH_THEME_STUDIO_ALLOWED_HOSTS 之外一律 403，
   * 响应固定为 `{ ok:false, error:'Host 不被允许' }`，不回显 Host、不带端口。
   *
   * fetch 不允许自定义 Host，所以这一节全部走 node:http；连接目标仍是测试宿主
   * 的 127.0.0.1:<port>，只伪造 Host 头。
   */
  {
    let h8Host
    let h8EarlyHost
    let h8AllowedHost
    /** 固定 403 文案：任何被拒请求都必须是它，多一个字段都算泄露。 */
    const fixedBody = JSON.stringify({ ok: false, error: 'Host 不被允许' })
    /** 收集所有必须被拒的响应（HEAD 没有 body，单独断言，不进这里）。 */
    const rejected = []
    try {
      // 显式清掉允许名单，确保「默认拒绝未知域名」不依赖运行测试的 shell 环境。
      h8Host = await startHost({ env: { DSH_THEME_STUDIO_ALLOWED_HOSTS: undefined } })
      const h8Origin = h8Host.origin
      const h8Port = new URL(h8Origin).port
      const evilHost = 'evil.example:3080'
      const evilOrigin = `http://${evilHost}`

      /* 46) 读配置：DNS rebinding 读取路径，必须在进入 handler 前就被拒。 */
      const evilConfig = await rawRequest(h8Origin, '/theme-studio/api/config', { host: evilHost })
      check(
        '46) Host: evil.example:3080 + GET /api/config → 403 固定文案且不回显 Host',
        evilConfig.status === 403 &&
          evilConfig.body === fixedBody &&
          !evilConfig.body.toLowerCase().includes('evil.example'),
        `status=${evilConfig.status} body=${evilConfig.body.slice(0, 120)}`,
      )
      rejected.push({ result: evilConfig, host: evilHost })

      /* 47) 目录浏览：攻击者重绑后最想读的就是宿主目录列表，同样必须 403。 */
      const evilBrowse = await rawRequest(
        h8Origin,
        `/theme-studio/api/browse?path=${encodeURIComponent(os.homedir())}`,
        { host: evilHost },
      )
      check(
        '47) Host: evil.example:3080 + GET /api/browse → 403 固定文案且不回显 Host',
        evilBrowse.status === 403 && evilBrowse.body === fixedBody && !evilBrowse.body.toLowerCase().includes('evil.example'),
        `status=${evilBrowse.status} body=${evilBrowse.body.slice(0, 120)}`,
      )
      rejected.push({ result: evilBrowse, host: evilHost })

      /* 48) 写配置：Host 与 Origin 都是 evil.example（旧闸门认为同源），
       * PUT 仍必须被 Host 层拒绝，且配置一个字节都不能变。 */
      const beforeHostPut = await rawRequest(h8Origin, '/theme-studio/api/config', {
        host: `127.0.0.1:${h8Port}`,
      })
      const evilWrite = await rawRequest(h8Origin, '/theme-studio/api/config', {
        method: 'PUT',
        host: evilHost,
        headers: { Origin: evilOrigin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ glass: { border: 0.123 } }),
      })
      const afterHostPut = await rawRequest(h8Origin, '/theme-studio/api/config', {
        host: `127.0.0.1:${h8Port}`,
      })
      const beforeBody = safeJson(beforeHostPut.body)
      const afterBody = safeJson(afterHostPut.body)
      check(
        '48) Host/Origin 同为 evil.example 的 PUT /api/config → 403 且配置未改动',
        evilWrite.status === 403 &&
          evilWrite.body === fixedBody &&
          beforeHostPut.status === 200 &&
          beforeBody.config?.glass?.border !== 0.123 &&
          afterBody.config?.glass?.border === beforeBody.config?.glass?.border,
        `status=${evilWrite.status} before=${beforeBody.config?.glass?.border} after=${afterBody.config?.glass?.border}`,
      )
      rejected.push({ result: evilWrite, host: evilHost })

      /* 49) HEAD 也走同一道门：不能因为「只读、无 body」被漏掉。 */
      const evilHead = await rawRequest(h8Origin, '/theme-studio/api/ping', { method: 'HEAD', host: evilHost })
      check(
        '49) Host: evil.example:3080 + HEAD /api/ping → 403（HEAD 同样过 Host 闸门）',
        evilHead.status === 403 && evilHead.body === '',
        `status=${evilHead.status} body=${JSON.stringify(evilHead.body.slice(0, 40))}`,
      )

      /* 50) 回环 IPv4：按 IP 访问面板是正常用法，必须 200。 */
      const loopbackHost = `127.0.0.1:${h8Port}`
      const loopback = await rawRequest(h8Origin, '/theme-studio/api/config', { host: loopbackHost })
      const loopbackBody = safeJson(loopback.body)
      check(
        '50) Host: 127.0.0.1:<port> → 200',
        loopback.status === 200 && loopbackBody.ok === true,
        `status=${loopback.status} ok=${loopbackBody.ok}`,
      )

      /* 51) localhost + 端口：浏览器常见访问方式，必须 200。 */
      const localhost = await rawRequest(h8Origin, '/theme-studio/api/config', { host: `localhost:${h8Port}` })
      const localhostBody = safeJson(localhost.body)
      check(
        '51) Host: localhost:<port> → 200',
        localhost.status === 200 && localhostBody.ok === true,
        `status=${localhost.status} ok=${localhostBody.ok}`,
      )

      /* 52) localhost.：FQDN 结尾点必须与 localhost 等价，仍属允许名单。 */
      const localhostDot = await rawRequest(h8Origin, '/theme-studio/api/config', { host: `localhost.:${h8Port}` })
      const localhostDotBody = safeJson(localhostDot.body)
      check(
        '52) Host: localhost.:<port> → 200（结尾点归一）',
        localhostDot.status === 200 && localhostDotBody.ok === true,
        `status=${localhostDot.status} ok=${localhostDotBody.ok}`,
      )

      /* 53) 局域网 IPv4 字面量：任意 IP 都放行，保留按局域网地址访问。 */
      const lan = await rawRequest(h8Origin, '/theme-studio/api/config', { host: `192.168.1.10:${h8Port}` })
      const lanBody = safeJson(lan.body)
      check(
        '53) Host: 192.168.1.10:<port>（局域网 IP 字面量）→ 200',
        lan.status === 200 && lanBody.ok === true,
        `status=${lan.status} ok=${lanBody.ok}`,
      )

      /* 54) IPv6 字面量：方括号 + 端口必须被正确剥离，不能当成畸形 Host。 */
      const ipv6 = await rawRequest(h8Origin, '/theme-studio/api/config', { host: `[::1]:${h8Port}` })
      const ipv6Body = safeJson(ipv6.body)
      check(
        '54) Host: [::1]:<port>（IPv6 字面量）→ 200',
        ipv6.status === 200 && ipv6Body.ok === true,
        `status=${ipv6.status} ok=${ipv6Body.ok}`,
      )

      /* 55) *.localhost：子域同属允许名单（本机开发常用）。 */
      const localhostSub = await rawRequest(h8Origin, '/theme-studio/api/config', { host: `a.localhost:${h8Port}` })
      const localhostSubBody = safeJson(localhostSub.body)
      check(
        '55) Host: a.localhost:<port>（*.localhost 子域）→ 200',
        localhostSub.status === 200 && localhostSubBody.ok === true,
        `status=${localhostSub.status} ok=${localhostSubBody.ok}`,
      )

      /* 56) 未设置允许名单时，普通域名一律拒绝（默认拒绝，而不是默认放行）。 */
      const internalHost = `theme.internal:${h8Port}`
      const internal = await rawRequest(h8Origin, '/theme-studio/api/config', { host: internalHost })
      check(
        '56) 未设置 DSH_THEME_STUDIO_ALLOWED_HOSTS 时 Host: theme.internal → 403',
        internal.status === 403 && internal.body === fixedBody,
        `status=${internal.status} body=${internal.body.slice(0, 120)}`,
      )
      rejected.push({ result: internal, host: internalHost })

      /* 57) Host 缺失：HTTP/1.1 由 Node 自己回 400，所以用 HTTP/1.0 裸请求，
       * 验证插件层「没有 Host → 403」。 */
      const noHostResponse = await rawHttp10(h8Origin, '/theme-studio/api/config')
      const [noHostHead, ...noHostRest] = noHostResponse.split('\r\n\r\n')
      const noHostStatus = Number((/^HTTP\/1\.[01] (\d{3})/.exec(noHostHead) ?? [])[1])
      const noHostBody = noHostRest.join('\r\n\r\n')
      check(
        '57) 完全没有 Host 头（HTTP/1.0）→ 403 固定文案',
        noHostStatus === 403 && noHostBody === fixedBody,
        `status=${noHostStatus} body=${noHostBody.slice(0, 120)}`,
      )
      rejected.push({ result: { status: noHostStatus, body: noHostBody }, host: undefined })

      /* 58) 校验必须早于任何读配置/读盘：预置一份损坏的 config.json，恶意 Host
       * 的 GET 不能触发 readConfig 的「备份 + 拒绝覆盖」。如果门放晚了，
       * 目录里会出现 config.json.corrupt-*，原文件也会被改写。 */
      h8EarlyHost = await startHost({ env: { DSH_THEME_STUDIO_ALLOWED_HOSTS: undefined } })
      const earlyDir = path.join(h8EarlyHost.home, 'theme-studio')
      await fs.promises.mkdir(earlyDir, { recursive: true })
      const earlyConfig = path.join(earlyDir, 'config.json')
      const earlyBroken = '{ not-json'
      await fs.promises.writeFile(earlyConfig, earlyBroken)
      const early = await rawRequest(h8EarlyHost.origin, '/theme-studio/api/config', { host: evilHost })
      const earlyEntries = await fs.promises.readdir(earlyDir)
      const earlyText = await fs.promises.readFile(earlyConfig, 'utf8')
      check(
        '58) 恶意 Host 的 GET /api/config 在读配置之前被拒：损坏文件未备份、未改写',
        early.status === 403 &&
          early.body === fixedBody &&
          earlyEntries.every((name) => !name.includes('.corrupt-')) &&
          earlyText === earlyBroken,
        `status=${early.status} entries=${earlyEntries.join(',')} unchanged=${earlyText === earlyBroken}`,
      )

      /* 59–62) 环境变量允许名单：精确域名 + `*.` 通配。通配只匹配子域，
       * 裸域 corp.example 必须仍然 403。 */
      h8AllowedHost = await startHost({
        env: { DSH_THEME_STUDIO_ALLOWED_HOSTS: 'theme.internal,*.corp.example' },
      })
      const allowedPort = new URL(h8AllowedHost.origin).port
      const allowedRequest = (host) => rawRequest(h8AllowedHost.origin, '/theme-studio/api/config', { host })

      const envExact = await allowedRequest(`theme.internal:${allowedPort}`)
      const envExactBody = safeJson(envExact.body)
      check(
        '59) DSH_THEME_STUDIO_ALLOWED_HOSTS 精确域名 theme.internal → 200',
        envExact.status === 200 && envExactBody.ok === true,
        `status=${envExact.status} ok=${envExactBody.ok}`,
      )

      const envWildcard = await allowedRequest(`a.corp.example:${allowedPort}`)
      const envWildcardBody = safeJson(envWildcard.body)
      check(
        '60) 通配 *.corp.example 匹配子域 a.corp.example → 200',
        envWildcard.status === 200 && envWildcardBody.ok === true,
        `status=${envWildcard.status} ok=${envWildcardBody.ok}`,
      )

      const envBareHost = `corp.example:${allowedPort}`
      const envBare = await allowedRequest(envBareHost)
      check(
        '61) 通配 *.corp.example 不匹配裸域 corp.example → 403',
        envBare.status === 403 && envBare.body === fixedBody && !envBare.body.toLowerCase().includes(envBareHost),
        `status=${envBare.status} body=${envBare.body.slice(0, 120)}`,
      )
      rejected.push({ result: envBare, host: envBareHost })

      const envEvilHost = `evil.example:${allowedPort}`
      const envEvil = await allowedRequest(envEvilHost)
      check(
        '62) 允许名单之外域名 evil.example → 403',
        envEvil.status === 403 && envEvil.body === fixedBody && !envEvil.body.toLowerCase().includes(envEvilHost),
        `status=${envEvil.status} body=${envEvil.body.slice(0, 120)}`,
      )
      rejected.push({ result: envEvil, host: envEvilHost })

      /* 63) 汇总：所有被拒请求的状态、文案完全一致，且响应体里没有回显任何
       * Host 字符串（连端口都不会出现，因为 body 就是那一个固定 JSON）。 */
      const rejectionsClean = rejected.every(({ result, host }) => {
        const parsed = safeJson(result.body)
        const bodyLower = result.body.toLowerCase()
        const noEcho = host === undefined || !bodyLower.includes(host.toLowerCase())
        return (
          result.status === 403 &&
          result.body === fixedBody &&
          parsed.ok === false &&
          parsed.error === 'Host 不被允许' &&
          noEcho
        )
      })
      check(
        '63) 所有被拒请求都是固定 403 JSON，且响应体不含回显的 Host 字符串',
        rejectionsClean,
        `rejected=${rejected.length} bodies=${rejected.map(({ result }) => result.body).join(' | ').slice(0, 200)}`,
      )
    } finally {
      for (const [instance, label] of [
        [h8AllowedHost, 'Host 允许名单'],
        [h8EarlyHost, 'Host 前置校验'],
        [h8Host, 'DNS rebinding'],
      ]) {
        if (instance === undefined) continue
        try {
          await instance.close()
        } catch (error) {
          console.error(`关闭${label}测试宿主失败：`, error)
        }
      }
    }
  }

  /* ═════════ H9：/api/proxy 的 ETag 必须来自响应体内容 ═════════
   *
   * 旧实现把 `sha1(url + buffer.length)` 当 ETag：上游重新压缩或同尺寸换图后，
   * 字节数不变 → 旧标签继续命中 → 304 空 body，浏览器最长 24h 看不到新图。
   * 这里用可切换响应体的回环上游复现：先拿 E1，确认 E1 能 304；清掉 url-cache
   * （否则 24h TTL 内不会回源）并换成同长度不同内容的 PNG；此时带 E1 必须
   * 200 + 新 ETag + 新字节。随后用 E2 覆盖 `*` / 弱标签 / 多值列表三种协商
   * 形态（`*` 按 RFC 9110 是「资源存在即命中」，与 /api/image 一致）。
   */
  {
    let h9Host
    let h9Upstream
    try {
      /* 同一 PNG 翻掉最后一个字节：长度不变、PNG magic 不变，但内容不同。
       * 旧 ETag 的输入（url + 长度）完全没变，因此旧实现无法区分这一对图。 */
      const pngA = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      )
      const pngB = Buffer.from(pngA)
      pngB[pngB.length - 1] ^= 0xff

      h9Upstream = await startUpstream()
      h9Upstream.setPng(pngA)
      const target = `${h9Upstream.origin}/same-length.png`
      h9Host = await startHost({ env: { DSH_THEME_STUDIO_ALLOW_LOOPBACK: '1' } })
      const h9Api = `${h9Host.origin}/theme-studio/api`
      const proxyUrl = `${h9Api}/proxy?url=${encodeURIComponent(target)}`

      /* 64) 首次回源：200、强 ETag（带引号）、Content-Type 仍由 magic 判定。 */
      const first = await fetch(proxyUrl)
      const firstBytes = Buffer.from(await first.arrayBuffer())
      const etag1 = first.headers.get('etag') ?? ''
      check(
        '64) /api/proxy 首次 200：强 ETag 带引号、Content-Type 来自 magic、body 是 PNG',
        first.status === 200 &&
          /^"[0-9a-f]{16}"$/.test(etag1) &&
          first.headers.get('content-type') === 'image/png' &&
          firstBytes.equals(pngA),
        `status=${first.status} etag=${etag1} content-type=${first.headers.get('content-type')} bytes=${firstBytes.length}`,
      )

      /* 65) 原样带回 E1：304 无 body，安全头与 ETag 必须跟 200 一致。 */
      const cached = await fetch(proxyUrl, { headers: { 'if-none-match': etag1 } })
      const cachedBytes = Buffer.from(await cached.arrayBuffer())
      check(
        '65) If-None-Match: E1 → 304 且无 body，安全头 / ETag 与 200 一致',
        cached.status === 304 &&
          cachedBytes.length === 0 &&
          cached.headers.get('etag') === etag1 &&
          cached.headers.get('x-content-type-options') === 'nosniff' &&
          (cached.headers.get('content-disposition') ?? '').includes('attachment') &&
          /sandbox/.test(cached.headers.get('content-security-policy') ?? ''),
        `status=${cached.status} etag=${cached.headers.get('etag')} bytes=${cachedBytes.length}`,
      )

      /* 66) 关键回归：清 url-cache 绕过 24h TTL，换成同长度不同内容。
       * 旧实现（url+长度）下这里仍是 304 空 body；内容哈希必须返回 200 + 新字节。 */
      const purge = await fetch(`${h9Api}/purge-cache`, {
        method: 'POST',
        headers: { Origin: h9Host.origin, 'Content-Type': 'application/json' },
        body: '{}',
      })
      const purgeBody = await purge.json()
      const hitsBeforeChange = h9Upstream.hits('/same-length.png')
      h9Upstream.setPng(pngB)
      const changed = await fetch(proxyUrl, { headers: { 'if-none-match': etag1 } })
      const changedBytes = Buffer.from(await changed.arrayBuffer())
      const etag2 = changed.headers.get('etag') ?? ''
      const hitsAfterChange = h9Upstream.hits('/same-length.png')
      check(
        '66) 清缓存并同长度换内容后带旧 ETag → 200、ETag 变化、body 为新 PNG',
        purge.status === 200 &&
          purgeBody.ok === true &&
          changed.status === 200 &&
          etag2.length > 0 &&
          etag2 !== etag1 &&
          changedBytes.equals(pngB) &&
          hitsAfterChange === hitsBeforeChange + 1,
        `purge=${purge.status} hits=${hitsBeforeChange}→${hitsAfterChange} status=${changed.status} etag=${etag1}→${etag2} newBody=${changedBytes.equals(pngB)}`,
      )

      /* 67) `*`：资源存在即命中（RFC 9110 §13.1.2），GET 返回 304；与 H5 第 30 条
       * 的 /api/image 保持同一套协商语义。 */
      const star = await fetch(proxyUrl, { headers: { 'if-none-match': '*' } })
      const starBytes = Buffer.from(await star.arrayBuffer())
      check(
        '67) If-None-Match: * → 304（资源存在即命中，与 /api/image 同语义）',
        star.status === 304 && starBytes.length === 0 && star.headers.get('etag') === etag2,
        `status=${star.status} etag=${star.headers.get('etag')} bytes=${starBytes.length}`,
      )

      /* 68) 弱比较：W/ 前缀不影响 GET 的缓存验证（弱比较函数）。 */
      const weak = await fetch(proxyUrl, { headers: { 'if-none-match': `W/${etag2}` } })
      const weakBytes = Buffer.from(await weak.arrayBuffer())
      check(
        '68) If-None-Match: W/E2（弱标签）→ 304',
        weak.status === 304 && weakBytes.length === 0 && weak.headers.get('etag') === etag2,
        `status=${weak.status} etag=${weak.headers.get('etag')} bytes=${weakBytes.length}`,
      )

      /* 69) 逗号多值：列表里任意一项命中即可，不能只比较整个头字符串。 */
      const list = await fetch(proxyUrl, { headers: { 'if-none-match': `"bogus", ${etag2}` } })
      const listBytes = Buffer.from(await list.arrayBuffer())
      check(
        '69) If-None-Match: "bogus", E2（逗号列表）→ 304',
        list.status === 304 && listBytes.length === 0 && list.headers.get('etag') === etag2,
        `status=${list.status} etag=${list.headers.get('etag')} bytes=${listBytes.length}`,
      )

      /* 70) 无 If-None-Match：正常回吐当前内容（缓存里已是 pngB）。 */
      const unconditional = await fetch(proxyUrl)
      const unconditionalBytes = Buffer.from(await unconditional.arrayBuffer())
      check(
        '70) 无 If-None-Match → 200 且 body 是当前内容',
        unconditional.status === 200 &&
          unconditional.headers.get('etag') === etag2 &&
          unconditionalBytes.equals(pngB),
        `status=${unconditional.status} etag=${unconditional.headers.get('etag')} bytes=${unconditionalBytes.length}`,
      )
    } finally {
      if (h9Host !== undefined) {
        try {
          await h9Host.close()
        } catch (error) {
          console.error('关闭代理 ETag 测试宿主失败：', error)
        }
      }
      if (h9Upstream !== undefined) {
        await h9Upstream.close().catch((error) => console.error('关闭代理 ETag 测试上游失败：', error))
      }
    }
  }
} catch (error) {
  check('测试执行未抛异常', false, String(error?.stack ?? error))
} finally {
  if (host !== undefined) {
    try {
      await host.close()
    } catch (error) {
      console.error('关闭测试宿主失败：', error)
    }
  }
}

const passed = results.filter(Boolean).length
console.log('')
console.log(`HOST CHECK ${failed ? 'FAILED' : 'OK'}（${passed}/${results.length} PASS）`)
if (failed) process.exitCode = 1
