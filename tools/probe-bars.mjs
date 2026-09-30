/**
 * 验收探针：「边栏」分区（侧边栏 + 顶边栏，0.1.15 重写）。
 *
 * 这个分区失败过三次，所以这里逐条验四件事，缺一不可：
 *
 *   1. **膜与模糊真的落在 `::before` 上**，而不是元素自身（读伪元素的计算样式）。
 *   2. **元素自身没有 backdrop-filter**，且**设置弹窗没有被困住** ——
 *      弹窗 `.VOzbGW_overlay` 是 `position: fixed` 且渲染在侧栏子树内部，
 *      只要 `.hHd-Xa_root` 或它的祖先带上 backdrop-filter / filter / transform，
 *      弹窗就会被锁进侧栏的 280×807。这是 0.1.7 的真实故障，
 *      也是这次改用伪元素的唯一原因，必须每次回归都验。
 *   3. **两处实色被剥掉**（`.pI_x6G_sidebarCol` 与 `.hHd-Xa_root`），
 *      否则伪元素背后是平色，模糊看不出来 —— 会退化成「只有控件有边界」的老故障。
 *   4. 分区关闭后**一切复原**：元素回到原生底色、伪元素不再输出。
 *
 * 用法：node tools/probe-bars.mjs <token> <port>
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const token = process.argv[2]
const port = process.argv[3] ?? '3087'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9251
const profileDir = path.join(os.tmpdir(), `dsh-bars-${process.pid}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ORIGIN = `http://127.0.0.1:${port}`
const API = `${ORIGIN}/theme-studio/api`

if (!token) {
  console.error('usage: node tools/probe-bars.mjs <token> <port>')
  process.exit(2)
}

const check = (label, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) process.exitCode = 1
}

/* 本次用的参数：半透明 + 明显的模糊，最容易暴露「膜把模糊吃掉了」。 */
const OPACITY = 0.5
const BLUR = 24

/* ── 浏览器 ─────────────────────────────────────────────────────── */

const child = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`,
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
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

const first = await fetch(`${ORIGIN}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (first.headers.getSetCookie?.() ?? []).map((value) => value.split(';')[0]).join('; ')
await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
await send('Network.setCookie', { name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), domain: '127.0.0.1', path: '/' })

const getConfig = async () => (await (await fetch(`${API}/config`, { headers: { cookie } })).json()).config
const putConfig = async (patch) => (await (await fetch(`${API}/config`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', cookie },
  body: JSON.stringify(patch),
}))).json()

const backup = await getConfig()
console.log(`备份：enabled=${backup.enabled} 壁纸=${backup.wallpaper?.source} glass 键=${Object.keys(backup.glass ?? {}).join(',')}`)
check('宿主配置里有 bars 分区', typeof backup.glass?.bars === 'object', Object.keys(backup.glass ?? {}).join(','))
check('宿主配置里没有旧的 sidebar / topbar 键',
  !('sidebar' in (backup.glass ?? {})) && !('topbar' in (backup.glass ?? {})),
  Object.keys(backup.glass ?? {}).join(','))

/* ── 快照脚本 ─────────────────────────────────────────────────────
 * 伪元素的计算样式要用 `getComputedStyle(el, '::before')` 读。 */
