/**
 * dsh-theme-studio —— 宿主（Node）半侧。
 *
 * 职责边界：
 *   - 只提供「宿主才做得到」的能力：读本地磁盘目录、落盘配置、代理远程图片、
 *     接收浏览器上传的图片；
 *   - 不参与任何界面渲染，界面完全在浏览器半侧（lib/client.js）；
 *   - 所有响应都在 /theme-studio 前缀下，同源 fetch 调用，不需要经过 RPC 编码。
 *
 * 安全边界：
 *   - 只服务「用户自己在配置里登记过的目录」里的图片文件；
 *   - 路径一律先 realpath 再校验是否落在某个已登记根目录内，防 ../ 逃逸；
 *   - 图片大小与上传体积都有上限，避免误点巨大文件把宿主读爆。
 *
 * @module dsh-theme-studio/host
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const name = 'dsh-theme-studio'
export const inject = ['webServer']

/** 导出默认配置与迁移函数：给契约测试与外部工具复用，避免两处手抄同一份形状。 */
export { defaultConfig, migrateConfig, dropRetiredKeys, hasRetiredKeys, mergeConfig, CONFIG_VERSION }

/** 路由前缀：客户端所有 fetch 都打在这里。 */
const ROUTE_PREFIX = '/theme-studio'

/** DSH 主目录：配置与上传图片都放这里（node_modules 可能只读）。 */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA_DIR = path.join(DSH_HOME, 'theme-studio')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const UPLOAD_DIR = path.join(DATA_DIR, 'wallpapers')
/**
 * 远程壁纸的本地缓存目录。
 *
 * 存在的意义有两个：一是远程图不用每次刷新都重新下载，二是「删除候选」对 URL
 * 来源要有一个**可以真正删掉的本地副本** —— 删除它只会让下次访问重新下载，
 * 原图仍在对方服务器上，不会影响任何人的文件。
 */
const URL_CACHE_DIR = path.join(DATA_DIR, 'url-cache')

/** 允许作为壁纸的扩展名。 */
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'])

/**
 * 单个图片文件大小上限（字节）。
 *
 * 是 256 MB 而不是更小：一张 upscale 过的 4K/8K 壁纸轻松上到 100 MB 以上，
 * 而这张图是直接交给浏览器当 CSS 背景用的，不进 base64、不进内存副本，
 * 代价只是宿主读盘一次。超过上限的图片会连同体积一起被标出来，
 * 让面板能明确告诉用户「为什么这张用不了」，而不是静默失败。
 */
const MAX_IMAGE_BYTES = 256 * 1024 * 1024
/** 单次上传体积上限（字节）。 */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024
/** 扫目录时的兜底上限。 */
const MAX_SCAN_FILES = 3000
const MAX_SCAN_DEPTH = 6

/* ────────────────────────────── 配置 ────────────────────────────── */

/**
 * 深合并：只接受 plain object，数组与标量直接覆盖。
 * 用途是让「旧配置 + 新默认值」在插件升级后仍然完整。
 * @param base - 默认值。
 * @param patch - 用户已存的值。
 * @returns 合并结果（新对象）。
 */
function deepMerge(base, patch) {
  if (patch === undefined || patch === null) return base
  if (Array.isArray(base) || Array.isArray(patch)) return patch
  if (typeof base !== 'object' || typeof patch !== 'object') return patch
  const out = { ...base }
  for (const key of Object.keys(base)) {
    if (key in patch) out[key] = deepMerge(base[key], patch[key])
  }
  for (const key of Object.keys(patch)) {
    if (!(key in out)) out[key] = patch[key]
  }
  return out
}

/**
 * 配置默认值。这里的键名就是客户端使用的键名，两端必须保持一致。
 * @returns 一份全新的默认配置。
 */
