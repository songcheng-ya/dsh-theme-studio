/**
 * 验收探针：**已被整体删除的分区**确实不再受本插件影响。
 *
 * 这是 `probe-sidebar-removed.mjs` 的通用化版本 —— 侧栏（0.1.9 删）与顶边栏
 * （0.1.12 删）共用一套判定，以后每删一个分区只要往 REMOVED 表里加一行。
 * 老脚本保留作历史记录，但**当前有效的验收脚本是这个**。
 *
 * 不做任何视觉效果评价，只回答三个可判定的事实问题（对每个已删分区各问一遍）：
 *
 *   1. 插件生成的样式表里，**有没有任何一条规则命中该分区的子树**？
 *      （做法：把插件 <style> 里的每条规则选择器拿出来，逐个到该子树里跑
 *        querySelectorAll + matches，命中数必须为 0。）
 *   2. 开着壁纸 + 把**所有现存分区**都拉到半透明之后，该分区元素的
 *      **计算样式是否与「插件关闭」时逐项一致**？
 *      （几何 + 背景色 + backdrop-filter + 阴影 + 文字色等 11 项）
 *   3. 设置里还有没有它的分区卡片？宿主配置里还有没有它的键？
 *
 * 反向保险：同时断言**现存分区照旧收到规则** —— 否则「全删光了」也能让上面全绿。
 *
 * 用法：node tools/probe-removed-regions.mjs <token> <port>
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const token = process.argv[2]
const port = process.argv[3] ?? '3087'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9247
const profileDir = path.join(os.tmpdir(), `dsh-removed-${process.pid}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ORIGIN = `http://127.0.0.1:${port}`
const API = `${ORIGIN}/theme-studio/api`

if (!token) {
  console.error('usage: node tools/probe-removed-regions.mjs <token> <port>')
  process.exit(2)
}

const check = (label, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) process.exitCode = 1
}

/** 已整体删除的分区：键、中文名、根元素选择器、判定范围、以及在哪个场景里量。
 *
 * `scope` 有两种，不能混：
 *   - `subtree`：这个分区独占一棵子树，插件规则一条都不许命中它**及其后代**
 *     （侧栏、顶边栏、设置弹窗都是这种）。
 *   - `self`：这个分区的根**包含别的现存分区**，所以只能要求「根自己不被命中」，
 *     后代由各自的分区负责。对话区就是这种 —— 中心列里还住着输入框和气泡，
 *     拿它当子树查的话，输入框/气泡的规则会被误判成「对话区没删干净」。
 *
 * `when` 决定在哪个快照里量，同样不能混：
 *   - `app`（默认）：应用主界面，此时设置弹窗是关的。
 *   - `dialog`：必须先把设置弹窗打开。设置弹窗（`.VOzbGW_panel`）只在打开时存在，
 *     而且它渲染在**侧栏子树内部** —— 所以量它的那次快照绝不能用来判侧栏，
 *     否则 `panel` 的规则会命中侧栏子树，把「侧栏没删干净」误报出来。
 *
 * `expect` 决定「与原生逐项一致」这条硬断言要不要下：
 *   - `identical`（默认）：插件规则不命中它，且它的计算样式与原生逐项一致。
 *   - `rules-only`：只要求「插件规则不命中它 + 内部没有 backdrop-filter」。
 *     用于那些**底色由别的分区/全局 token 顺带决定**的分区。设置弹窗就是这种：
 *     `.VOzbGW_panel { background: var(--dsw-alias-bg-layer-2) }`，而 layer-2 归
 *     「弹层菜单」分区管 —— 所以把菜单不透明度调低，设置弹窗会跟着变透明。
 *     那是 DSH 原生的令牌用法，不是「设置界面分区没删干净」，不该判 FAIL，
 *     但必须**显式打印出来**，免得下次又被当成残留。 */
const REMOVED = [
  { key: 'chat', zh: '对话区', selector: '.pI_x6G_centerCol', scope: 'self' },
  { key: 'panel', zh: '设置界面', selector: '.VOzbGW_panel', scope: 'subtree', when: 'dialog', expect: 'rules-only' },
]
/** 每个现存分区各自的一条代表性选择器（用来做「还没删光」的反向保险）。
 *  `bars` 在 0.1.15 重新接管了侧栏与顶边栏，所以它们现在也算「现存」。 */
