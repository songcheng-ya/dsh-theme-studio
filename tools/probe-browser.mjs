/**
 * 真实浏览器验证：用 Chrome DevTools Protocol 驱动 Edge 无头实例打开 DSH Web，
 * 测量设置弹窗、侧栏等关键元素的几何与计算样式。
 *
 * 这一步补上了纯静态分析的盲区：`backdrop-filter` 会让元素成为 fixed 后代的
 * 包含块，只有真的渲染一次才能确认弹窗有没有被锁进侧栏。
 *
 * 用法：node tools/probe-browser.mjs <token> [port] [--keep]
 *   --keep  测完不关浏览器，便于人工接管查看
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const token = process.argv[2]
const port = process.argv[3] ?? '3080'
if (!token) {
  console.error('usage: node tools/probe-browser.mjs <token> [port] [--keep]')
  process.exit(2)
}
const keep = process.argv.includes('--keep')

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9223
const profileDir = path.join(os.tmpdir(), `dsh-theme-studio-probe-${process.pid}`)

const check = (label, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) process.exitCode = 1
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* ── 启动无头 Edge ─────────────────────────────────────────────── */

const child = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
)

/** 轮询等待 DevTools 端点就绪。 */
async function waitForCdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (response.ok) return await response.json()
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  throw new Error('DevTools 端点未就绪')
}

const version = await waitForCdp()
console.log(`浏览器：${version.Browser}`)

/* ── 建一个新标签页并连上 CDP ──────────────────────────────────── */

const target = await (
  await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })
).json()

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
})

let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
  }
})

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })

