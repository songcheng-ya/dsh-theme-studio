/**
 * 一次性诊断：DSH 输入框到底怎么把消息发出去。
 *
 * 目的：`probe-diag-report.mjs` 要真的发一条消息来证明「气泡」选择器没写错，
 * 但 `KeyboardEvent` 派发不生效 —— 得先搞清楚编辑器的类型（是否 contenteditable）
 * 与发送控件（按钮 / 快捷键）。
 *
 * 用法：node tools/scout-composer.mjs <token> <port>
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const token = process.argv[2]
const port = process.argv[3] ?? '3087'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const CDP_PORT = 9248
const profileDir = path.join(os.tmpdir(), `dsh-scout-composer-${process.pid}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ORIGIN = `http://127.0.0.1:${port}`

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
await sleep(4500)

const shape = await evaluate(`(() => {
  const card = document.querySelector('.uV2eYG_card')
  if (card === null) return { card: false }
  const walk = (el, depth) => {
    if (depth > 3) return []
    return [...el.children].flatMap((child) => [
      {
        d: depth,
        tag: child.tagName.toLowerCase(),
        cls: String(child.className || '').split(/\\s+/).slice(0, 3).join('.'),
        ce: child.getAttribute('contenteditable'),
        role: child.getAttribute('role'),
        type: child.getAttribute('type'),
        aria: child.getAttribute('aria-label'),
        disabled: child.disabled ?? null,
        text: (child.textContent || '').trim().slice(0, 14),
      },
      ...walk(child, depth + 1),
    ])
  }
  return {
    card: true,
    tree: walk(card, 0),
    editables: [...document.querySelectorAll('[contenteditable]')].map((el) => ({
      tag: el.tagName.toLowerCase(), cls: String(el.className || '').split(/\\s+/)[0], ce: el.getAttribute('contenteditable'),
    })),
    textareas: document.querySelectorAll('textarea').length,
  }
})()`)
console.log('可见的 contenteditable：', JSON.stringify(shape.editables))
console.log('textarea 数量：', shape.textareas)
console.log('\n输入卡片内部结构（前 3 层）：')
for (const node of shape.tree) {
  console.log(`    ${'  '.repeat(node.d)}${node.tag}.${node.cls}` +
    `${node.ce === null ? '' : ` contenteditable=${node.ce}`}` +
    `${node.role === null ? '' : ` role=${node.role}`}` +
    `${node.type === null ? '' : ` type=${node.type}`}` +
    `${node.aria === null ? '' : ` aria-label=${node.aria}`}` +
    `${node.disabled === null ? '' : ` disabled=${node.disabled}`}` +
    `${node.text === '' ? '' : ` "${node.text}"`}`)
}

/* 聚焦编辑器 → CDP 真实输入 → 回车（真实按键事件，不是派发的 KeyboardEvent） */
const editable = await evaluate(`(() => {
  const el = document.querySelector('.uV2eYG_card [contenteditable=true]') ?? document.querySelector('[contenteditable=true]')
  if (el === null) return null
  el.focus()
  const box = el.getBoundingClientRect()
  return { x: Math.round(box.x + 20), y: Math.round(box.y + Math.round(box.height / 2)), ce: el.getAttribute('contenteditable') }
})()`)
console.log('\n聚焦目标：', JSON.stringify(editable))

if (editable !== null) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: editable.x, y: editable.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: editable.x, y: editable.y, button: 'left', clickCount: 1 })
  await sleep(300)
  await send('Input.insertText', { text: '自检探针测试' })
  await sleep(400)
  const typed = await evaluate(`(() => {
    const el = document.querySelector('.uV2eYG_card [contenteditable=true]')
    return { text: el?.textContent ?? '', stats: document.querySelector('[data-composer-stats]')?.textContent ?? '' }
  })()`)
  console.log('输入后编辑器内容：', JSON.stringify(typed))

  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter' })
  await send('Input.dispatchKeyEvent', { type: 'char', text: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter' })
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    if ((await evaluate(`document.querySelectorAll('.Sixlwa_bubble').length`)) > 0) break
  }
  const after = await evaluate(`(() => ({
    bubbles: [...document.querySelectorAll('.Sixlwa_bubble')].map((el) => el.textContent.trim().slice(0, 24)),
    editor: document.querySelector('.uV2eYG_card [contenteditable=true]')?.textContent ?? '',
    rows: document.querySelectorAll('.Sixlwa_userRow').length,
  }))()`)
  console.log('回车后：', JSON.stringify(after))
}

socket.close()
child.kill()
await sleep(300)
await fs.promises.rm(profileDir, { recursive: true, force: true }).catch(() => {})