const LIVE_MARKERS = ['hHd-Xa_root', 'wSkVaW_header', 'uV2eYG_card', 'Sixlwa_bubble', 'bRhRbq_panel']

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

/* ── 配置：读现状 → 备份 → 布置一个「最容易暴露问题」的场景 ──
 *
 * 壁纸开着 + **所有现存分区**全部拉到 opacity 0.5 / blur 20：
 * 如果已删分区还残留任何一层磨砂或底色覆盖，这个场景一定看得出来。
 * 现存分区列表从宿主配置里读，不手抄 —— 加/删分区时探针不用改。 */
const getConfig = async () => (await (await fetch(`${API}/config`, { headers: { cookie } })).json()).config
const putConfig = async (patch) => (await (await fetch(`${API}/config`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', cookie },
  body: JSON.stringify(patch),
}))).json()

const backup = await getConfig()
const wallpaper = backup.wallpaper?.fixed || backup.wallpaper?.current || ''
const liveRegions = Object.keys(backup.glass ?? {}).filter((key) => typeof backup.glass[key] === 'object')
console.log(`备份配置：enabled=${backup.enabled} wallpaper=${wallpaper || '(无)'}`)
console.log(`备份里的 glass 键：${Object.keys(backup.glass ?? {}).join(',')}`)
console.log(`现存分区（${liveRegions.length} 个）：${liveRegions.join(',')}`)

for (const region of REMOVED) {
  check(`宿主配置里已无 ${region.key} 分区`, !(region.key in (backup.glass ?? {})),
    Object.keys(backup.glass ?? {}).join(','))
}

const allOn = Object.fromEntries(liveRegions.map((key) => [key, { enabled: true, opacity: 0.5, blur: 20 }]))

/* ── 快照脚本 ────────────────────────────────────────────────────── */