const SNAPSHOT = `(() => {
  const rect = (el) => { if (el === null) return null; const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }
  const styleOf = (el, props, pseudo) => {
    if (el === null) return null
    const cs = getComputedStyle(el, pseudo)
    return Object.fromEntries(props.map((p) => [p, cs[p]]))
  }
  const sidebar = document.querySelector('.hHd-Xa_root')
  const header = document.querySelector('.wSkVaW_header')
  const sidebarCol = document.querySelector('.pI_x6G_sidebarCol')
  const overlay = document.querySelector('.VOzbGW_overlay')
  const mask = document.querySelector('.VOzbGW_mask')
  const panel = document.querySelector('.VOzbGW_panel')
  const SELF = ['position', 'zIndex', 'backgroundColor', 'backdropFilter', 'filter', 'transform']
  const PSEUDO = ['content', 'position', 'inset', 'zIndex', 'backgroundColor', 'backdropFilter', 'pointerEvents']
  const desc = (el) => el === null ? null : el.tagName.toLowerCase() +
    (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 2).map((c) => '.' + c).join('')

  /* ── 层叠顺序（这是第一版探针漏掉的一环）─────────────────────────
   *
   * 几何对得上不代表画得对：.VOzbGW_overlay 是 z-index: 1000 的 fixed 元素，
   * 但**只要它上面多出一个层叠上下文**（比如给 .hHd-Xa_root 加了 z-index），
   * 那个 1000 就被关在里面，变成「相对于该上下文」的 1000 —— 于是整块设置弹窗
   * 会被 DOM 顺序更靠后的内容盖住（.wSkVaW_root 是 position: relative; z-index: auto，
   * 按 CSS 2.1 附录 E 它按 z-index: 0 处理、且排在 .hHd-Xa_root 之后）。
   * elementFromPoint 直接给出「这个点上最上面的是谁」，是唯一可靠的判据。
   * （注意：这段代码在模板字符串里，注释中不能出现反引号。） */
  const hit = (x, y) => {
    const el = document.elementFromPoint(x, y)
    return { top: desc(el), inPanel: panel !== null && el !== null && (panel === el || panel.contains(el)) }
  }
  const stacking = (() => {
    if (panel === null) return null
    const r = panel.getBoundingClientRect()
    return {
      panelCenter: hit(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)),
      panelTopLeft: hit(Math.round(r.x + 12), Math.round(r.y + 12)),
      /* 对话区中心：用来对照「谁盖住了谁」。 */
      chatCenter: hit(Math.round(innerWidth * 3 / 4), Math.round(innerHeight / 2)),
    }
  })()

  /* 全域负 z-index 元素：bars 的伪元素要用 z-index: -1 才排在内容之下，
   * 所以必须知道全站还有谁在负层、以及它们和壁纸图层谁先谁后。 */
  const negativeZ = []
  for (const el of document.querySelectorAll('*')) {
    const z = getComputedStyle(el).zIndex
    if (z !== 'auto' && Number(z) < 0) negativeZ.push({ node: desc(el), z })
  }
  const backgroundLayer = document.getElementById('dsh-theme-studio-bg')

  /* ── 侧栏里的「不透明色块」体检 ──────────────────────────────────
   *
   * 「边栏」把侧栏变透明之后，侧栏内**任何自带不透明底色的元素**都会在壁纸之上
   * 留下一块实色。实测踩到一个：.bhn1Oq_fade 是会话列表底部 24px 的渐隐遮罩，
   * 规则是 linear-gradient(to bottom, transparent, var(--dsw-specific-sidebar-fill))
   * —— 侧栏不透明时它隐形，壁纸透出来后就是一条白带（用户截图报障）。
   * 所以这里把侧栏内所有「带图层 / 不透明底色」的元素连同解析后的颜色列出来，
   * 断言其中不含不透明色（「新会话」按钮那种控件底色是允许的，单独放行）。
   * （注意：这段代码在模板字符串里，注释中不能出现反引号。） */
  const ALLOWED_OPAQUE = ['hHd-Xa_newSession']
  const parseAlpha = (value) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(value || '')
    if (m === null) return null
    const parts = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number)
    return parts.length >= 4 ? parts[3] : 1
  }
  const opaquePaints = []
  for (const el of [sidebar, ...(sidebar === null ? [] : sidebar.querySelectorAll('*'))]) {
    const cs = getComputedStyle(el)
    const image = cs.backgroundImage
    const opaqueColor = (parseAlpha(cs.backgroundColor) ?? 0) > 0.5
    const opaqueInImage = [...image.matchAll(/rgba?\\(([^)]+)\\)/g)].some((m) => (parseAlpha('rgb(' + m[1] + ')') ?? 0) > 0.5)
    if (!opaqueColor && !opaqueInImage) continue
    const cls = String(el.className || '')
    opaquePaints.push({
      node: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 2).map((c) => '.' + c).join('.'),
      color: cs.backgroundColor,
      image: image === 'none' ? 'none' : image.slice(0, 80),
      opaqueInImage,
      allowed: ALLOWED_OPAQUE.some((name) => cls.includes(name)),
    })
  }

  /* token 覆盖的作用域：会话区那个同样消费 sidebar-fill 的元素（trajectory 的标签）
   * 必须在 .hHd-Xa_root 之外，所以直接读几个位置的**解析后 token 值**最可靠 ——
   * 按类名找元素会因为构建哈希变化而失配。 */
  const centerCol = document.querySelector('.pI_x6G_centerCol')
  const tokenOf = (el) => el === null ? null : getComputedStyle(el).getPropertyValue('--dsw-specific-sidebar-fill').trim()

  return {
    viewport: [innerWidth, innerHeight],
    sidebar: { rect: rect(sidebar), self: styleOf(sidebar, SELF), before: styleOf(sidebar, PSEUDO, '::before') },
    header: { rect: rect(header), self: styleOf(header, SELF), before: styleOf(header, PSEUDO, '::before') },
    sidebarCol: styleOf(sidebarCol, ['backgroundColor', 'position', 'zIndex']),
    dialog: { overlay: rect(overlay), mask: rect(mask), panel: rect(panel) },
    stacking,
    negativeZ,
    opaquePaints,
    trajectorySplit: {
      onBody: tokenOf(document.body),
      onSidebar: tokenOf(sidebar),
      onCenterCol: tokenOf(centerCol),
    },
    backgroundLayer: backgroundLayer === null ? null : { node: desc(backgroundLayer), style: styleOf(backgroundLayer, ['position', 'zIndex']) },
    /* 与层叠有关的几个元素：position / z-index 决定谁盖住谁。 */
    paintChain: ['.pI_x6G_frame', '.pI_x6G_sidebarCol', '.hHd-Xa_root', '.pI_x6G_centerCol', '.wSkVaW_root', '.VOzbGW_overlay']
      .map((selector) => {
        const el = document.querySelector(selector)
        return el === null ? null : { selector, ...styleOf(el, ['position', 'zIndex', 'isolation']) }
      })
      .filter(Boolean),
    overlayParentChain: (() => {
      const out = []
      for (let n = overlay; n && n !== document.documentElement; n = n.parentElement) {
        const cs = getComputedStyle(n)
        out.push({
          node: desc(n),
          creating: cs.backdropFilter !== 'none' || cs.filter !== 'none' || cs.transform !== 'none' ||
            cs.perspective !== 'none' || /paint|layout|strict|content/.test(cs.contain) ||
            /transform|filter|perspective/.test(cs.willChange),
          stackingContext: cs.position !== 'static' && cs.zIndex !== 'auto',
        })
      }
      return out
    })(),
  }
})()`