function defaultConfig() {
  return {
    /**
     * 配置版本。**出厂默认是「不修改壁纸、不改动界面」**：壁纸以原始状态铺满，
     * 六个分区完全不透明，所有效果参数交给用户自己调。
     * 这个版本号只用于一次性迁移：老版本把模糊与半透明写进了默认值，
     * 升级时必须主动重置，否则旧配置会把默认值重新带回来（深合并不会删键）。
     */
    version: 2,
    /** 总开关。 */
    enabled: true,
    /** 渲染层作用域：root = 全局，html = 只作用于文档根（调试用）。 */
    scope: 'root',
    /** 主题色（accent）配置。 */
    accent: {
      enabled: false,
      rgb: [65, 118, 230],
      preset: 'deepseek',
    },
    /** 背景图配置。所有「会改变壁纸观感」的项默认都是中立值。 */
    wallpaper: {
      /** 'none' | 'folder' | 'url' | 'upload' */
      source: 'none',
      /** 已登记的本地文件夹（绝对路径）。 */
      folders: [],
      /** 是否递归扫描子目录。 */
      recursive: true,
      /** 已登记的远程图片链接。 */
      urls: [],
      /**
       * ⚠️ 原 `hidden`（「已移除候选」名单）在 **0.2.0 整体删除**，见
       * `RETIRED_WALLPAPER_KEYS` —— 用户明确不要「恢复已移除」这个功能，
       * 而名单没有出口就会变成静默黑洞（图在磁盘上、路径在名单里、界面永远看不到）。
       * 面板上的 ✕ 现在只作用于当前会话的候选墙（前端 state，不落盘）。
       */
      /** 当前选中的壁纸：文件夹来源下是绝对路径，其余是 URL 或 /theme-studio/... 路径。 */
      current: '',
      /** '' = 每次随机；否则固定使用该候选。 */
      fixed: '',
      /** 适配方式：cover | contain | repeat | center。 */
      fit: 'cover',
      /** 壁纸对齐：center | top | bottom | left | right。 */
      position: 'center',
      /** 对壁纸本身的高斯模糊（px），营造景深。默认 0 = 不动壁纸。 */
      blur: 0,
      /** 整体亮度 0.2–2。默认 1 = 原样。 */
      brightness: 1,
      /** 整体饱和度 0–2。默认 1 = 原样。 */
      saturation: 1,
      /** 遮罩暗化 0–0.9：保证正文对比度。默认 0 = 不加遮罩。 */
      dim: 0,
      /** 暗角强度 0–1。默认 0 = 不加暗角。 */
      vignette: 0,
      /** 噪点强度 0–0.2。默认 0 = 不加噪点。 */
      noise: 0,
      /** 切换频率：'session'（每次会话）| 'daily' | 'manual'。 */
      rotate: 'session',
    },
    /**
     * 分区毛玻璃参数。出厂全部中立：**opacity = 1（完全不透明）**、**blur = 0**。
     * 用户把某个分区的「不透明度」往左拉才会开始透出壁纸，再把「模糊」拉起来才是磨砂。
     * 这样「刚装上壁纸」时不会有任何意料之外的效果。
     *
     * 每个分区只有三个字段：`enabled` / `opacity` / `blur`。
     * `saturation` 已于 0.1.11 移除（用户要求去掉这个参数），老配置里的残键由
     * dropRetiredKeys() 在读写两条路径上剔除。
     *
     * ⚠️ 四个分区已整体删除，这里故意没有它们的键：
     *   - `sidebar`（0.1.9）：两种层级方案都出现「模糊断层」，先删掉再重做；
     *   - `topbar`（0.1.12）：用户要求「模糊等代码全部删除」；
     *   - `chat`（0.1.13）：用户要求「删除对话区这个位置的效果和设置对应的选项」；
     *   - `panel`（0.1.14）：用户要求「删除掉设置界面可以调的透明和模糊效果」。
     * 旧配置里的残键同样由 dropRetiredKeys() 清掉（见 RETIRED_REGIONS）。
     *
     * ✅ `sidebar` 与 `topbar` 已在 0.1.15 合并重写为新分区 `bars`（设置页里叫「边栏」）。
     * 它是**全新的键**，所以旧键 `sidebar` / `topbar` 仍然留在 RETIRED_REGIONS 里 ——
     * 不能因为「侧边栏和顶边栏回来了」就把旧键放出来，否则老配置里那两份参数会复活。
     */
    glass: {
      bars: { enabled: true, opacity: 1, blur: 0 },
      input: { enabled: true, opacity: 1, blur: 0 },
      bubble: { enabled: true, opacity: 1, blur: 0 },
      menu: { enabled: true, opacity: 1, blur: 0 },
      /** 玻璃内描边强度 0–1。 */
      border: 0.6,
      /** 顶部高光强度 0–1。 */
      highlight: 0.5,
    },
  }
}

/** 进程内配置缓存，避免每个请求都读盘。 */
let configCache

/** 当前出厂配置版本；低于它的旧配置需要一次性迁移。 */
const CONFIG_VERSION = defaultConfig().version

/**
 * 一次性迁移：把「出厂带效果」时代的配置改成中立默认值。
 *
 * 为什么不能只靠改默认值：`deepMerge(defaults, raw)` 只在 raw **没有**该键时
 * 才采用默认值，而老配置里 blur/opacity/dim 都是有值的，所以旧值会赢。
 * 因此这里显式重置「壁纸效果参数」与「六个分区的玻璃参数」——
 * 用户真正自己做的选择（主题色、登记的目录、当前壁纸、适配方式）全部保留。
 *
 * @param raw - 磁盘上读到的原始配置（可能是老版本）。
 * @returns 迁移后的配置；无需迁移时原样返回。
 */
function migrateConfig(raw) {
  const version = typeof raw?.version === 'number' ? raw.version : 1
  if (version >= CONFIG_VERSION) return raw
  const fresh = defaultConfig()
  const next = { ...raw, version: CONFIG_VERSION }
  next.wallpaper = {
    ...(raw.wallpaper ?? {}),
    // 只重置「会改变壁纸观感」的项；不动 source/folders/current/fit/position。
    blur: fresh.wallpaper.blur,
    brightness: fresh.wallpaper.brightness,
    saturation: fresh.wallpaper.saturation,
    dim: fresh.wallpaper.dim,
    vignette: fresh.wallpaper.vignette,
    noise: fresh.wallpaper.noise,
  }
  const glass = { ...(raw.glass ?? {}) }
  // 「设置界面」分区的模糊顺带驱动遮罩，所以它也要一起归零。
  for (const key of ['bars', 'input', 'bubble', 'menu']) {
    glass[key] = { ...(glass[key] ?? {}), opacity: 1, blur: 0 }
  }
  next.glass = glass
  return dropRetiredKeys(next)
}