const SNAPSHOT = `(() => {
  const REMOVED = ${JSON.stringify(REMOVED)}
  const rect = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }
  const STYLE_PROPS = ['backgroundColor', 'backgroundImage', 'backdropFilter', 'boxShadow', 'filter', 'opacity', 'color', 'borderRightColor', 'position', 'transform', 'contain']
  const desc = (el) => el.tagName.toLowerCase() + '.' + String(el.className || '').split(/\\s+/).filter(Boolean).slice(0, 2).join('.')

  /* 插件样式表里所有选择器，稍后逐个到每个已删子树上试命中。 */
  const rules = []
  for (const sheet of document.styleSheets) {
    if (sheet.ownerNode?.getAttribute?.('data-plugin-css') !== 'dsh-theme-studio/theme.css') continue
    for (const rule of sheet.cssRules) if (rule.selectorText) rules.push(rule.selectorText)
  }

  const regions = {}
  for (const region of REMOVED) {
    const root = document.querySelector(region.selector)
    if (!root) { regions[region.key] = { missing: true }; continue }
    const selfOnly = region.scope === 'self'
    const nodes = selfOnly ? [root] : [root, ...root.querySelectorAll('*')]
    const hits = []
    for (const selector of rules) {
      let count = 0
      try {
        count = selfOnly
          ? (root.matches(selector) ? 1 : 0)
          : root.querySelectorAll(selector).length + (root.matches(selector) ? 1 : 0)
      } catch { count = -1 }
      if (count !== 0) hits.push({ selector: selector.replace(/\\s+/g, ' ').slice(0, 110), count })
    }

    /* 有效背景链：从该元素往上走，逐级记录「谁在给它兜底」。
     *
     * 这是本探针最初漏掉的一环，也正是「顶边栏看起来仍然透明」的成因：
     * 只比对该元素**自己**的计算样式是不够的 —— 顶边栏自身 natively 就是
     * transparent，它看上去是什么颜色完全取决于**祖先**里的第一层实色背景。
     * 插件把外壳 .pI_x6G_frame 改透明之后，这条链的终点就从「外壳底色」变成了
     * 「壁纸图层」，于是顶边栏「看起来透明了」，可它自己的样式一分没变。
     * 所以这里把整条链连同「每一级被哪些插件规则命中」一起取回来。
     * （注意：这段代码在模板字符串里，注释中不能出现反引号。） */
    const chain = []
    for (let node = root; node && node !== document.documentElement.parentElement; node = node.parentElement) {
      const cs = getComputedStyle(node)
      const matched = []
      for (const selector of rules) {
        try { if (node.matches(selector)) matched.push(selector.replace(/\\s+/g, ' ').slice(0, 110)) } catch {}
      }
      const parsed = /rgba?\\(([^)]+)\\)/.exec(cs.backgroundColor)
      const parts = parsed ? parsed[1].split(/[\\s,\\/]+/).filter(Boolean).map(Number) : []
      chain.push({
        node: desc(node),
        bg: cs.backgroundColor,
        bgOpaque: parts.length >= 4 ? parts[3] > 0 : parsed !== null,
        bgImage: cs.backgroundImage === 'none' ? 'none' : '有图层',
        backdrop: cs.backdropFilter,
        matched,
        isSelf: node === root,
      })
      if (chain.length >= 14) break
    }

    regions[region.key] = {
      missing: false,
      rect: rect(root),
      nodeCount: nodes.length,
      styles: nodes.map((el) => ({ node: desc(el), values: STYLE_PROPS.map((p) => getComputedStyle(el)[p]) })),
      hits,
      blurs: nodes.filter((el) => { const v = getComputedStyle(el).backdropFilter; return v && v !== 'none' }).length,
      backgroundSample: getComputedStyle(root).backgroundColor,
      textShadowSample: getComputedStyle(root.querySelector('*') ?? root).textShadow,
      chain,
    }
  }

  /* 反向保险：现存分区的选择器必须还在生成的 CSS 里。 */
  const liveCss = rules.join(' ')
  return {
    pluginAttr: document.documentElement.hasAttribute('data-dsh-theme-studio'),
    viewport: [innerWidth, innerHeight],
    sidebarFillToken: getComputedStyle(document.body).getPropertyValue('--dsw-specific-sidebar-fill').trim(),
    ruleCount: rules.length,
    rulesText: liveCss.slice(0, 20000),
    regions,
  }
})()`

/**
 * 打开一个会话。
 *
 * 这一步是必须的：**没进会话时 `.wSkVaW_header` 是 0×0 的隐藏条**（类名会多一个
 * `wSkVaW_headerHidden`）。此时「顶边栏与原生逐项一致」是在拿两个空盒子比对，
 * 必然通过却什么也没证明 —— 第一版探针就是这么空转过去的。所以这里先点开一个会话，
 * 后面还会显式断言「测量到的是有尺寸的元素」。
 */