const load = async () => {
  await send('Page.navigate', { url: `${ORIGIN}/?token=${encodeURIComponent(token)}` })
  for (let i = 0; i < 120; i++) {
    await sleep(250)
    if (await evaluate(`document.querySelector('#root')?.children.length > 0`).catch(() => false)) break
  }
  await sleep(2500)
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const rows = [...document.querySelectorAll('[class*="sessionRow"]')]
    const real = rows.filter((n) => !(n.textContent || '').includes('新会话'))[0] ?? rows[0]
    real?.click()
    await sleep(3500)
    return true
  })()`)
  const before = await evaluate(SNAPSHOT)          // 弹窗关着
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    document.querySelector('.VOzbGW_trigger')?.click()
    await sleep(1500)
    return true
  })()`)
  const dialog = await evaluate(SNAPSHOT)          // 弹窗开着
  return { before, dialog }
}

/* ── 阶段 A：边栏关闭（原生基线） ─────────────────────────────── */

await putConfig({ enabled: true, glass: { bars: { enabled: false, opacity: 1, blur: 0 } } })
const off = await load()
console.log(`\n=== 阶段 A：边栏关闭 ===`)
console.log(`  侧栏 ${JSON.stringify(off.before.sidebar.rect)}  自身底色=${off.before.sidebar.self.backgroundColor}  伪元素 content=${off.before.sidebar.before.content}`)
console.log(`  顶边栏 自身底色=${off.before.header.self.backgroundColor}  伪元素 content=${off.before.header.before.content}`)
console.log(`  侧栏外侧 .pI_x6G_sidebarCol 底色=${off.before.sidebarCol.backgroundColor}`)