/**
 * 已经废弃的分区名：整个分区不再存在。旧配置里的残键会被删掉。
 *
 * - `sidebar`（0.1.9 移除）：两种层级方案都出现「模糊断层」，用户要求先彻底删掉再重做。
 * - `topbar`（0.1.12 移除）：用户要求「模糊等代码全部删除」。
 * - `chat`（0.1.13 移除）：用户要求「删除对话区这个位置的效果和设置对应的选项」。
 *   它的选择器是中心列容器，而顶边栏在中心列内部，所以它顺带会把顶边栏一起糊掉。
 * - `panel`（0.1.14 移除）：用户要求「删除掉设置界面可以调的透明和模糊效果」。
 *
 * ⚠️ 重做某个分区时，必须同时把它从这里删掉，否则新写入的配置会被立刻清掉。
 * **例外**：0.1.15 重写的「边栏」用的是全新键 `bars`，而不是复活 `sidebar`/`topbar`，
 * 所以那两个旧键留在这里是对的 —— 老配置里那两份旧参数应当继续被清掉。
 * @type {readonly string[]}
 */
const RETIRED_REGIONS = ['sidebar', 'topbar', 'chat', 'panel']

/**
 * 已经废弃的分区参数：分区还在，但这个参数不再有任何代码读它
 * （0.1.11 移除每个分区的 `saturation`）。
 * @type {readonly string[]}
 */
const RETIRED_REGION_KEYS = ['saturation']

/**
 * 已经废弃的顶层键：0.1.11 移除「画质档位 `perf`」，
 * 模糊半径上限改为插件内固定常量（100px）。
 * @type {readonly string[]}
 */
const RETIRED_TOP_LEVEL = ['perf']

/**
 * 已经废弃的**壁纸**键：0.2.0 移除 `hidden`（「已移除候选」名单）。
 *
 * 用户明确不要「恢复已移除候选图」这个功能。而名单一旦没有恢复入口就是**静默黑洞**：
 * 图片明明还在磁盘上、路径也还在配置里，界面上却永远看不到它 —— 连重新扫描、
 * 甚至把文件重新放回原目录都救不回来（路径命中名单）。所以整套机制拆掉，
 * 键也一并退役：读盘时物理删除，被它挡住过的图**重新出现在候选墙**（已确认要恢复）。
 * @type {readonly string[]}
 */
const RETIRED_WALLPAPER_KEYS = ['hidden']

/**
 * 判断一份原始配置里是否残留了任何已废弃的键。
 *
 * 与 dropRetiredKeys 配对使用：readConfig() 靠它决定「清理结果要不要立刻落盘」。
 * 不能只判断某一个键 —— 每次新增废弃键都要同步改两处，所以这里抽成函数。
 *
 * @param config - 磁盘上读到的原始配置。
 * @returns 是否存在残留键。
 */
function hasRetiredKeys(config) {
  if (config === null || typeof config !== 'object') return false
  if (RETIRED_TOP_LEVEL.some((key) => key in config)) return true
  const wallpaper = config.wallpaper
  if (wallpaper !== null && typeof wallpaper === 'object' && RETIRED_WALLPAPER_KEYS.some((key) => key in wallpaper)) {
    return true
  }
  const glass = config.glass
  if (glass === null || typeof glass !== 'object') return false
  if (RETIRED_REGIONS.some((key) => key in glass)) return true
  return Object.values(glass).some(
    (value) =>
      value !== null &&
      typeof value === 'object' &&
      RETIRED_REGION_KEYS.some((key) => key in value),
  )
}

/**
 * 剔除已经废弃、不再有人读的配置键。
 *
 * 为什么需要它：深合并**只会新增键、不会删键**。老配置里的 `glass.sidebar`
 * （0.1.9 移除的侧栏分区）、`glass.*.saturation` / `perf`（0.1.11 移除的两个参数）、
 * `wallpaper.hidden`（0.2.0 移除的候选名单）会一直留着 —— 既没有代码读，
 * 又会让打开配置文件的人误以为「这些设置还在，只是界面没显示」。
 * 所以每次读盘都清一遍。
 *
 * 为什么不只放在 migrateConfig 里：迁移只在版本号落后时跑一次，而这两次删键**都没有**
 * 提升版本号，已经迁到当前版本的配置不会再走迁移分支。因此 migrateConfig 与
 * readConfig 都会调用本函数，两处都调用也不会互相干扰（删一个不存在的键是空操作）。
 *
 * @param config - 配置对象（原地修改）。
 * @returns 同一个对象，便于链式返回。
 */
function dropRetiredKeys(config) {
  if (config === null || typeof config !== 'object') return config
  for (const key of RETIRED_TOP_LEVEL) delete config[key]
  const wallpaper = config.wallpaper
  if (wallpaper !== null && typeof wallpaper === 'object') {
    for (const key of RETIRED_WALLPAPER_KEYS) delete wallpaper[key]
  }
  const glass = config.glass
  if (glass === null || typeof glass !== 'object') return config
  for (const key of RETIRED_REGIONS) delete glass[key]
  // border / highlight 是数字，会被 typeof 判断直接跳过。
  for (const value of Object.values(glass)) {
    if (value === null || typeof value !== 'object') continue
    for (const key of RETIRED_REGION_KEYS) delete value[key]
  }
  return config
}