const openSession = () => evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const header = () => document.querySelector('.wSkVaW_header')
  const sized = () => { const el = header(); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const diag = () => {
    const el = header()
    return {
      headerClass: el ? String(el.className) : '(无 .wSkVaW_header)',
      headerRect: el ? (() => { const r = el.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] })() : null,
      rows: [...document.querySelectorAll('[class*="sessionRow"], [class*="projectRow"]')]
        .slice(0, 8)
        .map((node) => {
          const r = node.getBoundingClientRect()
          return { cls: String(node.className).split(/\\s+/)[0], text: (node.textContent || '').trim().slice(0, 24), rect: [Math.round(r.width), Math.round(r.height)] }
        }),
    }
  }
  if (sized()) return { ok: true, how: '已有会话', diag: diag() }
  const click = async (node, how) => {
    node.click()
    await sleep(4500)
    return { ok: sized(), how, diag: diag() }
  }
  const label = (node) => (node.textContent || '').trim().slice(0, 18)
  /* 第一行常常是「新会话」草稿项，点它不会进入带标题的会话；挑第一个真正的会话。
     注意：这段代码在 evaluate 的模板字符串里，**不能再用反引号**，只能拼字符串。 */
  const rows = [...document.querySelectorAll('[class*="sessionRow"]')]
  const real = rows.filter((node) => !(node.textContent || '').includes('新会话'))[0] ?? rows[0]
  if (real) return await click(real, '点会话行「' + label(real) + '」')
  const project = document.querySelector('[class*="projectRow"]')
  if (project) {
    project.click()
    await sleep(1500)
    const after = [...document.querySelectorAll('[class*="sessionRow"]')]
    const pick = after.filter((node) => !(node.textContent || '').includes('新会话'))[0] ?? after[0]
    if (pick) return await click(pick, '展开项目后点会话行「' + label(pick) + '」')
    return { ok: sized(), how: '展开项目后仍无会话行', diag: diag() }
  }
  return { ok: false, how: '没找到任何会话行/项目行', diag: diag() }
})()`)

/** 打开设置弹窗。`panel` 分区的根只在弹窗打开时存在，所以 dialog 那一趟必须调它。 */
const openDialog = () => evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  if (document.querySelector('.VOzbGW_panel')) return { ok: true, how: '弹窗已开着' }
  const trigger = document.querySelector('.VOzbGW_trigger')
  if (!trigger) return { ok: false, how: '找不到 .VOzbGW_trigger' }
  trigger.click()
  await sleep(1500)
  return { ok: document.querySelector('.VOzbGW_panel') !== null, how: '点了设置触发器' }
})()`)

/**
 * 两趟快照。
 *
 * 顺序很重要：**先量主界面（弹窗关着）**，再打开弹窗量第二趟。
 * 设置弹窗渲染在侧栏子树内部，弹窗开着的时候 `panel` 的规则会命中侧栏子树 ——
 * 那一趟拿来判侧栏就会误报。所以侧栏/顶边栏/对话区只认 app 那一趟。
 */
const load = async () => {
  await send('Page.navigate', { url: `${ORIGIN}/?token=${encodeURIComponent(token)}` })
  for (let i = 0; i < 120; i++) {
    await sleep(250)
    if (await evaluate(`document.querySelector('#root')?.children.length > 0`).catch(() => false)) break
  }
  await sleep(2500)
  const session = await openSession()
  const app = await evaluate(SNAPSHOT)
  const dialogOpened = await openDialog()
  const dialog = await evaluate(SNAPSHOT)
  return { app, dialog, session, dialogOpened }
}

/** 按 `when` 取对应那一趟的快照。 */
const sheetFor = (region, sheets) => (region.when === 'dialog' ? sheets.dialog : sheets.app)

/* ── 阶段 A：插件关闭（原生基线） ─────────────────────────────── */

await putConfig({ enabled: false, glass: allOn })
const base = await load()
const missing = REMOVED.filter((region) => sheetFor(region, base).regions[region.key]?.missing)
if (missing.length > 0) {
  console.error(`没找到这些分区的根元素：${missing.map((r) => `${r.zh} ${r.selector}`).join(', ')}`)
  process.exit(1)
}
console.log(`\n会话准备：${base.session.how} → ${base.session.ok ? '成功' : '失败'}`)
if (!base.session.ok) console.log(`  诊断：${JSON.stringify(base.session.diag)}`)
console.log(`弹窗准备：${base.dialogOpened.how} → ${base.dialogOpened.ok ? '成功' : '失败'}`)

console.log('\n=== 阶段 A：插件关闭（原生基线）===')
for (const region of REMOVED) {
  const snap = sheetFor(region, base).regions[region.key]
  const where = region.when === 'dialog' ? '（弹窗打开时）' : ''
  console.log(`  ${region.zh}${where} ${JSON.stringify(snap.rect)}  元素 ${snap.nodeCount} 个  底色 ${snap.backgroundSample}`)
}
/* 测量必须是有意义的：0×0 的元素没什么可比，那种「通过」是假的。 */
for (const region of REMOVED) {
  const snap = sheetFor(region, base).regions[region.key]
  check(`${region.zh}测量有效（元素有实际尺寸，不是被隐藏的空盒子）`,
    snap.rect[2] > 0 && snap.rect[3] > 0, `rect=${JSON.stringify(snap.rect)}`)
}

