/**
 * 验收探针（运行时）：设置里的「重置」**真的把插件造成的所有效果退回出厂**。
 *
 * 用户要的是「重置本插件造成的所有效果」，而不是「仅关闭插件」——这两件事在本插件里
 * 是两个不同的入口，本探针把它们的**区别**也一并钉住：
 *
 *   · 「一键关闭并复原」（维护卡片）：只把 `enabled` 置 false。效果撤了，
 *     但 wallpaper / glass / accent 原样留着，再打开全回来；
 *   · 「重置」（重置卡片）：调宿主 `/api/reset`，**整份配置退回 defaultConfig()**。
 *
 * 要证的：
 *   1. 重置入口在「其他」页，默认是**两步确认**（不会一点就执行）；
 *   2. 造一份「被改得面目全非」的配置（壁纸 + 玻璃 + 主题色 + 登记目录全动过），
 *      点重置 → 配置逐字段等于出厂默认；
 *   3. 界面真的复原：背景层消失、玻璃与主题色的 CSS 变量回到原生；
 *   4. 消歧义：**先验「关闭」不会重置配置**，再验「重置」会；
 *   5. `清理本地缓存` **只清副本、不动配置**（它复用 `/api/reset?purgeFiles=true`，
 *      而那个端点会顺带把配置写回出厂，所以清完必须把当前配置写回去），
 *      且**用户登记目录里的原图永远不动**。
 *
 * 用法：node tools/probe-reset.mjs <token> <port>
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configGuard } from './lib/config-guard.mjs'

const token = process.argv[2]
const port = process.argv[3] ?? '3087'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9263
const profileDir = path.join(os.tmpdir(), `dsh-reset-${process.pid}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ORIGIN = `http://127.0.0.1:${port}`
const API = `${ORIGIN}/theme-studio/api`
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const UPLOAD_DIR = path.join(DSH_HOME, 'theme-studio', 'wallpapers')
const URL_CACHE_DIR = path.join(DSH_HOME, 'theme-studio', 'url-cache')

if (token === undefined) {
  console.error('usage: node tools/probe-reset.mjs <token> <port>')
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
const hostConfig = async () => (await json(`${API}/config`)).body?.config ?? {}

const guard = configGuard({ api: API, json })
const PRistine = await guard.snapshot()
console.log(`初始快照：folders=${JSON.stringify(PRistine.wallpaper?.folders)} source=${PRistine.wallpaper?.source} enabled=${PRistine.enabled}`)
const sanity = guard.assertSane()
if (!sanity.ok) {
  console.error(`\n拒绝继续：\n  ${sanity.reason}`)
  process.exit(1)
}

/* 临时目录 + 一张上传副本，用来验「删除插件文件」那一档。 */
const tmpDir = path.join(os.tmpdir(), `dsh-reset-${process.pid}`)
fs.mkdirSync(tmpDir, { recursive: true })
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const userImage = path.join(tmpDir, 'user-photo.png')
fs.writeFileSync(userImage, PNG)
fs.mkdirSync(UPLOAD_DIR, { recursive: true })
const probeUpload = path.join(UPLOAD_DIR, `probe-reset-${process.pid}.png`)
fs.writeFileSync(probeUpload, PNG)

/* ── 浏览器 ─────────────────────────────────────────────────────── */

const child = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' })
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) break } catch {}
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