/**
 * 读取配置（带进程内缓存）。首次读到旧版本配置时会迁移并立刻落盘，
 * 这样「升级后重启」就是一次性的，不会每次读盘都重来。
 * @returns 合并了默认值的配置对象。
 */
function readConfig() {
  if (configCache !== undefined) return configCache
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    raw = {}
  }
  const migrated = migrateConfig(raw)
  // 深合并只在 raw 缺少某个键时才采用默认值，所以「已废弃的键」必须显式剔除。
  const hadRetired = hasRetiredKeys(raw)
  configCache = dropRetiredKeys(deepMerge(defaultConfig(), migrated))
  if (migrated !== raw || hadRetired) {
    // 迁移 / 清理结果落盘；失败不致命，只是下次启动再处理一次。
    void writeConfig({}).catch(() => {})
  }
  return configCache
}

/**
 * 把一份局部配置合并进当前配置，并顺手剔除废弃键。
 *
 * ⚠️ 这里必须过一遍 dropRetiredKeys —— 这是一个真实踩过的坑：
 * `deepMerge` **只增键不删键**，所以只要有一次 PUT 里带了已废弃的键
 * （老客户端、旧标签页、工具脚本都可能带），它就会进入 `configCache` 并落盘，
 * 之后每次读盘都从缓存返回，`readConfig()` 里的那一次清理再也碰不到它 ——
 * 表现为「配置文件里的 `saturation` / `perf` 删不掉，重启进程才好」。
 * 读、写两条路径都清理，不变式才是真的成立：**缓存里永远没有废弃键**。
 *
 * @param base - 当前配置。
 * @param patch - 局部配置。
 * @returns 合并并清理后的新对象。
 */
function mergeConfig(base, patch) {
  return dropRetiredKeys(deepMerge(base, patch ?? {}))
}

/**
 * 原子写入配置。先写临时文件再 rename，避免半截 JSON。
 * @param patch - 需要合并进去的部分配置。
 * @returns 写入后的完整配置。
 */