/* ── 阶段 B：插件开启 + 壁纸 + 所有现存分区全半透明 ─────────────── */

await putConfig({ enabled: true, glass: allOn })
const on = await load()
console.log(`\n=== 阶段 B：插件开启（壁纸 + ${liveRegions.length} 个现存分区 opacity .5 / blur 20）===`)
console.log(`  插件属性已挂上 = ${on.app.pluginAttr}   插件规则数 = ${on.app.ruleCount}（app 趟）/ ${on.dialog.ruleCount}（dialog 趟）`)
for (const region of REMOVED) {
  const snap = sheetFor(region, on).regions[region.key]
  const where = region.when === 'dialog' ? '（弹窗打开时）' : ''
  console.log(`  ${region.zh}${where} ${JSON.stringify(snap.rect)}  元素 ${snap.nodeCount} 个  底色 ${snap.backgroundSample}`)
}

/* ── 判定 1：没有任何插件规则命中已删分区 ──────────────────────── */

console.log('\n=== 判定 1：插件规则是否命中已删分区 ===')
for (const region of REMOVED) {
  const snap = sheetFor(region, on).regions[region.key]
  const range = region.scope === 'self' ? '根元素自身' : '子树'
  const where = region.when === 'dialog' ? '（弹窗打开时）' : ''
  if (snap.hits.length === 0) {
    console.log(`  ${region.zh}${where}（${range}）：已检查 ${sheetFor(region, on).ruleCount} 条规则 → 命中 0 条`)
  } else {
    for (const hit of snap.hits.slice(0, 12)) console.log(`  ${region.zh} 命中 ×${hit.count}  ${hit.selector}`)
  }
  check(`${region.zh}：插件样式表里没有任何规则命中它的${range}`, snap.hits.length === 0, `${snap.hits.length} 条命中`)
}

/* ── 判定 2：计算样式与原生基线逐项一致 ───────────────────────── */

const PROPS = ['backgroundColor', 'backgroundImage', 'backdropFilter', 'boxShadow', 'filter', 'opacity', 'color', 'borderRightColor', 'position', 'transform', 'contain']
console.log('\n=== 判定 2：与原生基线逐项比对 ===')
for (const region of REMOVED) {
  const a = sheetFor(region, base).regions[region.key]
  const b = sheetFor(region, on).regions[region.key]
  check(`${region.zh}几何完全一致`, JSON.stringify(a.rect) === JSON.stringify(b.rect),
    `${JSON.stringify(a.rect)} vs ${JSON.stringify(b.rect)}`)
  check(`${region.zh}元素数量一致（结构未变）`, a.nodeCount === b.nodeCount, `${a.nodeCount} vs ${b.nodeCount}`)
  check(`${region.zh}范围内没有任何元素带 backdrop-filter`, b.blurs === 0, `${b.blurs} 个`)
  const rulesOnly = region.expect === 'rules-only'
  if (!rulesOnly) {
    check(`${region.zh}底色未被插件改写`, a.backgroundSample === b.backgroundSample,
      `${a.backgroundSample} vs ${b.backgroundSample}`)
  } else if (a.backgroundSample !== b.backgroundSample) {
    console.log(`  说明：${region.zh}底色 ${a.backgroundSample} → ${b.backgroundSample}，` +
      '这是「别的分区 / 全局 token」顺带决定的（见下方背景链里它自身那一级命中规则为「(无)」），不是本分区的残留')
  }

  const diffs = []
  const limit = Math.min(a.styles.length, b.styles.length)
  for (let i = 0; i < limit; i++) {
    if (a.styles[i].node !== b.styles[i].node) { diffs.push(`#${i} 结构错位 ${a.styles[i].node} vs ${b.styles[i].node}`); continue }
    for (let p = 0; p < PROPS.length; p++) {
      if (a.styles[i].values[p] !== b.styles[i].values[p]) {
        diffs.push(`#${i} ${a.styles[i].node} ${PROPS[p]}: ${a.styles[i].values[p]} → ${b.styles[i].values[p]}`)
      }
    }
  }
  for (const line of diffs.slice(0, 15)) console.log(`  ${region.zh} 差异：${line}`)
  if (rulesOnly) {
    /* 这种分区的差异允许存在，但必须**逐条能归因**：只允许「分区自身那一级没被插件规则命中」
     * 的前提下，由祖先/别的分区的 token 引起的差异。这里把数量打出来供人工复核，
     * 真正的一致性保证由下面 判定 2b 的「自身那一级命中规则为 (无)」承担。 */
    console.log(`  ${region.zh}（expect=rules-only）：${diffs.length} 处差异不判 FAIL —— 归因见下一条的背景链`)
  } else {
    check(`${region.zh} ${PROPS.length} 项计算样式与原生基线完全一致`, diffs.length === 0, `${diffs.length} 处差异`)
  }
  console.log(`  参考：${region.zh}内文字 text-shadow = ${b.textShadowSample}（原生 ${a.textShadowSample}）`)
}