check('关闭时：侧栏回到 DSH 原生实色（#f9fafb）',
  off.before.sidebar.self.backgroundColor === 'rgb(249, 250, 251)', off.before.sidebar.self.backgroundColor)
check('关闭时：侧栏外侧那层也是原生实色', off.before.sidebarCol.backgroundColor === 'rgb(249, 250, 251)',
  off.before.sidebarCol.backgroundColor)
check('关闭时：侧栏没有 ::before 内容', off.before.sidebar.before.content === 'none', off.before.sidebar.before.content)
check('关闭时：顶边栏没有 ::before 内容', off.before.header.before.content === 'none', off.before.header.before.content)

/* ── 阶段 B：边栏开启（半透明 + 24px 模糊） ───────────────────── */

await putConfig({ enabled: true, glass: { bars: { enabled: true, opacity: OPACITY, blur: BLUR } } })
const on = await load()
const sidebarBefore = on.before.sidebar.before
const headerBefore = on.before.header.before
console.log(`\n=== 阶段 B：边栏开启（不透明度 ${OPACITY} / 模糊 ${BLUR}px）===`)
console.log(`  侧栏 自身：position=${on.before.sidebar.self.position} z-index=${on.before.sidebar.self.zIndex} 底色=${on.before.sidebar.self.backgroundColor} backdrop-filter=${on.before.sidebar.self.backdropFilter}`)
console.log(`  侧栏 ::before：content=${sidebarBefore.content} position=${sidebarBefore.position} inset=${sidebarBefore.inset} z-index=${sidebarBefore.zIndex}`)
console.log(`                 底色=${sidebarBefore.backgroundColor} backdrop-filter=${sidebarBefore.backdropFilter}`)
console.log(`  侧栏外侧 .pI_x6G_sidebarCol 底色=${on.before.sidebarCol.backgroundColor}`)
console.log(`  顶边栏 ::before：content=${headerBefore.content} 底色=${headerBefore.backgroundColor} backdrop-filter=${headerBefore.backdropFilter}`)
console.log(`\n  设置弹窗（弹窗打开时）：遮罩 ${JSON.stringify(on.dialog.dialog.mask)}  面板 ${JSON.stringify(on.dialog.dialog.panel)}  视口 ${JSON.stringify(on.dialog.viewport)}`)

/* 1) 膜与模糊在伪元素上 */
check('侧栏 ::before 存在且带底色', sidebarBefore.content !== 'none' && sidebarBefore.backgroundColor === `rgba(255, 255, 255, ${OPACITY})`,
  `content=${sidebarBefore.content} 底色=${sidebarBefore.backgroundColor}`)
check(`侧栏 ::before 带 blur(${BLUR}px)`, sidebarBefore.backdropFilter === `blur(${BLUR}px)`, sidebarBefore.backdropFilter)
check('侧栏 ::before 是绝对定位、铺满、且不接收指针事件',
  sidebarBefore.position === 'absolute' && sidebarBefore.pointerEvents === 'none',
  `position=${sidebarBefore.position} pointer-events=${sidebarBefore.pointerEvents}`)
