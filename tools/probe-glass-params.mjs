/**
 * 验收探针：毛玻璃的两个参数已被移除（0.1.11）。
 *
 *   1. 每个分区卡片只剩「开关 / 不透明度 / 模糊」—— 不再有「饱和度」滑块；
 *   2. 模糊滑块的上限是 **100px**（原来是 40px，且还会被「画质档位」二次截断）；
 *   3. 「其他」页不再有「性能 / 画质档位」卡片；
 *   4. 落盘配置里不再有 `glass.*.saturation` 与 `perf`（读盘时被 dropRetiredKeys 清掉）。
 *
 * 用法：node tools/probe-glass-params.mjs <token> <port>
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const token = process.argv[2]
const port = process.argv[3] ?? '3087'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9245
const profileDir = path.join(os.tmpdir(), `dsh-glass-params-${process.pid}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ORIGIN = `http://127.0.0.1:${port}`

if (!token) {
  console.error('usage: node tools/probe-glass-params.mjs <token> <port>')
  process.exit(2)
}

const check = (label, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) process.exitCode = 1
}

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
await send('Page.navigate', { url: `${ORIGIN}/` })
await sleep(4000)

/* ── 配置：宿主有没有把废弃键清掉 ───────────────────────────────────
 *
 * 这里读的是 `/api/config`，也就是宿主的**进程内缓存**，不是磁盘原文。
 * 两者都要干净才算对：缓存脏了会顺着 writeConfig 落盘（见 lib/index.js 的
 * mergeConfig 注释，那是一个真实踩过的坑）。 */
const API = `${ORIGIN}/theme-studio/api`
const config = (await (await fetch(`${API}/config`, { headers: { cookie } })).json()).config
const regionKeys = Object.keys(config.glass ?? {}).filter((key) => typeof config.glass[key] === 'object')
console.log(`\n宿主配置顶层键：${Object.keys(config ?? {}).join(',')}`)
console.log(`glass 键：${Object.keys(config.glass ?? {}).join(',')}`)
console.log(`分区：${regionKeys.join(',')}`)

check('宿主配置里没有任何分区带 saturation',
  regionKeys.every((key) => !('saturation' in config.glass[key])),
  regionKeys.map((key) => `${key}:${Object.keys(config.glass[key]).join('/')}`).join('  '))
check('宿主配置里没有 perf 键', !('perf' in config), Object.keys(config).join(','))
/* 分区数会随每次增删变化，所以这里不写死数字 —— 只断言「现存的一个不少、旧键一个不留」。 */
const EXPECTED_REGIONS = ['bars', 'input', 'bubble', 'menu']
const REMOVED_REGIONS = ['sidebar', 'topbar', 'chat', 'panel']
check(`宿主配置里只剩 ${EXPECTED_REGIONS.length} 个分区` +
  '（sidebar/topbar 0.1.15 合并为 bars；chat 0.1.13、panel 0.1.14 删）',
  EXPECTED_REGIONS.every((key) => regionKeys.includes(key)) &&
    regionKeys.length === EXPECTED_REGIONS.length &&
    REMOVED_REGIONS.every((key) => !regionKeys.includes(key)),
  regionKeys.join(','))

/* ── 打开设置 → 主题工作室 ──────────────────────────────────────── */

const opened = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  document.querySelector('.VOzbGW_trigger')?.click()
  await sleep(1200)
  const panel = document.querySelector('.VOzbGW_panel') ?? document.body
  const studio = [...panel.querySelectorAll('.VOzbGW_navCell')].find((el) => el.textContent.includes('主题工作室'))
  studio?.click()
  await sleep(900)
  return { page: document.querySelector('.ds-ts-page') !== null }
})()`)
if (!opened.page) {
  console.error('设置页没渲染出来')
  process.exit(1)
}

/** 切到某个标签页，把该页所有 SliderRow 的「名称 + min/max」读出来。 */
const readTab = (label) => evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const btn = [...document.querySelectorAll('.ds-ts-tabs button')].find((el) => el.textContent.trim() === ${JSON.stringify(label)})
  btn?.click()
  await sleep(700)
  const page = document.querySelector('.ds-ts-page')
  const cards = [...page.querySelectorAll('.ds-ts-card')]
  const sliders = [...page.querySelectorAll('.ds-ts-slider')].map((el) => {
    const row = el.closest('.ds-ts-row')
    return { name: row?.querySelector('.ds-ts-name')?.textContent?.trim() ?? '?', min: el.min, max: el.max, value: el.value }
  })
  return {
    clicked: Boolean(btn),
    cardTitles: cards.map((card) => card.querySelector('.ds-ts-title')?.textContent?.trim() ?? '?'),
    sliders,
    text: page.textContent,
  }
})()`)