/* 侧栏底色令牌是它「回到原生」的关键证据，单独验一次。 */
check('侧栏 fill 令牌未被插件改写（原生 #f9fafb）',
  base.app.sidebarFillToken === on.app.sidebarFillToken, `${base.app.sidebarFillToken} vs ${on.app.sidebarFillToken}`)

/* ── 判定 2b：有效背景链 —— 「看起来透明」到底是谁干的 ─────────────
 *
 * 这一节是「顶边栏看起来仍然透明」这个报障的直接答案。
 * 顶边栏自身 natively 就是 `background-color: transparent`，它看上去什么颜色，
 * 取决于**祖先里第一条实色背景**是谁。插件把外壳 `.pI_x6G_frame` 改透明之后，
 * 这条链的落点就从「外壳底色」换成了「壁纸图层」—— 元素自己的样式一分没变，
 * 观感却从「实色条」变成了「透出壁纸」。
 *
 * 所以这里逐级打印背景链，并标出**两级之间发生变化的那些祖先被哪条插件规则命中**。
 * 判定的关键不是「链有没有变」（壁纸功能本来就要让它变），
 * 而是「变的那一级是不是顶边栏自己」—— 只有落在顶边栏自己身上才叫「顶边栏代码没删干净」。 */
console.log('\n=== 判定 2b：有效背景链（谁在给这个分区兜底）===')
for (const region of REMOVED) {
  const a = sheetFor(region, base).regions[region.key].chain
  const b = sheetFor(region, on).regions[region.key].chain
  console.log(`\n  ${region.zh}${region.when === 'dialog' ? '（弹窗打开时）' : ''}：`)
  for (let i = 0; i < b.length; i++) {
    const before = a[i]
    const after = b[i]
    const same = before && before.bg === after.bg && before.bgImage === after.bgImage && before.backdrop === after.backdrop
    const mark = after.isSelf ? '← 分区自身' : ''
    console.log(`    ${same ? ' ' : '≠'} ${after.node.padEnd(34)} 底色 ${String(after.bg).padEnd(26)} 图层 ${after.bgImage.padEnd(6)} 模糊 ${after.backdrop} ${mark}`)
    if (!same && before) {
      console.log(`        插件开启前：底色 ${before.bg} 图层 ${before.bgImage} 模糊 ${before.backdrop}`)
      console.log(`        该级被这些插件规则命中：${after.matched.length > 0 ? after.matched.join('  |  ') : '(无)'}`)
    }
  }

  /* 硬判定：**分区自身那一级**不得被任何插件规则命中 —— 这是「这个分区的代码真的没了」的
   * 唯一可靠判据。至于「自身底色与原生一致」，对 `rules-only` 的分区不能要求：
   * 它的底色本来就可能由别的分区/全局 token 决定（设置弹窗跟随 --dsw-alias-bg-layer-2），
   * 而那一级自己命中的插件规则恰好是「(无)」，正好证明差异不是它带来的。 */
  const selfBefore = a.find((item) => item.isSelf)
  const selfAfter = b.find((item) => item.isSelf)
  check(`${region.zh}自身那一级没有被任何插件规则命中`,
    selfAfter.matched.length === 0, selfAfter.matched.join(' | ') || '(无)')
  if (region.expect === 'rules-only') {
    console.log(`  说明：${region.zh}自身底色 ${selfBefore.bg} → ${selfAfter.bg}，` +
      '但命中它的插件规则为「(无)」，差异来自祖先 / 其他分区的 token，不是本分区的残留')
  } else {
    check(`${region.zh}自身的底色/图层/模糊与原生一致`,
      selfBefore.bg === selfAfter.bg && selfBefore.bgImage === selfAfter.bgImage && selfBefore.backdrop === selfAfter.backdrop,
      `${selfBefore.bg}/${selfBefore.bgImage}/${selfBefore.backdrop} → ${selfAfter.bg}/${selfAfter.bgImage}/${selfAfter.backdrop}`)
  }

  /* 诊断信息：链上第一级「实色且无图层」的祖先是谁 —— 那才是它真正的观感来源。 */
  const opaqueAt = (chain) => chain.find((item) => item.bgOpaque && item.bgImage === 'none')
  const wasOpaque = opaqueAt(a)
  const isOpaque = opaqueAt(b)
  console.log(`    观感来源：插件关闭时 = ${wasOpaque ? `${wasOpaque.node}（${wasOpaque.bg}）` : '(整条链都是透明/图层，落到画布)'}`)
  console.log(`              插件开启时 = ${isOpaque ? `${isOpaque.node}（${isOpaque.bg}）` : '(整条链都是透明/图层，落到画布)'}`)
}

