/**
 * 未声明赋值扫描。
 *
 * 为什么需要它：这类错误**语法检查抓不到**（`x = 1` 在没有 x 时是合法语法），
 * 而且两侧都有 try/catch 包裹，抛出的 ReferenceError 会变成一句 500，
 * 真正的错因被吃掉。开发过程中已经踩过两次：
 *   - lib/client.js 里 `applyWallpaper = (value) => …` 漏了 `const`；
 *   - lib/index.js 里代理路由漏了 `let buffer` 的声明。
 * 这个脚本把「缩进 ≥2 空格、但对文件内任何声明都不可见的裸赋值」报出来。
 *
 * 用法：node tools/check-undeclared.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** 允许的全局名（Node/browser 内建 + 模块包装变量）。 */
const ALLOWED = new Set([
  'module', 'exports', 'window', 'document', 'globalThis', 'process', 'console',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'fetch', 'URL',
  'AbortSignal', 'Image', 'MutationObserver', 'localStorage', 'React',
])

/**
 * 收集一个文件里所有「已声明」的标识符。
 * 覆盖 const/let/var/function/class、解构、函数参数、catch 参数、import。
 * @param text - 源码。
 * @returns 标识符集合。
 */
function collectDeclared(text) {
  const names = new Set(ALLOWED)
  const add = (name) => {
    const trimmed = String(name).trim().replace(/^\.\.\./, '')
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(trimmed)) names.add(trimmed)
  }
  for (const match of text.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) add(match[1])
  for (const match of text.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) add(part.split(':').pop())
  }
  for (const match of text.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]/g)) {
    for (const part of match[1].split(',')) add(part)
  }
  for (const match of text.matchAll(/(?:function\s*[A-Za-z0-9_$]*\s*|\)\s*=>|\(|,)\s*\(([^)]*)\)\s*(?:=>|\{)/g)) {
    for (const part of match[1].split(',')) add(part.split('=')[0])
  }
  for (const match of text.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*=>/g)) add(match[1])
  for (const match of text.matchAll(/catch\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)/g)) add(match[1])
  for (const match of text.matchAll(/import\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) add(match[1])
  for (const match of text.matchAll(/import\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) add(part.split(/\s+as\s+/).pop())
  }
  return names
}

let failed = false
for (const file of ['lib/index.js', 'lib/client.js']) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const declared = collectDeclared(text)
  const suspects = []
  text.split('\n').forEach((line, index) => {
    const match = /^\s{2,}([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?![=>])/.exec(line)
    if (match === null) return
    const name = match[1]
    if (declared.has(name)) return
    if (/^\s*[A-Za-z_$][A-Za-z0-9_$]*\s*==/.test(line)) return
    suspects.push({ name, line: index + 1, text: line.trim() })
  })
  if (suspects.length === 0) {
    console.log(`[PASS] ${file} 未发现未声明赋值`)
  } else {
    failed = true
    for (const item of suspects) {
      console.log(`[FAIL] ${file}:${item.line} 疑似未声明赋值 "${item.name}" — ${item.text}`)
    }
  }
}

console.log(failed ? '\nUNDECLARED CHECK FAILED' : '\nUNDECLARED CHECK OK')
if (failed) process.exitCode = 1