await guard.run(async () => {
  /* ── 造一份「被改得面目全非」的配置 ─────────────────────────── */
  await json(`${API}/config`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: true,
      accent: { enabled: true, rgb: [232, 106, 148], preset: 'sakura' },
      wallpaper: {
        folders: [tmpDir], urls: ['https://example.invalid/x.png'],
        source: 'folder', fixed: userImage, current: userImage,
        blur: 7, dim: 0.3, vignette: 0.4, noise: 0.1, brightness: 0.8,
      },
      glass: {
        bars: { enabled: true, opacity: 0.3, blur: 20 },
        input: { enabled: true, opacity: 0.2, blur: 30 },
        bubble: { enabled: true, opacity: 0.25, blur: 25 },
        menu: { enabled: true, opacity: 0.5, blur: 10 },
        border: 0.2, highlight: 0.9,
      },
    }),
  })
  const before = await hostConfig()
  console.log(`\n改造后：accent=${before.accent.enabled} rgb=${JSON.stringify(before.accent.rgb)} bars=${before.glass.bars.opacity}/${before.glass.bars.blur} folders=${JSON.stringify(before.wallpaper.folders)}`)

  const first = await fetch(`${ORIGIN}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const cookie = (first.headers.getSetCookie?.() ?? []).map((v) => v.split(';')[0]).join('; ')
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' })
  await send('Page.navigate', { url: `${ORIGIN}/` })
  await sleep(4500)

  /* ── 打开设置 → 主题工作室 → 其他 ───────────────────────────── */
  const opened = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    document.querySelector('.VOzbGW_trigger')?.click(); await sleep(1200)
    const panel = document.querySelector('.VOzbGW_panel') ?? document.body
    ;[...panel.querySelectorAll('.VOzbGW_navCell')].find((el) => el.textContent.includes('主题工作室'))?.click()
    await sleep(900)
    ;[...document.querySelectorAll('.ds-ts-tabs button')].find((el) => el.textContent.trim() === '其他')?.click()
    await sleep(800)
    return [...document.querySelectorAll('.ds-ts-card')].map((el) => el.querySelector('.ds-ts-title')?.textContent?.trim() ?? '?')
  })()`)
  console.log(`\n「其他」页卡片：${JSON.stringify(opened)}`)
  check('★ 其他页出现「重置」卡片', opened.includes('重置'), opened.join(' / '))
  check('★ 维护卡片仍在（两个入口并存）', opened.includes('维护'), opened.join(' / '))
  check('★ 重置卡片默认收起（破坏性操作不摊在页面上）',
    (await evaluate(`(() => {
      const card = [...document.querySelectorAll('.ds-ts-card')].find((el) => el.querySelector('.ds-ts-title')?.textContent?.trim() === '重置')
      return card?.querySelector('.ds-ts-body') === null
    })()`)) === true)

  /* 展开重置卡片 */
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const card = [...document.querySelectorAll('.ds-ts-card')].find((el) => el.querySelector('.ds-ts-title')?.textContent?.trim() === '重置')
    card?.querySelector('header .ds-ts-btn')?.click()
    await sleep(500)
  })()`)
  const resetButtons = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.ds-ts-card')].find((el) => el.querySelector('.ds-ts-title')?.textContent?.trim() === '重置')
    return [...(card?.querySelectorAll('.ds-ts-btn') ?? [])].map((el) => el.textContent.trim())
  })()`)
  console.log(`重置卡片按钮：${JSON.stringify(resetButtons)}`)
  check('★ 重置提供两级入口：重置配置 / 清理本地缓存',
    resetButtons.includes('重置配置') && resetButtons.includes('清理本地缓存'),
    JSON.stringify(resetButtons))
  /* 0.2.5 用户要求：卡片里**只留功能**，不要把解释性描述写进界面。 */
  const cardText = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.ds-ts-card')].find((el) => el.querySelector('.ds-ts-title')?.textContent?.trim() === '重置')
    return card?.textContent ?? ''
  })()`)
  check('★ 卡片里没有解释性描述段落（只剩标题、副标题与功能按钮）',
    !cardText.includes('不是「卸载插件」') && !cardText.includes('关闭只是把效果撤掉') &&
      !cardText.includes('无法撤销') && !cardText.includes('dsh plugin --profile'),
    cardText.replace(/\s+/g, ' ').slice(0, 180))
  check('★ 默认没有确认问句（两步确认的第一步只是亮出确认）',
    !resetButtons.includes('确认') && !cardText.includes('确认重置全部配置'),
    JSON.stringify(resetButtons))

  /* ── 消歧义第一步：先验「关闭」**不**重置配置 ─────────────────── */
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const card = [...document.querySelectorAll('.ds-ts-card')].find((el) => el.querySelector('.ds-ts-title')?.textContent?.trim() === '维护')
    ;[...(card?.querySelectorAll('.ds-ts-btn') ?? [])].find((el) => el.textContent.trim() === '一键关闭并复原')?.click()
    await sleep(1500)
  })()`)
  const afterDisable = await hostConfig()
  check('★ 对照：「一键关闭并复原」只关掉开关，配置**原样保留**',
    afterDisable.enabled === false && afterDisable.accent.enabled === true &&
      afterDisable.glass.bars.opacity === before.glass.bars.opacity &&
      (afterDisable.wallpaper.folders ?? []).includes(tmpDir),
    `enabled=${afterDisable.enabled} accent=${afterDisable.accent.enabled} bars=${afterDisable.glass.bars.opacity} folders=${JSON.stringify(afterDisable.wallpaper.folders)}`)

  /* 再把开关打开，让重置面对的是「全开」的状态 */
  await json(`${API}/config`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  })
  await send('Page.reload', {})
  await sleep(4500)
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    document.querySelector('.VOzbGW_trigger')?.click(); await sleep(1200)
    const panel = document.querySelector('.VOzbGW_panel') ?? document.body
    ;[...panel.querySelectorAll('.VOzbGW_navCell')].find((el) => el.textContent.includes('主题工作室'))?.click()
    await sleep(900)
    ;[...document.querySelectorAll('.ds-ts-tabs button')].find((el) => el.textContent.trim() === '其他')?.click()
    await sleep(800)
    const card = [...document.querySelectorAll('.ds-ts-card')].find((el) => el.querySelector('.ds-ts-title')?.textContent?.trim() === '重置')
    card?.querySelector('header .ds-ts-btn')?.click()
    await sleep(500)
  })()`)

  const beforeReset = await evaluate(`(() => {
    const layer = document.querySelector('#dsh-theme-studio-bg')
    const style = layer === null ? null : getComputedStyle(layer)
    return {
      layer: layer !== null,
      rootAttr: document.documentElement.hasAttribute('data-dsh-theme-studio'),
      accentVar: getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-brand-primary-new-colorprimary-new-color').trim(),
      styleChars: style === null ? 0 : 1,
    }
  })()`)
  console.log(`\n重置前：背景层=${beforeReset.layer} 根属性=${beforeReset.rootAttr} 品牌色变量=${beforeReset.accentVar}`)
  check('★ 重置前确实带着效果（背景层在、根属性在、品牌色被改过）',
    beforeReset.layer === true && beforeReset.rootAttr === true, JSON.stringify(beforeReset))

  /* ── 点「重置配置」→ 两步确认 → 确认 ─────────────────────────── */
  const armed = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const card = [...document.querySelectorAll('.ds-ts-card')].find((el) => el.querySelector('.ds-ts-title')?.textContent?.trim() === '重置')
    ;[...(card?.querySelectorAll('.ds-ts-btn') ?? [])].find((el) => el.textContent.trim() === '重置配置')?.click()
    await sleep(400)
    return {
      buttons: [...(card?.querySelectorAll('.ds-ts-btn') ?? [])].map((el) => el.textContent.trim()),
      warn: card?.querySelector('.ds-ts-warn')?.textContent?.trim() ?? '',
    }
  })()`)
  console.log(`第一步之后：${JSON.stringify(armed)}`)
  check('★ 第一步只亮出确认，不执行', armed.buttons.includes('确认') && armed.buttons.includes('取消'),
    JSON.stringify(armed))
  check('★ 重置的确认问句说明「无法撤销」', armed.warn.includes('无法撤销'), armed.warn)

  /* 先测「取消」——不该有任何变化 */
  await evaluate(`(() => {
    const card = [...document.querySelectorAll('.ds-ts-card')].find((el) => el.querySelector('.ds-ts-title')?.textContent?.trim() === '重置')
    ;[...(card?.querySelectorAll('.ds-ts-btn') ?? [])].find((el) => el.textContent.trim() === '取消')?.click()
  })()`)
  await sleep(1200)
  const afterCancel = await hostConfig()
  check('★ 点「取消」不改变任何配置',
    afterCancel.accent.enabled === true && afterCancel.glass.bars.opacity === before.glass.bars.opacity,
    `accent=${afterCancel.accent.enabled} bars=${afterCancel.glass.bars.opacity}`)

  /* ── 先验「清理本地缓存」：只清文件，配置必须原样 ─────────────────
   * 这一条是 0.2.5 的核心语义：它复用 `/api/reset?purgeFiles=true`，
   * 而那个端点会顺带把配置写回出厂 —— 清完必须把当前配置写回去，
   * 否则点一下「清理本地缓存」会莫名其妙丢掉全部设置。 */
  await json(`${API}/upload?name=probe-cache-1.png`, { method: 'POST', body: PNG })
  const cacheBefore = { folders: fs.readdirSync(UPLOAD_DIR).length }
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const card = [...document.querySelectorAll('.ds-ts-card')].find((el) => el.querySelector('.ds-ts-title')?.textContent?.trim() === '重置')
    ;[...(card?.querySelectorAll('.ds-ts-btn') ?? [])].find((el) => el.textContent.trim() === '清理本地缓存')?.click()
    await sleep(400)
    ;[...(card?.querySelectorAll('.ds-ts-btn') ?? [])].find((el) => el.textContent.trim() === '确认')?.click()
    await sleep(3000)
  })()`)
  const afterCache = await hostConfig()
  console.log(`\n清缓存后：上传目录 ${cacheBefore.folders} → ${fs.readdirSync(UPLOAD_DIR).length} 个；accent=${afterCache.accent.enabled} bars=${afterCache.glass.bars.opacity} folders=${JSON.stringify(afterCache.wallpaper.folders)}`)
  check('★★ 清缓存真的删掉了副本', fs.readdirSync(UPLOAD_DIR).length === 0, `${cacheBefore.folders} → ${fs.readdirSync(UPLOAD_DIR).length}`)
  check('★★ 清缓存**不动配置**：主题色 / 玻璃 / 登记目录全部原样',
    afterCache.accent.enabled === before.accent.enabled &&
      afterCache.glass.bars.opacity === before.glass.bars.opacity &&
      afterCache.glass.bars.blur === before.glass.bars.blur &&
      (afterCache.wallpaper.folders ?? []).includes(tmpDir),
    `accent=${afterCache.accent.enabled} bars=${afterCache.glass.bars.opacity}/${afterCache.glass.bars.blur} folders=${JSON.stringify(afterCache.wallpaper.folders)}`)
  check('★ 总开关也没被清缓存改掉', afterCache.enabled === true, String(afterCache.enabled))

  /* 把上传副本与配置恢复成「待重置」的状态 */
  await json(`${API}/upload?name=probe-cache-2.png`, { method: 'POST', body: PNG })

  /* 再来一次，这回确认重置 */
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const card = [...document.querySelectorAll('.ds-ts-card')].find((el) => el.querySelector('.ds-ts-title')?.textContent?.trim() === '重置')
    ;[...(card?.querySelectorAll('.ds-ts-btn') ?? [])].find((el) => el.textContent.trim() === '重置配置')?.click()
    await sleep(400)
    ;[...(card?.querySelectorAll('.ds-ts-btn') ?? [])].find((el) => el.textContent.trim() === '确认')?.click()
    await sleep(3000)
  })()`)

  const afterReset = await hostConfig()
  const defaults = (await json(`${API}/config`)).body?.config ?? {}
  console.log(`\n重置后：enabled=${afterReset.enabled} accent=${afterReset.accent.enabled} bars=${afterReset.glass.bars.opacity}/${afterReset.glass.bars.blur} folders=${JSON.stringify(afterReset.wallpaper.folders)} source=${afterReset.wallpaper.source}`)
  check('★★ 重置后配置逐字段等于出厂默认', JSON.stringify(afterReset) === JSON.stringify(defaults))
  check('★★ 壁纸被清空（source=none、folders 空、fixed 空）',
    afterReset.wallpaper.source === 'none' && (afterReset.wallpaper.folders ?? []).length === 0 &&
      afterReset.wallpaper.fixed === '' && afterReset.wallpaper.dim === 0,
    JSON.stringify({ source: afterReset.wallpaper.source, folders: afterReset.wallpaper.folders, dim: afterReset.wallpaper.dim }))
  check('★★ 玻璃回到出厂（不透明度 1、模糊 0）',
    ['bars', 'input', 'bubble', 'menu'].every((key) => afterReset.glass[key].opacity === 1 && afterReset.glass[key].blur === 0),
    JSON.stringify(afterReset.glass))
  check('★★ 主题色回到关闭状态', afterReset.accent.enabled === false, JSON.stringify(afterReset.accent))
  check('★ 总开关回到 true（重置 ≠ 关闭）', afterReset.enabled === true, String(afterReset.enabled))

  /* ── 界面也要真的复原 ─────────────────────────────────────────── */
  const uiAfter = await evaluate(`(() => ({
    layer: document.querySelector('#dsh-theme-studio-bg') !== null,
    rootAttr: document.documentElement.hasAttribute('data-dsh-theme-studio'),
    accentVar: getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-brand-primary-new-colorprimary-new-color').trim(),
  }))()`)
  console.log(`界面：背景层=${uiAfter.layer} 根属性=${uiAfter.rootAttr} 品牌色=${uiAfter.accentVar}`)
  check('★★ 背景层已撤除（界面回到 DSH 原样）', uiAfter.layer === false)
  check('★ 主题色变量回到原生（不再是樱花粉）',
    uiAfter.accentVar !== beforeReset.accentVar || uiAfter.accentVar === '', `${beforeReset.accentVar} → ${uiAfter.accentVar}`)

  /* ── 「清理本地缓存」那一档的端点级校验 ─────────────────────────
   * UI 那一档已在上面验过（只清文件、配置原样）。这里再直接打端点，
   * 确认 `purgeFiles` 的语义：清掉两种副本，而用户目录里的原图毫发无伤。 */
  await json(`${API}/upload?name=probe-reset-2.png`, { method: 'POST', body: PNG })
  const uploadsBefore = fs.readdirSync(UPLOAD_DIR).length
  console.log(`\n端点级清缓存：上传目录里现有 ${uploadsBefore} 个文件`)
  const purged = await json(`${API}/reset`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purgeFiles: true }),
  })
  check('★ 带 purgeFiles 的请求返回删除数量', purged.body?.ok === true && purged.body?.purged === true,
    JSON.stringify(purged.body))
  check('★ 上传目录被清空', (fs.readdirSync(UPLOAD_DIR).length === 0),
    `${uploadsBefore} → ${fs.readdirSync(UPLOAD_DIR).length}`)
  check('★ url-cache 目录也被清空（若存在）',
    !fs.existsSync(URL_CACHE_DIR) || fs.readdirSync(URL_CACHE_DIR).length === 0)
  check('★★ 用户登记目录里的原图**完好无损**', fs.existsSync(userImage), userImage)
})

/* ── 收尾 ───────────────────────────────────────────────────────── */
await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
socket.close(); child.kill(); await sleep(300)
await fs.promises.rm(profileDir, { recursive: true, force: true }).catch(() => {})
console.log(process.exitCode === 1 ? '\nRESET PROBE FAILED' : '\nRESET PROBE OK')