check('侧栏 ::before 在内容之下（z-index: -1）', String(sidebarBefore.zIndex) === '-1', String(sidebarBefore.zIndex))
check('顶边栏 ::before 同样带底色与模糊',
  headerBefore.content !== 'none' && headerBefore.backgroundColor === `rgba(255, 255, 255, ${OPACITY})` &&
    headerBefore.backdropFilter === `blur(${BLUR}px)`,
  `content=${headerBefore.content} 底色=${headerBefore.backgroundColor} 模糊=${headerBefore.backdropFilter}`)

/* 2) 元素自身绝不带 backdrop-filter，且弹窗没被困住 */
check('侧栏自身没有 backdrop-filter', on.before.sidebar.self.backdropFilter === 'none', on.before.sidebar.self.backdropFilter)
check('顶边栏自身没有 backdrop-filter', on.before.header.self.backdropFilter === 'none', on.before.header.self.backdropFilter)
const creators = on.dialog.overlayParentChain.filter((item) => item.creating)
console.log(`  弹窗祖先链上的包含块制造者：${creators.length === 0 ? '（无）' : creators.map((c) => c.node).join(' → ')}`)
check('设置弹窗的祖先链上没有包含块制造者', creators.length === 0, creators.map((c) => c.node).join(' → ') || '(无)')
check('设置遮罩铺满视口（弹窗没有被锁进侧栏）',
  on.dialog.dialog.mask !== null &&
    Math.abs(on.dialog.dialog.mask[2] - on.dialog.viewport[0]) <= 2 &&
    Math.abs(on.dialog.dialog.mask[3] - on.dialog.viewport[1]) <= 2,
  `${JSON.stringify(on.dialog.dialog.mask)} vs ${JSON.stringify(on.dialog.viewport)}`)
check('设置面板宽度 > 600 且水平居中（不是被压成侧栏宽度）',
  on.dialog.dialog.panel !== null && on.dialog.dialog.panel[2] > 600 &&
    Math.abs(on.dialog.dialog.panel[0] + on.dialog.dialog.panel[2] / 2 - on.dialog.viewport[0] / 2) <= 24,
  JSON.stringify(on.dialog.dialog.panel))

/* 2b) 层叠顺序 —— 几何对不代表画得对。
 *
 * `.VOzbGW_overlay` 是 `z-index: 1000` 的 fixed 元素，但只要它上面多出一个
 * **层叠上下文**，那个 1000 就被关在里面，整块弹窗会被 DOM 顺序更靠后的内容盖住。
 * 第一版探针只量了几何，所以「弹窗尺寸位置全对、却画在对话界面下方」这个 bug
 * 一路绿着过去了 —— 这一条就是补那个洞。 */
console.log('\n  层叠顺序（elementFromPoint：这个点上最上面的是谁）')
const stack = on.dialog.stacking
console.log(`    面板中心 → ${JSON.stringify(stack.panelCenter)}`)
console.log(`    面板左上 → ${JSON.stringify(stack.panelTopLeft)}`)
console.log(`    对话区中心 → ${JSON.stringify(stack.chatCenter)}`)
console.log('  与层叠有关的元素：')
for (const item of on.dialog.paintChain) {
  console.log(`    ${item.selector.padEnd(22)} position=${String(item.position).padEnd(9)} z-index=${String(item.zIndex).padEnd(6)} isolation=${item.isolation}`)
}
/* 注意要**排除弹窗自己**：`.VOzbGW_overlay` 自身是 `position: fixed; z-index: 1000`，
 * 按定义它就是一个层叠上下文。要查的是「它和根之间」有没有多出别的上下文。 */
const stackedAncestors = on.dialog.overlayParentChain.slice(1).filter((item) => item.stackingContext)
console.log(`  弹窗祖先链上的层叠上下文（不含弹窗自身）：${stackedAncestors.length === 0 ? '（无 —— 它的 z-index:1000 参与根上下文）' : stackedAncestors.map((c) => c.node).join(' → ')}`)
console.log(`  负 z-index 元素（不含壁纸层）：${on.dialog.negativeZ.filter((n) => !n.node.includes('dsh-theme-studio-bg')).map((n) => `${n.node}(${n.z})`).join(', ') || '（无）'}`)
console.log(`  壁纸层：#dsh-theme-studio-bg ${on.dialog.backgroundLayer === null ? '（不存在 —— 当前没有启用壁纸，磨砂背后是空的）' : `z-index=${on.dialog.backgroundLayer.style.zIndex}`}`)