async function writeConfig(patch) {
  const merged = mergeConfig(readConfig(), patch)
  await fsp.mkdir(DATA_DIR, { recursive: true })
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`
  await fsp.writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  await fsp.rename(tmp, CONFIG_FILE)
  configCache = merged
  return merged
}

/* ────────────────────────────── 路径与图片 ────────────────────────────── */

/**
 * 把用户输入的路径规范化：展开 ~、去掉包裹引号、转绝对路径。
 * @param input - 用户输入。
 * @returns 规范化后的绝对路径。
 */
function normalizeUserPath(input) {
  let value = String(input ?? '').trim()
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1)
  }
  if (value === '~') value = os.homedir()
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(os.homedir(), value.slice(2))
  return path.resolve(value)
}

/**
 * 判断 child 是否等于 parent 或位于 parent 之内（大小写不敏感，适配 Windows）。
 * @param child - 待检查路径。
 * @param parent - 根路径。
 * @returns 是否在根内。
 */
function isInside(child, parent) {
  const a = path.resolve(child).toLowerCase()
  const b = path.resolve(parent).toLowerCase()
  if (a === b) return true
  return a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)
}

/**
 * 校验一个绝对路径是否指向「已登记目录内的可读图片文件」。
 *
 * 返回结构化原因而不是单个 null：静默失败会让人以为插件坏了，而实际上
 * 只是「图片太大」或「目录没登记」。面板据此给出可操作的提示。
 *
 * @param target - 候选绝对路径。
 * @param roots - 已登记的根目录列表。
 * @returns `{ ok: true, real }` 或 `{ ok: false, reason, size? }`。
 */
async function resolveAllowedImage(target, roots) {
  let real
  try {
    real = await fsp.realpath(target)
  } catch {
    return { ok: false, reason: '文件不存在或不可读' }
  }
  if (!IMAGE_EXT.has(path.extname(real).toLowerCase())) {
    return { ok: false, reason: '不是受支持的图片格式' }
  }
  let inside = false
  for (const root of roots) {
    let realRoot
    try {
      realRoot = await fsp.realpath(root)
    } catch {
      continue
    }
    if (isInside(real, realRoot)) {
      inside = true
      break
    }
  }
  if (!inside) return { ok: false, reason: '该文件不在已登记的壁纸目录内' }
  let stat
  try {
    stat = await fsp.stat(real)
  } catch {
    return { ok: false, reason: '文件无法读取' }
  }
  if (!stat.isFile()) return { ok: false, reason: '不是普通文件' }
  if (stat.size > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      reason: `图片 ${(stat.size / 1024 / 1024).toFixed(1)} MB，超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB 上限`,
      size: stat.size,
      tooLarge: true,
    }
  }
  return { ok: true, real }
}

/**
 * 递归收集一个目录下的图片文件。
 * @param root - 根目录绝对路径。
 * @param recursive - 是否进入子目录。
 * @returns 图片条目数组（不含目录项）。
 */
async function scanFolder(root, recursive) {
  /** @type {{path:string,name:string,dir:string,size:number,mtime:number}[]} */
  const found = []
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length > 0 && found.length < MAX_SCAN_FILES) {
    const { dir, depth } = queue.shift()
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (found.length >= MAX_SCAN_FILES) break
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (recursive && depth < MAX_SCAN_DEPTH) queue.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      if (!IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) continue
      try {
        const stat = await fsp.stat(full)
        found.push({
          path: full,
          name: entry.name,
          dir,
          size: stat.size,
          mtime: Math.round(stat.mtimeMs),
        })
      } catch {
        /* 单文件失败不影响整目录 */
      }
    }
  }
  return found
}

/** 扩展名 → Content-Type。 */
const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}

/**
 * 依据扩展名给出 Content-Type。
 * @param file - 文件路径。
 * @returns MIME 字符串。
 */
function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/* ────────────────────────────── HTTP 小工具 ────────────────────────────── */

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

/**
 * 发送 JSON 响应。
 * @param res - http 响应对象。
 * @param status - 状态码。
 * @param payload - 任意可序列化对象。
 */
function sendJson(res, status, payload) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch (error) {
    body = JSON.stringify({ ok: false, error: `serialize failed: ${String(error?.message ?? error)}` })
    status = 500
  }
  res.writeHead(status, JSON_HEADERS)
  res.end(body)
}

/**
 * 读取请求体（带上限）。
 * @param req - http 请求对象。
 * @param limit - 字节上限。
 * @returns Buffer。
 */function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`body exceeds ${limit} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * 读取并解析 JSON 请求体。
 * @param req - http 请求对象。
 * @returns 解析后的对象（空体返回 {}）。
 */
async function readJson(req) {
  const buf = await readBody(req, 1024 * 1024)
  if (buf.length === 0) return {}
  return JSON.parse(buf.toString('utf8'))
}

/**
 * 安全读取并解码一个查询参数。
 *
 * 关键点：`new URL().searchParams.get()` **不做百分号解码**（WHATWG 的
 * urlencoded 解析器只把 `+` 当空格，`%3A` 原样保留）。浏览器发出的
 * `?path=C%3A%5CUsers%5C...` 若直接拿去当文件路径，就会变成一个不存在的路径，
 * 被下面的安全校验拒成 403 —— 表现是「带空格或中文的壁纸路径加载失败」。
 * 这里显式 decodeURIComponent，并对畸形编码退化为原值。
 *
 * @param req - http 请求对象。
 * @param key - 参数名。
 * @returns 解码后的参数值，缺省为空串。
 */
function queryParam(req, key) {
  const raw = new URL(String(req.url ?? ''), 'http://localhost').searchParams.get(key) ?? ''
  if (raw.length === 0) return ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/* ──────────────────────── 远程壁纸的本地缓存 ──────────────────────── */

/** Content-Type → 缓存文件扩展名。 */
const TYPE_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
}

/**
 * Content-Type → 扩展名。
 * @param type - 上游返回的 Content-Type。
 * @returns 扩展名，未知时退回 .img。
 */
function extensionForType(type) {
  const key = String(type).split(';')[0].trim().toLowerCase()
  return TYPE_EXT[key] ?? '.img'
}

/**
 * 一个 URL 对应的缓存文件基名（不含扩展名）。
 * 用 sha1 而不是把 URL 写进文件名：URL 里有 `:` `/` `?` 等非法字符，
 * 且长度不可控。meta 文件里保存了原始 URL 以便说明来源。
 * @param url - 原始图片地址。
 * @returns 缓存文件绝对路径（不含扩展名）。
 */
function cacheFileFor(url) {
  const hash = crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 32)
  return path.join(URL_CACHE_DIR, hash)
}

/**
 * 读取缓存元数据。
 * @param base - cacheFileFor 的返回值。
 * @returns `{ ext, type }`，未缓存时为 null。
 */
async function readCacheMeta(base) {
  try {
    const meta = JSON.parse(await fsp.readFile(`${base}.json`, 'utf8'))
    if (typeof meta?.ext === 'string' && typeof meta?.type === 'string') return meta
  } catch {
    /* 没有 meta 就当未缓存 */
  }
  return null
}

/**
 * 删除一个 URL 的本地缓存副本。
 * @param url - 原始图片地址。
 * @returns 实际删掉的文件数。
 */
async function dropCache(url) {
  const base = cacheFileFor(url)
  let removed = 0
  let entries = []
  try {
    entries = await fsp.readdir(URL_CACHE_DIR)
  } catch {
    return 0
  }
  const stem = path.basename(base)
  for (const entry of entries) {
    if (entry !== `${stem}.json` && !entry.startsWith(`${stem}.`)) continue
    try {
      await fsp.rm(path.join(URL_CACHE_DIR, entry), { force: true })
      removed += 1
    } catch {
      /* 单个文件删除失败不影响整体 */
    }
  }
  return removed
}

/* ────────────────────────────── 插件主体 ────────────────────────────── */

/**
 * 插件入口：注册全部宿主路由。
 * @param ctx - cordis 上下文（已注入 webServer）。
 */