const glassTab = await readTab('毛玻璃')
console.log(`\n毛玻璃页卡片：${JSON.stringify(glassTab.cardTitles)}`)
console.log('滑块（名称 min–max）：')
for (const item of glassTab.sliders) console.log(`    ${item.name}  ${item.min}–${item.max}  当前 ${item.value}`)

check('毛玻璃页不再出现「饱和度」滑块',
  glassTab.sliders.every((item) => item.name !== '饱和度') && !glassTab.text.includes('饱和度'),
  glassTab.sliders.map((item) => item.name).join(', '))
/* 每张分区卡片两个滑块（不透明度 + 模糊），公共质感两个（描边强度 + 顶部高光）。
 * 用集合比较，不要用 sort().join() —— 中文的排序位置和字面量顺序对不上，会假失败。 */
const sliderNames = [...new Set(glassTab.sliders.map((item) => item.name))]
const expectedNames = ['不透明度', '模糊', '描边强度', '顶部高光']
check('滑块只剩「不透明度 / 模糊 / 描边强度 / 顶部高光」四种',
  sliderNames.length === expectedNames.length && expectedNames.every((name) => sliderNames.includes(name)),
  sliderNames.join(','))
const blurSliders = glassTab.sliders.filter((item) => item.name === '模糊')
check(`每个现存分区各一个「模糊」滑块（${EXPECTED_REGIONS.length} 个）`,
  blurSliders.length === EXPECTED_REGIONS.length, String(blurSliders.length))
/* 判「卡片标题」而不是「页面文本」：`边栏` 的说明文字就是「侧边栏与顶边栏，共用一份参数」，
 * 整页搜「侧边栏」三个字必然命中，那是设计如此。 */
for (const zh of ['侧边栏', '顶边栏', '对话区', '设置界面']) {
  check(`毛玻璃页没有以「${zh}」为标题的分区卡片`,
    !glassTab.cardTitles.includes(zh),
    glassTab.cardTitles.join(' / '))
}
check('毛玻璃页出现「边栏」卡片，且只有它一个管侧栏/顶边栏',
  glassTab.cardTitles.filter((title) => title === '边栏').length === 1,
  glassTab.cardTitles.join(' / '))
check(`毛玻璃页卡片数 = 现存分区数 + 总开关 + 公共质感（${EXPECTED_REGIONS.length + 2} 张）`,
  glassTab.cardTitles.length === EXPECTED_REGIONS.length + 2,
  `${glassTab.cardTitles.length} 张：${glassTab.cardTitles.join(' / ')}`)
check('模糊滑块上限是 100px（不再是 40px）',
  blurSliders.length > 0 && blurSliders.every((item) => Number(item.max) === 100),
  blurSliders.map((item) => item.max).join(','))
check('不透明度滑块上限仍是 1', glassTab.sliders.filter((item) => item.name === '不透明度').every((item) => Number(item.max) === 1))

const miscTab = await readTab('其他')
console.log(`\n其他页卡片：${JSON.stringify(miscTab.cardTitles)}`)
check('其他页不再有「性能」卡片，也没有「画质档位」',
  !miscTab.cardTitles.includes('性能') && !miscTab.text.includes('画质档位'),
  miscTab.cardTitles.join(' / '))
check('其他页仍保留维护与自检',
  miscTab.cardTitles.includes('维护') && miscTab.cardTitles.includes('分区命中自检'),
  miscTab.cardTitles.join(' / '))

/* ── 收尾 ───────────────────────────────────────────────────────── */

socket.close()
child.kill()
await sleep(400)
await fs.promises.rm(profileDir, { recursive: true, force: true }).catch(() => {})
console.log(process.exitCode === 1 ? '\nGLASS PARAMS PROBE FAILED' : '\nGLASS PARAMS PROBE OK')