/* ── 判定 3：现存分区照旧收到规则（反向保险） ───────────────────── */

console.log('\n=== 判定 3：现存分区照旧生效（防止「全删光了」也算通过）===')
for (const marker of LIVE_MARKERS) {
  check(`生成的 CSS 仍含现存分区选择器 ${marker}`, on.app.rulesText.includes(marker))
}

/* ── 判定 4：设置界面与弹窗几何 ───────────────────────────────────
 *
 * 注意：弹窗在 load() 里就已经打开了（panel 分区要在那个状态下量），
 * 所以这里**不能再点一次 `.VOzbGW_trigger`` —— 那会把它关掉。 */
console.log('\n=== 判定 4：设置界面 ===')
const glassTab = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }
  const panel = document.querySelector('.VOzbGW_panel') ?? document.body
  const studio = [...panel.querySelectorAll('.VOzbGW_navCell')].find((el) => el.textContent.includes('主题工作室'))
  studio?.click()
  await sleep(800)
  const glassBtn = [...panel.querySelectorAll('button, [role="tab"]')].find((el) => el.textContent.trim() === '毛玻璃')
  glassBtn?.click()
  await sleep(800)
  const page = document.querySelector('.ds-ts-page')
  const cards = page ? [...page.querySelectorAll('.ds-ts-card')] : []
  const styleOf = (el, props) => {
    if (el === null) return null
    const cs = getComputedStyle(el)
    return Object.fromEntries(props.map((p) => [p, cs[p]]))
  }
  const body = getComputedStyle(document.body)
  return {
    viewport: [innerWidth, innerHeight],
    panelRect: rect(document.querySelector('.VOzbGW_panel')),
    maskRect: rect(document.querySelector('.VOzbGW_mask')),
    panelStyle: styleOf(document.querySelector('.VOzbGW_panel'), ['backgroundColor', 'backdropFilter']),
    maskStyle: styleOf(document.querySelector('.VOzbGW_mask'), ['backgroundColor', 'backdropFilter']),
    maskBlurToken: body.getPropertyValue('--dsw-mask-blur').trim(),
    layer1Token: body.getPropertyValue('--dsw-alias-bg-layer-1').trim(),
    overlayToken: body.getPropertyValue('--dsw-alias-bg-overlay').trim(),
    cardTitles: cards.map((card) => card.querySelector('.ds-ts-title')?.textContent?.trim() ?? '?'),
    text: page ? page.textContent : '',
  }
})()`)

console.log(`  弹窗面板 ${JSON.stringify(glassTab.panelRect)}  遮罩 ${JSON.stringify(glassTab.maskRect)}  视口 ${JSON.stringify(glassTab.viewport)}`)
console.log(`  面板样式 ${JSON.stringify(glassTab.panelStyle)}`)
console.log(`  遮罩样式 ${JSON.stringify(glassTab.maskStyle)}`)
console.log(`  令牌 --dsw-mask-blur=${glassTab.maskBlurToken}  --dsw-alias-bg-layer-1=${glassTab.layer1Token}  --dsw-alias-bg-overlay=${glassTab.overlayToken}`)
console.log(`  毛玻璃页卡片：${JSON.stringify(glassTab.cardTitles)}`)
check('设置面板未被锁进侧栏（宽度 > 600）', glassTab.panelRect !== null && glassTab.panelRect[2] > 600, JSON.stringify(glassTab.panelRect))
check('设置遮罩铺满视口',
  glassTab.maskRect !== null &&
    Math.abs(glassTab.maskRect[2] - glassTab.viewport[0]) <= 2 && Math.abs(glassTab.maskRect[3] - glassTab.viewport[1]) <= 2,
  JSON.stringify(glassTab.maskRect))

/* 设置界面分区删掉之后：
 *   · 面板不再有插件写入的底色或 backdrop-filter —— 它现在只有一个底色来源，
 *     就是 `--dsw-alias-bg-layer-2`，而 layer-2 归「弹层菜单」分区管。
 *     所以这一次快照里（menu 被强制成 0.5）面板必须是 0.5；
 *     用户自己的配置里 menu 是不透明度 1，面板就是完全不透明的白。 */
const panelBg = String(glassTab.panelStyle?.backgroundColor ?? '')
const panelAlpha = (() => {
  const m = /rgba?\(([^)]+)\)/.exec(panelBg)
  if (!m) return null
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
  return parts.length >= 4 ? parts[3] : 1
})()
const fixtureMenuOpacity = allOn.menu.opacity
check('设置面板底色只跟随「弹层菜单」的 layer-2 令牌（本次强制 0.5）',
  panelAlpha === fixtureMenuOpacity, `${panelBg} → alpha=${panelAlpha}，menu fixture opacity=${fixtureMenuOpacity}`)
check('设置面板自身没有 backdrop-filter（分区删掉后不再有任何模糊）',
  String(glassTab.panelStyle?.backdropFilter) === 'none', String(glassTab.panelStyle?.backdropFilter))
check('设置遮罩没有被插件接管模糊（--dsw-mask-blur 回到 DSH 原生值）',
  glassTab.maskBlurToken !== '' && !String(glassTab.maskStyle?.backdropFilter).includes('20px'),
  `token=${glassTab.maskBlurToken} computed=${glassTab.maskStyle?.backdropFilter}`)
check('--dsw-alias-bg-layer-1 / --dsw-alias-bg-overlay 已是 DSH 原生值（不再指向 --ds-ts-panel）',
  !glassTab.layer1Token.includes('--ds-ts-') && !glassTab.overlayToken.includes('--ds-ts-'),
  `${glassTab.layer1Token} / ${glassTab.overlayToken}`)

for (const region of REMOVED) {
  check(`毛玻璃页不再有「${region.zh}」分区卡片`,
    !glassTab.cardTitles.includes(region.zh) && !String(glassTab.text).includes(region.zh),
    glassTab.cardTitles.join(' / '))
}
check(`毛玻璃页渲染出现存分区卡片（${liveRegions.length} 张 + 总开关 + 公共质感）`,
  glassTab.cardTitles.length === liveRegions.length + 2, `${glassTab.cardTitles.length} 张：${glassTab.cardTitles.join(' / ')}`)

/* ── 还原配置 ───────────────────────────────────────────────────── */

await putConfig({ enabled: backup.enabled, glass: backup.glass, wallpaper: backup.wallpaper, accent: backup.accent })
console.log('\n配置已还原')

socket.close()
child.kill()
await sleep(400)
await fs.promises.rm(profileDir, { recursive: true, force: true }).catch(() => {})
console.log(process.exitCode === 1 ? '\nREMOVED REGIONS PROBE FAILED' : '\nREMOVED REGIONS PROBE OK')