export function apply(ctx) {
  /** @type {(() => void)[]} */
  const disposers = []

  /**
   * 注册一条前缀路由。
   * @param sub - 前缀之后的路径，例如 '/api/config'。
   * @param handler - 处理函数。
   */
  const route = (sub, handler) => {
    disposers.push(
      ctx.webServer.register({
        kind: 'prefix',
        path: `${ROUTE_PREFIX}${sub}`,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            if (!res.headersSent) {
              sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            } else {
              try {
                res.end()
              } catch {
                /* 连接可能已断开 */
              }
            }
          }
        },
      }),
    )
  }

  /**
   * 从 URL 里取出前缀之后的部分。
   * @param req - http 请求对象。
   * @returns 例如 '/api/config'。
   */
  const tailOf = (req) => {
    const raw = String(req.url ?? '')
    const q = raw.indexOf('?')
    const pathname = q === -1 ? raw : raw.slice(0, q)
    return pathname.startsWith(ROUTE_PREFIX) ? pathname.slice(ROUTE_PREFIX.length) : pathname
  }

  /**
   * 收集当前配置里所有「允许读取图片」的根目录。
   * @returns 根目录数组。
   */
  const allowedRoots = () => {
    const config = readConfig()
    const roots = [...(config.wallpaper?.folders ?? []), UPLOAD_DIR]
    return roots.filter((item) => typeof item === 'string' && item.length > 0)
  }

  /* ── 健康检查 ── */
  route('/api/ping', (req, res) => {
    sendJson(res, 200, { ok: true, plugin: name, version: '0.1.0', dataDir: DATA_DIR })
  })

  /* ── 配置读写 ── */
  route('/api/config', async (req, res) => {
    if (req.method === 'PUT' || req.method === 'POST') {
      const patch = await readJson(req)
      const next = await writeConfig(patch)
      sendJson(res, 200, { ok: true, config: next })
      return
    }
    sendJson(res, 200, { ok: true, config: readConfig() })
  })

  /* ── 目录浏览：给「选择文件夹」用的服务器端目录列表 ── */
  route('/api/browse', async (req, res) => {
    const input = queryParam(req, 'path')
    const target = input.length > 0 ? normalizeUserPath(input) : os.homedir()
    let entries
    try {
      entries = await fsp.readdir(target, { withFileTypes: true })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: `无法读取目录：${String(error?.message ?? error)}`, path: target, dirs: [] })
      return
    }
    const dirs = []
    const images = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        dirs.push({ name: entry.name, path: path.join(target, entry.name) })
      } else if (entry.isFile() && IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) {
        images.push({ name: entry.name, path: path.join(target, entry.name) })
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    images.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    sendJson(res, 200, {
      ok: true,
      path: target,
      parent: path.dirname(target) === target ? null : path.dirname(target),
      dirs: dirs.slice(0, 500),
      imageCount: images.length,
    })
  })

  /* ── 目录扫描：把登记目录里的图片列成候选墙 ──
   *
   * ⚠️ 这里**没有**「已移除候选」这一层了（0.2.0 删除）。早先有一个
   * `wallpaper.hidden` 名单：移出的图仍然照常扫出来、只是打上 hidden 标记，
   * 面板据此显示「已移除 N 张」并支持一键恢复。用户明确要求去掉「恢复」。
   * 而名单一旦没有出口，就会变成**静默黑洞** —— 图片明明在磁盘上、路径也在名单里，
   * 界面上却永远看不到，也没有任何按钮能撤销。所以整套机制拆掉，连键一起退役。
   *
   * 面板上的 ✕ 现在只作用于**当前这次会话的候选墙**（前端 state），不写任何配置；
   * 想让它回来，刷新页面即可（重新扫盘）。原文件从头到尾没被碰过。
   */
  route('/api/folders', async (req, res) => {
    const config = readConfig()
    const folders = (config.wallpaper?.folders ?? []).filter((item) => typeof item === 'string' && item.length > 0)
    const recursive = config.wallpaper?.recursive !== false
    const groups = []
    for (const folder of folders) {
      let exists = true
      try {
        const stat = await fsp.stat(folder)
        exists = stat.isDirectory()
      } catch {
        exists = false
      }
      const items = exists ? await scanFolder(folder, recursive) : []
      groups.push({ folder, exists, count: items.length, items })
    }
    const uploadScan = await scanFolder(UPLOAD_DIR, false)
    if (uploadScan.length > 0) {
      groups.push({ folder: UPLOAD_DIR, exists: true, count: uploadScan.length, items: uploadScan, uploads: true })
    }
    sendJson(res, 200, { ok: true, groups })
  })

  /* ── 图片回吐：本地文件 → 浏览器 ── */
  route('/api/image', async (req, res) => {
    const target = queryParam(req, 'path')
    if (target.length === 0) {
      sendJson(res, 400, { ok: false, error: 'missing path' })
      return
    }
    const resolved = await resolveAllowedImage(normalizeUserPath(target), allowedRoots())
    if (resolved.ok !== true) {
      // 413 专门给「太大」：面板据此提示缩小图片，而不是让人以为路径写错了。
      sendJson(res, resolved.tooLarge === true ? 413 : 403, {
        ok: false,
        error: resolved.reason,
        path: target,
        size: resolved.size,
      })
      return
    }
    const real = resolved.real
    let bytes
    try {
      bytes = await fsp.readFile(real)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      return
    }
    const etag = `"${crypto.createHash('sha1').update(String(bytes.length)).update(real).digest('hex').slice(0, 16)}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, max-age=60' })
      res.end()
      return
    }
    res.writeHead(200, {
      'Content-Type': mimeFor(real),
      'Content-Length': String(bytes.length),
      'Cache-Control': 'private, max-age=60',
      ETag: etag,
    })
    res.end(bytes)
  })

  /* ── 远程图片代理：绕开 CORS，带本地缓存 ──
   *
   * 缓存落地是刻意的：这样「删除候选」对 URL 来源才有东西可删。
   * 缓存只是副本，删掉只会让下次访问重新下载，原图仍留在对方服务器上。
   * ─────────────────────────────────────────────────────────────── */
  route('/api/proxy', async (req, res) => {
    const target = queryParam(req, 'url')
    if (!/^https?:\/\//i.test(target)) {
      sendJson(res, 400, { ok: false, error: 'only http(s) urls are proxied' })
      return
    }

    // 命中缓存时装载，未命中留 null 交给下面的回源分支。
    let buffer = null
    let type = ''

    // 1) 命中本地缓存：直接回吐，不碰网络。
    //    注意文件名必须带上 meta 里记的扩展名 —— 缓存体是 `<hash><ext>`，
    //    只读 `<hash>` 会永远 ENOENT，于是每次请求都回源（缓存形同虚设）。
    const base = cacheFileFor(target)
    const meta = await readCacheMeta(base)
    if (meta !== null) {
      try {
        buffer = await fsp.readFile(`${base}${meta.ext}`)
        type = meta.type
      } catch {
        buffer = null
      }
    }

    // 2) 未命中：拉取远端并落盘
    if (buffer === null) {
      let upstream
      try {
        upstream = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(20000) })
      } catch (error) {
        sendJson(res, 502, { ok: false, error: `拉取失败：${String(error?.message ?? error)}` })
        return
      }
      if (!upstream.ok) {
        sendJson(res, 502, { ok: false, error: `上游返回 ${upstream.status}` })
        return
      }
      const upstreamType = upstream.headers.get('content-type') ?? ''
      if (!upstreamType.startsWith('image/')) {
        sendJson(res, 415, { ok: false, error: `不是图片（${upstreamType || 'unknown'}）` })
        return
      }
      const declared = Number(upstream.headers.get('content-length') ?? '0')
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
        sendJson(res, 413, { ok: false, error: '图片过大' })
        return
      }
      buffer = Buffer.from(await upstream.arrayBuffer())
      if (buffer.length > MAX_IMAGE_BYTES) {
        sendJson(res, 413, { ok: false, error: '图片过大' })
        return
      }
      type = upstreamType
      const ext = extensionForType(upstreamType)
      await fsp.mkdir(URL_CACHE_DIR, { recursive: true }).catch(() => {})
      await fsp.writeFile(`${base}${ext}`, buffer).catch(() => {})
      await fsp
        .writeFile(`${base}.json`, JSON.stringify({ url: target, type: upstreamType, ext, bytes: buffer.length }), 'utf8')
        .catch(() => {})
    }

    const etag = `"${crypto.createHash('sha1').update(target).update(String(buffer.length)).digest('hex').slice(0, 16)}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, max-age=300' })
      res.end()
      return
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': String(buffer.length),
      'Cache-Control': 'private, max-age=300',
      ETag: etag,
    })
    res.end(buffer)
  })

  /* ── 删除远程壁纸的本地缓存 + 从候选列表移除 ──
   *
   * 两个动作一起做，对应面板上「删除缓存与候选」这个按钮：
   *   1. 删掉 url-cache 里的本地副本（下次访问会重新下载）；
   *   2. 把该 URL 从 wallpaper.urls 里去掉。
   * **不触碰任何原始文件** —— 远端原图不动。
   * ─────────────────────────────────────────────────────────────── */
  route('/api/forget-url', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'use POST' })
      return
    }
    let payload
    try {
      payload = await readJson(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${String(error?.message ?? error)}` })
      return
    }
    const target = String(payload?.url ?? '').trim()
    if (target.length === 0) {
      sendJson(res, 400, { ok: false, error: 'missing url' })
      return
    }
    const removed = await dropCache(target)
    const config = await writeConfig({
      wallpaper: { urls: (readConfig().wallpaper?.urls ?? []).filter((item) => item !== target) },
    })
    sendJson(res, 200, { ok: true, removedCacheFiles: removed, urls: config.wallpaper.urls })
  })

  /* ── 删除「上传」来源的本地副本（真删）──
   *
   * 上传的图是插件自己复制到 `wallpapers/` 的副本（用户的原始图片在他自己选的位置，
   * 这里从来只是副本），所以删它是**真删**：文件从磁盘上消失。
   *
   * 这个端点同时承担「归属判定」：**它才是权威**。客户端不复制 `UPLOAD_DIR` 的布局知识，
   * 只问「这是不是插件自己产生的副本」，所以：
   *   - 不在上传目录里 → **403 + removed:false**，调用方据此降级为「只从候选墙移除」
   *     （那是用户登记目录里的原图，本插件绝不删）；
   *   - 在上传目录里 → 删除并回 `removed:true`。
   * 只允许删 UPLOAD_DIR 的**直接子级**普通文件：`isInside` 挡 `..` 逃逸，
   * dirname 必须恰好是 UPLOAD_DIR，且必须是图片扩展名。
   * ─────────────────────────────────────────────────────────────── */
  route('/api/delete-upload', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'use POST' })
      return
    }
    let payload
    try {
      payload = await readJson(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${String(error?.message ?? error)}` })
      return
    }
    const target = String(payload?.path ?? '').trim()
    if (target.length === 0) {
      sendJson(res, 400, { ok: false, error: 'missing path' })
      return
    }
    const normalized = normalizeUserPath(target)
    const uploadRoot = path.resolve(UPLOAD_DIR)
    /* 403 在这里是**正常分支**（「不是插件的副本」），不是故障 —— 客户端靠它降级。
     * removed:false 让这个语义在响应体里也显式可见，不依赖调用方去读状态码。 */
    if (!isInside(normalized, uploadRoot) || path.dirname(normalized).toLowerCase() !== uploadRoot.toLowerCase()) {
      sendJson(res, 403, { ok: false, removed: false, error: '不在上传目录内', path: normalized })
      return
    }
    if (!IMAGE_EXT.has(path.extname(normalized).toLowerCase())) {
      sendJson(res, 403, { ok: false, removed: false, error: '不是图片文件', path: normalized })
      return
    }
    try {
      await fsp.rm(normalized, { force: true })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      return
    }
    // 删掉的正好是当前壁纸时，把配置里那个悬空路径一起清掉，避免指向不存在的文件。
    const config = readConfig()
    const fixed = config.wallpaper?.fixed ?? ''
    if (fixed === target || fixed === normalized) {
      await writeConfig({ wallpaper: { fixed: '', current: '' } })
    }
    sendJson(res, 200, { ok: true, removed: true, removedFiles: 1, path: normalized })
  })

  /* ── 重置配置：把插件造成的所有效果退回出厂 ──
   *
   * 与设置页那个「一键关闭并复原」的区别（用户明确要的是**前者**）：
   *   · 关闭：只把 `enabled` 置 false —— 效果撤了，但配置原样保留，再打开就全回来；
   *   · 重置：**整份配置退回 defaultConfig()** —— 壁纸、玻璃、主题色、登记目录
   *     全部清空，等于这个插件从没被配置过。
   *
   * `purgeFiles` 控制要不要连插件自己产生的文件一起删：
   *   · false（默认）：只重置配置 —— 原图在用户自己的目录里，插件从不碰；
   *   · true：额外删掉 `wallpapers/`（上传的副本，是插件复制进来的）与
   *     `url-cache/`（远程图的本地缓存）。这两处都**只是副本**，删了不影响任何原图。
   *   无论哪种，用户登记目录里的原始图片**永远不动** —— 那是另一个端点都没有的能力。
   */
  route('/api/reset', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'use POST' })
      return
    }
    let payload = {}
    try {
      payload = await readJson(req)
    } catch {
      // 空 body 也算合法：等价于默认的「只重置配置」。
      payload = {}
    }
    const purgeFiles = payload?.purgeFiles === true
    /* 直接覆盖成出厂值，不走 mergeConfig —— 合并是「只增不删」，拿它做重置会把
     * 用户原有的键留下来（那正是「关闭 ≠ 重置」的老问题）。 */
    const fresh = dropRetiredKeys(defaultConfig())
    await fsp.mkdir(DATA_DIR, { recursive: true })
    const tmp = `${CONFIG_FILE}.${process.pid}.tmp`
    await fsp.writeFile(tmp, `${JSON.stringify(fresh, null, 2)}\n`, 'utf8')
    await fsp.rename(tmp, CONFIG_FILE)
    configCache = fresh

    let removedFiles = 0
    if (purgeFiles) {
      for (const dir of [UPLOAD_DIR, URL_CACHE_DIR]) {
        let entries = []
        try {
          entries = await fsp.readdir(dir)
        } catch {
          continue // 目录不存在 = 没什么可删
        }
        for (const entry of entries) {
          try {
            await fsp.rm(path.join(dir, entry), { recursive: true, force: true })
            removedFiles += 1
          } catch {
            /* 单个文件删不掉不该让整个重置失败 */
          }
        }
      }
    }
    sendJson(res, 200, { ok: true, purged: purgeFiles, removedFiles, config: fresh })
  })

  /* ── 上传：浏览器选图落盘，避免每次刷新重新传 ── */
  route('/api/upload', async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'use POST' })
      return
    }
    const rawName = queryParam(req, 'name') || `upload-${Date.now()}.png`
    let ext = path.extname(rawName).toLowerCase()
    if (!IMAGE_EXT.has(ext)) ext = '.png'
    const safeName = `up-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`
    const buffer = await readBody(req, MAX_UPLOAD_BYTES)
    if (buffer.length === 0) {
      sendJson(res, 400, { ok: false, error: '空文件' })
      return
    }
    await fsp.mkdir(UPLOAD_DIR, { recursive: true })
    const target = path.join(UPLOAD_DIR, safeName)
    await fsp.writeFile(target, buffer)
    sendJson(res, 200, {
      ok: true,
      path: target,
      url: `${ROUTE_PREFIX}/api/image?path=${encodeURIComponent(target)}`,
      bytes: buffer.length,
    })
  })

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* 卸载期忽略单个路由的清理失败 */
      }
    }
  }, 'dsh-theme-studio: host routes')
}