/** 在页面里求值并取回 JSON 结果。 */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  })
  if (result.exceptionDetails) {
    throw new Error(`页面求值异常：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
  }
  return result.result.value
}

await send('Page.enable')
await send('Runtime.enable')

const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
await send('Page.navigate', { url })

/* ── 等待应用挂载 ──────────────────────────────────────────────── */

let mounted = false
for (let i = 0; i < 80; i++) {
  await sleep(250)
  try {
    mounted = await evaluate(`document.querySelector('#root')?.children.length > 0`)
    if (mounted === true) break
  } catch {
    /* 导航期求值可能失败 */
  }
}
check('DSH 应用已挂载', mounted === true)

// 让插件把壁纸与玻璃都应用上。注意：宿主是「深合并」，所以这里只发增量，
// 不要整份覆盖 —— 否则会把面板里登记好的壁纸目录一并清掉。
// 可用 THeme_STUDIO_WALLPAPER=<绝对路径> 显式指定一张壁纸来复核实效。
const explicitWallpaper = process.env.DSH_THEME_STUDIO_WALLPAPER ?? ''
const probeWallpaper = explicitWallpaper.length > 0
  ? explicitWallpaper
  : await evaluate(`
fetch('/theme-studio/api/folders').then((r) => r.json()).then((data) => {
  const items = (data.groups ?? []).flatMap((group) => group.items ?? [])
  return items.length > 0 ? items[0].path : ''
})`)
if (explicitWallpaper.length > 0) {
  await evaluate(`fetch('/theme-studio/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallpaper: { folders: ${JSON.stringify([path.dirname(explicitWallpaper)])} } })
  }).then((r) => r.ok)`)
}
console.log(`候选壁纸：${probeWallpaper.length > 0 ? probeWallpaper : '（未登记图片文件夹，跳过壁纸）'}`)
await evaluate(`
fetch('/theme-studio/api/config', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    enabled: true,
    accent: { enabled: true, rgb: [232, 106, 148], preset: 'sakura' },
    wallpaper: ${JSON.stringify(
      probeWallpaper.length > 0
        ? { source: 'folder', fixed: probeWallpaper, current: probeWallpaper, dim: 0.2, vignette: 0.3, noise: 0.04 }
        : { source: 'none' },
    )},
    glass: {
      // 刻意带上三个已删分区（sidebar 0.1.9 / topbar 0.1.12 / chat 0.1.13）：宿主写路径
      // 应当把它们直接剔除，所以下面量到的 sidebar / topbar / chatCol 样式必然与原生一致
      // —— 这既是回归，也是「删除干净」的运行时证据。
      sidebar: { enabled: true, opacity: 0.55, blur: 18 },
      topbar: { enabled: true, opacity: 0.55, blur: 18 },
      chat: { enabled: true, opacity: 0.5, blur: 16 },
      input: { enabled: true, opacity: 0.58, blur: 20 },
      bubble: { enabled: true, opacity: 0.6, blur: 14 },
      panel: { enabled: true, opacity: 0.62, blur: 22 },
      menu: { enabled: true, opacity: 0.68, blur: 24 },
      border: 0.6, highlight: 0.5
    }
  })
}).then((r) => r.ok)`)
await send('Page.reload', { ignoreCache: true })
await sleep(3000)
for (let i = 0; i < 40; i++) {
  const ready = await evaluate(`document.querySelector('#root')?.children.length > 0`).catch(() => false)
  if (ready === true) break
  await sleep(250)
}
await sleep(1200)

/* ── 打开设置 ──────────────────────────────────────────────────── */

const opened = await evaluate(`(() => {
  const trigger = document.querySelector('.VOzbGW_trigger')
    ?? document.querySelector('[aria-label="设置"]')
    ?? document.querySelector('[aria-label="Settings"]')
  if (!trigger) return 'no-trigger'
  trigger.click()
  return 'clicked:' + String(trigger.className)
})()`)
console.log(`打开设置：${opened}`)
await sleep(1500)

// 定向诊断：设置点了之后，文档里到底多了什么；并回溯 overlay 的祖先链，
// 找出是谁当了它的包含块（带 filter/backdrop-filter/transform/contain 的祖先）。
const diag = await evaluate(`(() => {
  const overlay = document.querySelector('.VOzbGW_overlay')
  const chain = []
  let node = overlay
  while (node && node !== document.documentElement.parentElement) {
    const cs = getComputedStyle(node)
    chain.push({
      tag: node.tagName,
      cls: String(node.className ?? '').slice(0, 46),
      position: cs.position,
      filter: cs.filter,
      backdropFilter: cs.backdropFilter,
      transform: cs.transform,
      contain: cs.contain,
      willChange: cs.willChange,
      isContainingBlock:
        cs.filter !== 'none' || cs.backdropFilter !== 'none' || cs.transform !== 'none' ||
        cs.contain.includes('paint') || cs.contain.includes('layout') || cs.willChange !== 'auto',
    })
    node = node.parentElement
  }
  const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }
  return {
    chain,
    viewport: [innerWidth, innerHeight],
    overlay: rect('.VOzbGW_overlay'),
    mask: rect('.VOzbGW_mask'),
    panel: rect('.VOzbGW_panel'),
    panelStyle: (() => { const el = document.querySelector('.VOzbGW_panel'); if (!el) return null; const cs = getComputedStyle(el); return { width: cs.width, height: cs.height, maxWidth: cs.maxWidth, backdropFilter: cs.backdropFilter, background: cs.backgroundColor } })(),
    sidebarRegions: [...document.querySelectorAll('.hHd-Xa_root > *')].map((el) => ({ cls: String(el.className).slice(0, 46), rect: (() => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] })() })),
  }
})()`)
console.log('\n--- 点击设置后的诊断 ---')
console.log(JSON.stringify(diag, null, 2))

/* ── 测量 ──────────────────────────────────────────────────────── */

// 先确认设置还开着：某些路径下点击会被上层捕获，这里补一次并等待面板稳定。
await evaluate(`(() => {
  const overlay = document.querySelector('.VOzbGW_overlay')
  if (overlay) return false
  const trigger = document.querySelector('.VOzbGW_trigger')
  if (trigger) trigger.click()
  return true
})()`)
await sleep(900)
const overlayPresent = await evaluate(`document.querySelector('.VOzbGW_overlay') !== null`)
console.log(`测量前弹窗存在：${overlayPresent}`)

const report = await evaluate(`(() => {
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const styleOf = (el, props) => {
    if (!el) return null
    const cs = getComputedStyle(el)
    return Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]))
  }
  const overlay = document.querySelector('.VOzbGW_overlay')
  const panel = document.querySelector('.VOzbGW_panel')
  const sidebar = document.querySelector('.hHd-Xa_root')
  const mask = document.querySelector('.VOzbGW_mask')
  const frame = document.querySelector('.pI_x6G_frame')
  const chatCol = document.querySelector('.pI_x6G_centerCol')
  const inputCard = document.querySelector('.uV2eYG_card')
  const topbar = document.querySelector('.wSkVaW_header')

  // 谁是固定定位元素的包含块：找出所有带 backdrop-filter 的祖先
  const containingAncestors = []
  let node = overlay
  while (node && node !== document.documentElement) {
    const cs = getComputedStyle(node)
    if (cs.backdropFilter !== 'none' || cs.filter !== 'none' || cs.transform !== 'none' || cs.contain.includes('paint') || cs.willChange !== 'auto') {
      containingAncestors.push({
        cls: String(node.className).slice(0, 60),
        backdropFilter: cs.backdropFilter,
        filter: cs.filter,
        transform: cs.transform,
        contain: cs.contain,
      })
    }
    node = node.parentElement
  }

  return {
    viewport: { w: innerWidth, h: innerHeight },
    overlay: rect(overlay),
    mask: rect(mask),
    panel: rect(panel),
    sidebar: rect(sidebar),
    frame: rect(frame),
    chatCol: rect(chatCol),
    inputCard: rect(inputCard),
    topbar: rect(topbar),
    overlayParent: overlay ? String(overlay.parentElement?.className).slice(0, 60) : null,
    overlayIsInSidebar: sidebar && overlay ? sidebar.contains(overlay) : null,
    overlayStyle: styleOf(overlay, ['position', 'inset', 'z-index', 'display']),
    panelStyle: styleOf(panel, ['position', 'width', 'height', 'border-radius', 'background-color', 'backdrop-filter']),
    sidebarStyle: styleOf(sidebar, ['position', 'background-color', 'backdrop-filter', 'contain', 'transform']),
    chatColStyle: styleOf(chatCol, ['backdrop-filter', 'background-color']),
    topbarStyle: styleOf(topbar, ['backdrop-filter', 'background-color']),
    inputStyle: styleOf(inputCard, ['backdrop-filter', 'background-color', 'position']),
    themeAttr: document.documentElement.hasAttribute('data-dsh-theme-studio'),
    containingAncestors,
  }
})()`)

console.log('\n--- 几何 ---')
console.log(JSON.stringify({
  viewport: report.viewport,
  overlay: report.overlay,
  mask: report.mask,
  panel: report.panel,
  sidebar: report.sidebar,
  frame: report.frame,
  chatCol: report.chatCol,
  inputCard: report.inputCard,
  topbar: report.topbar,
}, null, 2))

console.log('\n--- 包含块链（fixed 后代的祖先里带 filter/transform/contain 的） ---')
console.log(JSON.stringify(report.containingAncestors, null, 2))

console.log('\n--- 样式 ---')
console.log(JSON.stringify({
  overlayParent: report.overlayParent,
  overlayIsInSidebar: report.overlayIsInSidebar,
  overlayStyle: report.overlayStyle,
  panelStyle: report.panelStyle,
  sidebarStyle: report.sidebarStyle,
  chatColStyle: report.chatColStyle,
  topbarStyle: report.topbarStyle,
  inputStyle: report.inputStyle,
  themeAttr: report.themeAttr,
}, null, 2))

/* ── 断言 ──────────────────────────────────────────────────────── */

const viewport = report.viewport
check('插件已作用于文档', report.themeAttr === true)
check('设置弹窗存在', report.overlay !== null)
check('遮罩铺满视口', report.mask !== null && Math.abs(report.mask.w - viewport.w) <= 2 && Math.abs(report.mask.h - viewport.h) <= 2,
  `mask=${report.mask?.w}×${report.mask?.h} viewport=${viewport.w}×${viewport.h}`)
check('弹窗面板没有被锁进侧栏', report.panel !== null && report.panel.w > (report.sidebar?.w ?? 0) + 40,
  `panel=${report.panel?.w}px sidebar=${report.sidebar?.w}px`)
check('弹窗面板水平居中', report.panel !== null &&
  Math.abs(report.panel.x + report.panel.w / 2 - viewport.w / 2) <= 24,
  `panelCenter=${report.panel ? report.panel.x + report.panel.w / 2 : '?'} viewportCenter=${viewport.w / 2}`)
check('弹窗面板垂直居中', report.panel !== null &&
  Math.abs(report.panel.y + report.panel.h / 2 - viewport.h / 2) <= 24,
  `panelCenterY=${report.panel ? report.panel.y + report.panel.h / 2 : '?'} viewportCenterY=${viewport.h / 2}`)
check('设置面板是 fixed 的直接容器', report.overlayStyle?.position === 'fixed', String(report.overlayStyle?.position))

/* ── 全局体检：有没有 fixed 元素被插件的 backdrop-filter 困住 ──── */

const audit = await evaluate(`(() => {
  const creating = (cs) =>
    cs.backdropFilter !== 'none' || cs.filter !== 'none' || cs.transform !== 'none' ||
    cs.perspective !== 'none' || cs.contain.includes('paint') || cs.willChange.includes('transform') ||
    cs.willChange.includes('filter')
  const trapped = []
  const ours = []
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el)
    if (cs.position !== 'fixed') continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    let node = el.parentElement
    let culprit = null
    while (node && node !== document.documentElement) {
      const ncs = getComputedStyle(node)
      if (creating(ncs)) { culprit = node; break }
      node = node.parentElement
    }
    if (culprit !== null) {
      const entry = {
        fixedCls: String(el.className ?? '').slice(0, 44),
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        culpritCls: String(culprit.className ?? '').slice(0, 44),
        culpritBackdrop: getComputedStyle(culprit).backdropFilter,
      }
      trapped.push(entry)
      // 只有「包含块是插件加了 backdrop-filter 的元素」才算我们的责任
      if (/hHd-Xa_|pI_x6G_|wSkVaW_|uV2eYG_|VOzbGW_/.test(entry.culpritCls) &&
          getComputedStyle(culprit).backdropFilter !== 'none') {
        ours.push(entry)
      }
    }
  }
  return { trapped: trapped.slice(0, 20), ours: ours.slice(0, 20), viewport: [innerWidth, innerHeight] }
})()`)
console.log('\n--- fixed 元素包含块体检 ---')
console.log(JSON.stringify(audit, null, 2))
check('没有任何 fixed 元素被插件的模糊困住', audit.ours.length === 0,
  audit.ours.map((item) => `${item.fixedCls}@${item.culpritCls}`).join(' | ') || 'none')

/* 主题工作室面板的中文检查 */

const nativeCheck = await evaluate(`(() => {
  const panel = document.querySelector('.VOzbGW_panel')
  const all = panel ? [...panel.querySelectorAll('*')] : []
  // 设置左导航的真实类名不一定是 navCell，这里把面板内所有「像导航项」的元素都收上来。
  const navLike = all
    .filter((el) => el.tagName === 'BUTTON')
    .map((el) => ({ cls: String(el.className).slice(0, 40), text: (el.textContent ?? '').trim().slice(0, 20) }))
  // 侧栏玻璃现在作用在内容子元素上，取第一个有 backdrop-filter 的子元素做证据。
  const sidebar = document.querySelector('.hHd-Xa_root')
  const glassyChild = sidebar
    ? [...sidebar.children].map((el) => ({ cls: String(el.className).slice(0, 40), bf: getComputedStyle(el).backdropFilter }))
    : []
  // 底部设置栏：footArea 本身必须不模糊（弹窗挂在它里面），但它内部的「设置按钮行」
  // 是弹窗的兄弟，应当被模糊 —— 否则底部 50px 会成为整块侧栏里唯一没有磨砂的条带。
  const triggerRow = document.querySelector('.VOzbGW_triggerRow')
  const footerDetail = {
    triggerRowBackdrop: triggerRow ? getComputedStyle(triggerRow).backdropFilter : '(未找到)',
    settingsAreaBackdrop: (() => {
      const el = document.querySelector('.hHd-Xa_settingsArea')
      return el ? getComputedStyle(el).backdropFilter : '(未找到)'
    })(),
  }
  return { navLike, glassyChild, footerDetail, triggerText: null }
})()`)
console.log('\n--- 设置面板按钮 / 侧栏子元素模糊 ---')
console.log(JSON.stringify(nativeCheck, null, 2))

// 进主题工作室这一页，检查面板文案语言与控件是否渲染
const studio = await evaluate(`(async () => {
  const cell = [...document.querySelectorAll('.VOzbGW_navCell')].find((el) => /主题工作室|Theme Studio/.test(el.textContent))
  if (!cell) return { found: false }
  cell.click()
  await new Promise((r) => setTimeout(r, 1000))
  const page = document.querySelector('.ds-ts-page')
  const text = page ? page.innerText : ''
  const englishWords = (text.match(/\\b(Wallpaper|Glass|Theme color|Master switch|Source|Blur|Opacity|Enable|Performance|Maintenance|Rescan|Shuffle|Browse|Add|Remove|Delete|Use|Clear)\\b/g) ?? [])
  return {
    found: true,
    rendered: page !== null,
    textLength: text.length,
    englishWords: [...new Set(englishWords)],
    hasChinese: /[\\u4e00-\\u9fa5]/.test(text),
    sample: text.split('\\n').slice(0, 16),
    controls: {
      range: document.querySelectorAll('.ds-ts-page input[type=range]').length,
      buttons: document.querySelectorAll('.ds-ts-page button').length,
      tabs: [...document.querySelectorAll('.ds-ts-tabs button')].map((b) => b.textContent.trim()),
      cards: document.querySelectorAll('.ds-ts-card').length,
    },
  }
})()`)

console.log('\n--- 主题工作室面板 ---')
console.log(JSON.stringify(studio, null, 2))

check('主题工作室出现在设置导航', (nativeCheck.navLike ?? []).some((item) => /主题工作室|Theme Studio/.test(item.text)), JSON.stringify((nativeCheck.navLike ?? []).map((item) => item.text)))
check('侧栏内容子元素毛玻璃生效',
  (nativeCheck.glassyChild ?? []).filter((item) => item.bf !== 'none').length >= 2,
  JSON.stringify(nativeCheck.glassyChild))
check('侧栏底部（承载设置弹窗）保持不模糊',
  (nativeCheck.glassyChild ?? []).every((item) => !item.cls.includes('footArea') || item.bf === 'none'),
  JSON.stringify((nativeCheck.glassyChild ?? []).filter((item) => item.cls.includes('footArea'))))
/* 底部条带也必须磨砂：它的「设置按钮行」是弹窗的兄弟，可以安全模糊。
   不模糊它，底部 50px 就是整块侧栏里唯一锐利的条带。 */
check('底部设置行已参与磨砂（不再是唯一锐利条带）',
  String(nativeCheck.footerDetail?.triggerRowBackdrop ?? 'none') !== 'none',
  JSON.stringify(nativeCheck.footerDetail))
check('弹窗挂载点（settingsArea）本身仍不模糊',
  String(nativeCheck.footerDetail?.settingsAreaBackdrop ?? 'none') === 'none',
  String(nativeCheck.footerDetail?.settingsAreaBackdrop))
check('侧栏根不是 fixed 的包含块', !(report.containingAncestors ?? []).some((item) => item.cls.includes('hHd-Xa_root')),
  JSON.stringify((report.containingAncestors ?? []).map((item) => item.cls)))
if (studio.found === true) {
  check('面板成功渲染', studio.rendered === true, `textLength=${studio.textLength}`)
  check('面板不是英文', (studio.englishWords ?? []).length === 0, JSON.stringify(studio.englishWords))
  check('面板含中文', studio.hasChinese === true)
  check('有滑块控件', (studio.controls?.range ?? 0) > 0, `range=${studio.controls?.range} buttons=${studio.controls?.buttons}`)
  check('四个标签页都在', (studio.controls?.tabs ?? []).length === 4, JSON.stringify(studio.controls?.tabs))
}

/* ── 收尾 ──────────────────────────────────────────────────────── */

// 截图：把「对话区（带壁纸与毛玻璃）」和「主题工作室面板」各留一张，便于人工复核。
try {
  const shotDir = new URL('.', import.meta.url)
  await evaluate(`(async () => {
    const cell = [...document.querySelectorAll('.VOzbGW_navCell')].find((el) => el.textContent.includes('通用设置'))
    if (cell) cell.click()
    await new Promise((r) => setTimeout(r, 400))
    const close = document.querySelector('.VOzbGW_close')
    if (close) close.click()
    return true
  })()`)
  await sleep(700)
  const talk = await send('Page.captureScreenshot', { format: 'png' })
  await fs.promises.writeFile(new URL('./shot-conversation.png', shotDir), Buffer.from(talk.data, 'base64'))

  await evaluate(`document.querySelector('.VOzbGW_trigger')?.click()`)
  await sleep(700)
  await evaluate(`(async () => {
    const cell = [...document.querySelectorAll('.VOzbGW_navCell')].find((el) => el.textContent.includes('主题工作室'))
    if (cell) cell.click()
    await new Promise((r) => setTimeout(r, 900))
    return true
  })()`)
  const panelShot = await send('Page.captureScreenshot', { format: 'png' })
  await fs.promises.writeFile(new URL('./shot-settings.png', shotDir), Buffer.from(panelShot.data, 'base64'))
  console.log('\n截图已保存：tools/shot-conversation.png、tools/shot-settings.png')
} catch (error) {
  console.log(`截图失败（不影响结论）：${String(error?.message ?? error)}`)
}

if (!keep) {
  socket.close()
  child.kill()
  await sleep(500)
  await fs.promises.rm(profileDir, { recursive: true, force: true }).catch(() => {})
}

console.log(process.exitCode === 1 ? '\nBROWSER PROBE FAILED' : '\nBROWSER PROBE OK')