check('设置弹窗画在对话界面之上（面板中心点上最上面的是面板自己）',
  stack.panelCenter.inPanel === true, JSON.stringify(stack.panelCenter))
check('设置弹窗左上角也在面板上（没有被对话区切掉一角）',
  stack.panelTopLeft.inPanel === true, JSON.stringify(stack.panelTopLeft))
check('★ 弹窗与根之间没有任何层叠上下文（否则 z-index:1000 会被关在里面）',
  stackedAncestors.length === 0, stackedAncestors.map((c) => c.node).join(' → ') || '(无)')

/* 3) 两处实色被剥掉 */
check('开启时：侧栏自身底色被让给伪元素（transparent）',
  on.before.sidebar.self.backgroundColor === 'rgba(0, 0, 0, 0)', on.before.sidebar.self.backgroundColor)
check('开启时：侧栏外侧那层实色也被剥掉（否则模糊看着像没生效）',
  on.before.sidebarCol.backgroundColor === 'rgba(0, 0, 0, 0)', on.before.sidebarCol.backgroundColor)

/* 4) 侧栏里不许留下任何「实色块」——这是「侧栏下方出现异常白块」的回归点。
 *    重点是会话列表底部那条 .bhn1Oq_fade 渐隐遮罩：它的渐变终点是实色
 *    --dsw-specific-sidebar-fill，侧栏不透明时隐形，壁纸透出来就是一条白带。 */
console.log('\n  侧栏内自带不透明底色的元素（体检）：')
const blocking = on.before.opaquePaints.filter((item) => !item.allowed)
for (const item of on.before.opaquePaints) {
  console.log(`    ${item.allowed ? '允许' : '★异常'} ${item.node.padEnd(34)} color=${item.color} image=${item.image}`)
}
if (on.before.opaquePaints.length === 0) console.log('    （一个都没有）')
check('★ 侧栏内没有意料之外的不透明色块（含渐隐遮罩那条白带）',
  blocking.length === 0, blocking.map((item) => `${item.node} ${item.image}`).join(' | ') || '(无)')
/* token 覆盖必须**只**作用于侧栏：`.pI_x6G_sidebarCol` 是 `.hHd-Xa_root` 的父级，
 * 继承不到覆盖值，所以它单独有一条规则；而会话区的 trajectory 标签也消费同一个 token，
 * 必须保持原生实色 —— 否则「边栏」分区会莫名其妙改到对话内容。 */
const scope = on.before.trajectorySplit
console.log(`\n  --dsw-specific-sidebar-fill 的作用域：body=${scope.onBody}  侧栏=${scope.onSidebar}  中心列=${scope.onCenterCol}`)
check('★ token 覆盖只落在侧栏内（侧栏 = transparent）',
  scope.onSidebar === 'transparent', String(scope.onSidebar))
check('★ token 覆盖没有外溢（body 与中心列仍是原生 #f9fafb）',
  scope.onBody === '#f9fafb' && scope.onCenterCol === '#f9fafb',
  `body=${scope.onBody} 中心列=${scope.onCenterCol}`)

/* ── 收尾：还原配置 ─────────────────────────────────────────────── */

await putConfig({ enabled: backup.enabled, glass: backup.glass, wallpaper: backup.wallpaper, accent: backup.accent })
console.log('\n配置已还原')

socket.close()
child.kill()
await sleep(400)
await fs.promises.rm(profileDir, { recursive: true, force: true }).catch(() => {})
console.log(process.exitCode === 1 ? '\nBARS PROBE FAILED' : '\nBARS PROBE OK')
