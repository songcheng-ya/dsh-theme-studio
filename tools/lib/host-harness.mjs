/**
 * 宿主半侧端到端测试台。
 *
 * 为什么需要它：lib/index.js 只在 apply(ctx) 里注册路由，没有可直接调用的请求入口。
 * 这里把注册到的路由挂到一个真实的 http.Server 上，让测试能用 fetch 发真实请求，
 * 覆盖「405 + Allow」「HEAD 空 body」「Content-Type 415」这类只有走 HTTP 才成立的行为。
 *
 * 隔离：每次 startHost 都建一个临时 DSH_HOME，并在动态 import 插件**之前**写好
 * process.env.DSH_HOME；再给 import URL 加不同的查询串，强制 Node 重新求值模块 ——
 * 宿主有进程内配置缓存，复用同一个模块实例会让用例互相污染。
 *
 * 用法：const { origin, api, home, close } = await startHost()
 */

import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const ENTRY = path.join(ROOT, 'lib', 'index.js')

/** 每次 startHost 递增，拼进 import 查询串以绕过 ESM 模块缓存。 */
let caseSeed = 0

/**
 * 启动一个隔离的宿主实例。
 * @param options - 可选 `{ env?: Record<string, string | undefined> }`。
 *   env 在动态 import 插件**之前**写入 process.env，用于按用例打开测试开关
 *   （例如 DSH_THEME_STUDIO_ALLOW_LOOPBACK）。值为 undefined 时表示删除该变量，
 *   便于断言「未设置开关」的分支。DSH_HOME 始终由本函数覆盖为临时目录，
 *   不接受调用方指定，避免测试污染真实 profile。
 * @returns `{ origin, api, home, close }`。
 *   origin 是 `http://127.0.0.1:<随机端口>`；api 是插件模块导出；home 是临时 DSH_HOME。
 */
export async function startHost(options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-theme-studio-host-'))
  const previousHome = process.env.DSH_HOME

  /** 记录被 env 覆盖前的值，close 时原样还原，避免用例之间串环境。 */
  const previousEnv = []
  for (const [key, value] of Object.entries(options.env ?? {})) {
    previousEnv.push([key, process.env[key]])
    if (value === undefined) delete process.env[key]
    else process.env[key] = String(value)
  }
  process.env.DSH_HOME = home

  /** 还原 DSH_HOME 与本轮临时设置的 env（逆序，避免同名变量被还原两次时顺序不对）。 */
  const restoreEnvironment = () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    for (let index = previousEnv.length - 1; index >= 0; index -= 1) {
      const [key, value] = previousEnv[index]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  /** 假 ctx 只实现 apply() 真正用到的两个能力，避免测试依赖 cordis 运行时。 */
  const routes = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      fn()
    },
  }

  let server
  let api
  try {
    // 查询串必须带在 URL 里：同一进程里重复 import 同一路径会命中缓存。
    api = await import(`${pathToFileURL(ENTRY).href}?case=${caseSeed++}`)
    api.apply(ctx)

    server = http.createServer((req, res) => {
      const pathname = new URL(String(req.url ?? '/'), 'http://127.0.0.1').pathname
      // 按最长前缀分发：/api/config 这类短前缀不会抢走 /api/config-xxx 的路由。
      let matched = null
      for (const route of routes) {
        if (!pathname.startsWith(route.path)) continue
        if (matched === null || route.path.length > matched.path.length) matched = route
      }
      if (matched === null) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: `没有匹配的路由：${pathname}` }))
        return
      }
      Promise.resolve()
        .then(() => matched.handler(req, res))
        .catch((error) => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
          } else {
            res.end()
          }
        })
    })

    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
  } catch (error) {
    // 启动失败也不能留下临时目录和 DSH_HOME / env 污染，否则后续用例会串环境。
    if (server !== undefined && server.listening) server.close()
    restoreEnvironment()
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  const { port } = server.address()
  const origin = `http://127.0.0.1:${port}`
  let closed = false

  const close = async () => {
    if (closed) return
    closed = true
    // 先掐掉 keep-alive 空闲连接，否则 close() 要等连接自然超时。
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(() => resolve()))
    restoreEnvironment()
    await fs.rm(home, { recursive: true, force: true })
  }

  return { origin, api, home, close }
}
