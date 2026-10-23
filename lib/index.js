/**
 * dsh-theme-studio —— 宿主（Node）半侧。
 *
 * 职责：
 *   - 只做宿主才做得到的事：读本地目录、持久化配置、接收上传、代理远程图片；
 *   - 不参与界面渲染，界面全在浏览器半侧（lib/client.js）；
 *   - 所有路由挂在 /theme-studio 前缀下，由 ctx.webServer 注册，同源 fetch 调用。
 *
 * 安全模型（多层叠加，任一层都不单独承担全部责任）：
 *   1. Host 白名单：所有方法（含 GET/HEAD）在路由入口先校验 Host，只放行
 *      localhost、IP 字面量与 DSH_THEME_STUDIO_ALLOWED_HOSTS 里的域名。这一层
 *      挡的是 DNS rebinding：恶意域名 evil.example 重绑到 127.0.0.1 后，浏览器
 *      发出的 Host 与 Origin 都是 evil.example:3080，只比对两者相等的同源校验
 *      会放行，因此必须按「Host 是不是本机/受信名字」来判断；
 *   2. 写方法闸门：PUT/POST 要求 Origin 与 Host 一致、Sec-Fetch-Site 非跨站，
 *      JSON 接口还要求 application/json，挡浏览器跨站写请求（CSRF）；
 *   3. 路径白名单：读图只允许已登记目录与上传目录，浏览只允许主目录/登记目录
 *      及其严格祖先；一律 realpath 后再判包含，挡 ../ 与符号链接逃逸；
 *   4. SSRF：代理只走 http/https，逐跳解析全部 DNS 地址并拒绝环回/私网/保留段，
 *      重定向手动跟随；回吐前按文件头 magic 判定位图，SVG 一律拒绝；
 *   5. 资源上限：请求体、单图、上传目录配额、扫描数量都有上限；
 *   6. 错误脱敏：500 只回「内部错误」，路径与上游地址只进宿主日志；唯一例外是
 *      第 7 层的配置损坏：它回固定的中文文案 + code，且只含备份文件基名；
 *   7. 配置持久化：写入串行排队，tmp + fsync + rename 原子落盘；损坏文件只备份、
 *      绝不用默认值覆盖，配置接口统一 500 CONFIG_CORRUPT，直到重置成功。
 *
 * 已知残余风险：代理回源时「DNS 校验」与「fetch 实际连接」之间仍有 TOCTOU 窗口
 * （出站 SSRF 面，见 resolveProxyTarget；入站 DNS rebinding 已由第 1 层 Host
 * 白名单挡住，两者不要混淆）；realpath 与读文件之间文件仍可能被换掉；Windows
 * 可按目录开启大小写敏感，而本文件按平台整体判断。插件自身不做身份认证，访问
 * 控制依赖宿主 webServer 的部署边界。
 *
 * 数据目录（DSH_HOME 下，默认 ~/.dsh/theme-studio）：
 *   config.json                配置，原子写；损坏时只备份原字节、绝不覆盖，等重置恢复
 *   wallpapers/                上传副本，可整体清理
 *   url-cache/<sha1>.<ext>     远程图缓存（同名 .json 为元数据），删除只影响下次回源
 *
 * 版本：1.0.0（运行时以 package.json 为准，见 readPluginVersion）。
 *
 * @module dsh-theme-studio/host
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import dns from 'node:dns'
import net from 'node:net'
import { createRequire } from 'node:module'

export const name = 'dsh-theme-studio'
export const inject = ['webServer']

/**
 * 从 package.json 读取插件版本号。
 *
 * 为什么不硬编码：客户端拿 /api/ping 的 version 判断宿主半侧是否与页面同版本，
 * 手抄的常量一旦漏改就会给出错误结论。用 createRequire 而不是 import assertion，
 * 是为了读不到 package.json 时只退常量，而不是让整个插件加载失败。
 * @returns 版本号字符串。
 */
function readPluginVersion() {
  try {
    const pkg = createRequire(import.meta.url)('../package.json')
    if (typeof pkg?.version === 'string' && pkg.version.trim().length > 0) return pkg.version
  } catch {
    /* 只读发布包 / 打包环境可能没有 package.json：退回常量 */
  }
  return '1.0.0'
}

/** 版本号在进程生命周期内不会变，只读一次。 */
const PLUGIN_VERSION = readPluginVersion()

/** 导出默认配置与迁移函数：给契约测试与外部工具复用，避免两处手抄同一份形状。 */
export { defaultConfig, migrateConfig, dropRetiredKeys, hasRetiredKeys, mergeConfig, CONFIG_VERSION }

/** 路由前缀：客户端所有 fetch 都打在这里。 */
const ROUTE_PREFIX = '/theme-studio'

/** DSH 主目录：配置与上传副本都放这里（node_modules 可能只读，不能写包内）。 */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const DATA_DIR = path.join(DSH_HOME, 'theme-studio')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const UPLOAD_DIR = path.join(DATA_DIR, 'wallpapers')
/**
 * 远程壁纸的本地缓存目录。
 *
 * 两个作用：远程图不必每次刷新都重下；URL 来源的「删除」有一个真正删得掉的
 * 本地副本 —— 删了只是下次回源，远端原图不受影响。
 */
const URL_CACHE_DIR = path.join(DATA_DIR, 'url-cache')

/** 允许作为壁纸的扩展名。 */
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'])

/**
 * 单个图片文件上限（字节），生产默认 256 MB。
 *
 * 留这么大是给 4K/8K 壁纸的：图直接交给浏览器当 CSS 背景，不进 base64、
 * 不常驻内存，代价只是宿主读盘一次。超限时连同 size 一起返回，面板才能
 * 说明「为什么这张用不了」而不是静默失败。
 */
const MAX_IMAGE_BYTES = 256 * 1024 * 1024
/**
 * 单次上传体积上限（字节），生产默认 32 MB。
 *
 * 测试钩子 DSH_THEME_STUDIO_MAX_UPLOAD_BYTES 可覆盖（见 limitFromEnv）。
 */
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024
/**
 * 单次 JSON 请求体上限（字节），生产默认 1 MB。
 *
 * 足够装下整份配置（客户端会把完整配置 PUT 回来），同时挡住「一个请求吃满
 * 宿主内存」的滥用。测试钩子：DSH_THEME_STUDIO_MAX_JSON_BYTES。
 */
const MAX_JSON_BYTES = 1024 * 1024
/**
 * 上传目录配额：文件数 500、总字节 512 MB（生产默认）。
 *
 * 没有配额时任意数量的 32 MB 二进制都能堆进 DATA_DIR，写满磁盘只是时间问题。
 * 超限返回 413 并提示先清理本地缓存，而不是默默写满。
 * 测试钩子：DSH_THEME_STUDIO_MAX_UPLOAD_FILES / _TOTAL_BYTES。
 */
const MAX_UPLOAD_FILES = 500
const MAX_UPLOAD_BYTES_TOTAL = 512 * 1024 * 1024
/**
 * 扫描兜底上限：单组最多 3000 个文件、最多向下 6 层（生产默认）。
 *
 * 只影响 /api/folders 的候选墙，不参与配置形状；撞到上限时响应带 truncated，
 * 面板据此提示结果不完整。测试钩子：DSH_THEME_STUDIO_MAX_SCAN_FILES / _DEPTH。
 */
const MAX_SCAN_FILES = 3000
const MAX_SCAN_DEPTH = 6

/**
 * 读一个「测试钩子」上限；未设置或不是正数时用默认值。
 *
 * 每次调用现读 process.env，而不是在模块加载时固化：同一进程里调整环境变量
 * 就能立即生效，测试不必为不同上限各写一套代码。这些变量生产环境从不设置，
 * 读取开销可忽略。
 *
 * @param name - 环境变量名。
 * @param fallback - 默认上限。
 * @returns 生效的上限（字节数或文件数）。
 */
function limitFromEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/** 本次请求的 JSON 体上限（测试钩子：DSH_THEME_STUDIO_MAX_JSON_BYTES）。 */
function maxJsonBytes() {
  return limitFromEnv('DSH_THEME_STUDIO_MAX_JSON_BYTES', MAX_JSON_BYTES)
}

/** 本次请求的上传体上限（测试钩子：DSH_THEME_STUDIO_MAX_UPLOAD_BYTES）。 */
function maxUploadBytes() {
  return limitFromEnv('DSH_THEME_STUDIO_MAX_UPLOAD_BYTES', MAX_UPLOAD_BYTES)
}

/** 上传目录的文件数配额（测试钩子：DSH_THEME_STUDIO_MAX_UPLOAD_FILES）。 */
function maxUploadFiles() {
  return limitFromEnv('DSH_THEME_STUDIO_MAX_UPLOAD_FILES', MAX_UPLOAD_FILES)
}

/** 上传目录的总字节配额（测试钩子：DSH_THEME_STUDIO_MAX_UPLOAD_TOTAL_BYTES）。 */
function maxUploadTotalBytes() {
  return limitFromEnv('DSH_THEME_STUDIO_MAX_UPLOAD_TOTAL_BYTES', MAX_UPLOAD_BYTES_TOTAL)
}

/**
 * 单目录扫描的文件数上限（测试钩子 DSH_THEME_STUDIO_MAX_SCAN_FILES，默认 3000）。
 * @returns 本次扫描最多收集多少个图片文件。
 */
function maxScanFiles() {
  return limitFromEnv('DSH_THEME_STUDIO_MAX_SCAN_FILES', MAX_SCAN_FILES)
}

/**
 * 递归扫描的最大目录深度（测试钩子 DSH_THEME_STUDIO_MAX_SCAN_DEPTH，默认 6）。
 * @returns 从登记根算起最多向下几层。
 */
function maxScanDepth() {
  return limitFromEnv('DSH_THEME_STUDIO_MAX_SCAN_DEPTH', MAX_SCAN_DEPTH)
}

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
     * 配置版本，只用于一次性迁移。
     *
     * 出厂默认不改壁纸、已有分区的颜色和模糊；AI 回复气泡单独默认开启。
     * 早期版本的默认值带模糊与半透明，升到当前版本必须显式重置，
     * 否则旧值会留下（deepMerge 只增键、不删键）。
     */
    version: 2,
    /** 总开关。 */
    enabled: true,
    /** 主题色（accent）配置。 */
    accent: {
      enabled: false,
      rgb: [65, 118, 230],
      preset: 'deepseek',
    },
    /** 背景图配置。所有「会改变壁纸观感」的项默认都是中立值。 */
    wallpaper: {
      /** 壁纸来源：'none' | 'folder' | 'url' | 'upload' */
      source: 'none',
      /** 已登记的本地文件夹（绝对路径）。 */
      folders: [],
      /** 是否递归扫描子目录。 */
      recursive: true,
      /** 已登记的远程图片链接。 */
      urls: [],
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
      /** 遮罩颜色；auto 沿用原来的黑色，由 dim 控制透明度。 */
      dimColor: 'auto',
      /** 暗角强度 0–1。默认 0 = 不加暗角。 */
      vignette: 0,
      /** 噪点强度 0–0.2。默认 0 = 不加噪点。 */
      noise: 0,
    },
    /**
     * 分区毛玻璃参数。出厂不透明度与模糊中立：opacity = 1、blur = 0；
     * AI 回复气泡默认开启，但可单独关闭以恢复 DSH 原本的无气泡正文。
     * 用户把某个分区的「不透明度」往左拉才透出壁纸，再拉「模糊」才是磨砂，
     * 这样刚装上壁纸时不会有意料之外的效果。
     *
      * 每个分区有 enabled / opacity / blur / color；color='auto' 随明暗主题，
      * 自定义色由 opacity 控制透明度。分区级 saturation 已退役，
     * 残键由 dropRetiredKeys() 在读写两条路径上清掉（见 RETIRED_REGION_KEYS）。
     * 已删除的 sidebar / topbar / chat / panel 故意没有键（见 RETIRED_REGIONS）；
     * 现在的「边栏」是新键 bars，旧键不复活。AI 回复气泡是独立的新分区。
     */
    glass: {
      bars: { enabled: true, opacity: 1, blur: 0, color: 'auto' },
      input: { enabled: true, opacity: 1, blur: 0, color: 'auto' },
      bubble: { enabled: true, opacity: 1, blur: 0, color: 'auto' },
      assistant: { enabled: true, opacity: 1, blur: 0, color: 'auto' },
      menu: { enabled: true, opacity: 1, blur: 0, color: 'auto' },
      /** 玻璃内描边强度 0–1。 */
      border: 0.6,
      /** 顶部高光强度 0–1。 */
      highlight: 0.5,
    },
  }
}

/** 进程内配置缓存，避免每个请求都读盘。 */
let configCache

/**
 * 配置顶层键数量上限。
 *
 * 为什么需要：`deepMerge` 会把 patch 里**所有未知顶层键**原样合并进来（这是故意的，
 * 宿主不清理客户端自己的键），但一个恶意/出错的调用方可以一次塞进几十万个顶层键，
 * 让每次读写都要序列化/深合并一个巨型对象。200 个足够覆盖任何正常扩展，超过就
 * 拒绝写入 —— 限的是「宽度」，不是删已有键：用户已经写进去的键不会被主动清掉。
 */
const MAX_CONFIG_TOP_LEVEL_KEYS = 200

/**
 * 判断一个值是不是「普通 JSON 对象」。
 *
 * 只认 null 原型或 Object.prototype 原型的非数组对象：配置文件的顶层必须是对象，
 * 数组 / 字符串 / 数字 / null 都按损坏处理；PUT 的 patch 也必须是对象，否则
 * `deepMerge` 会把整个配置替换成一个标量，之后再读就崩。
 * @param value - 待判断的值。
 * @returns 是否是普通对象。
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * 配置写入的输入错误（400/413）。
 *
 * 为什么要单独一个类：route() 的兜底 catch 会把所有异常变成脱敏的 500；
 * 这类错误的 message 是我们自己写的中文文案、不含任何路径，可以由路由安全地
 * 原样返回 400/413。
 */
class ConfigInputError extends Error {
  /**
   * @param status - HTTP 状态码（400 或 413）。
   * @param message - 可直接展示给用户的中文文案。
   */
  constructor(status, message) {
    super(message)
    this.name = 'ConfigInputError'
    this.status = status
  }
}

/**
 * 配置损坏错误（500，`code === 'CONFIG_CORRUPT'`）。
 *
 * 为什么要单独一个类：route() 的兜底 catch 会把所有异常变成脱敏的 500「内部错误」，
 * 客户端只看到「出错了」，根本不知道配置被判定损坏、更不能据此提示用户去重置。
 * 损坏是可恢复的确定状态，message 由本模块自己生成（固定中文、只含备份文件基名），
 * 所以可以把 message 与 code 原样返回，而不违反「500 不回显 error.message」。
 */
class ConfigCorruptError extends Error {
  /**
   * @param message - 可直接展示给用户的中文文案，绝不能含宿主绝对路径。
   */
  constructor(message) {
    super(message)
    this.name = 'ConfigCorruptError'
    this.code = 'CONFIG_CORRUPT'
  }
}

/**
 * 当前的配置损坏状态；null 表示配置可正常读写。
 *
 * 一旦置位，本进程内所有依赖配置的接口一律 500（CONFIG_CORRUPT），且绝不落盘：
 * config.json 的原始字节是用户仅存的一份数据，覆盖即永久丢失 —— 即使旁边有一份
 * 备份，用户「随手保存」一次也会把备份之外的原始信息彻底抹掉，所以默认值绝不能
 * 静默写回。`backupPath` 为 null 表示备份失败，写盘门禁继续拦着，直到 /api/reset
 * 重试备份成功。
 *
 * @type {{ reason: string, backupPath: string | null } | null}
 */
let configCorrupt = null

/**
 * 损坏配置是否还没备份成功。
 *
 * 为 true 时禁止任何落盘：原文件是用户唯一的一份数据，备份失败就覆盖等于永久丢失。
 * 只有 /api/reset 会重试备份，成功后才解除。
 */
let configCorruptNeedsBackup = false

/**
 * 最近一次「读配置顺手触发的落盘」（迁移 / 清理退役键）。
 *
 * GET /api/config 会等它结束再响应，保证客户端拿到迁移后的配置时，磁盘上也已经是
 * 同一份内容，而不是「响应说迁移了、盘上还是旧的」。
 */
let configPersistPending = Promise.resolve()

/**
 * 配置写队列的尾巴。
 *
 * 所有配置落盘（PUT/POST 合并写、迁移写、reset 整份替换）都排在这条 Promise 链上，
 * 保证「读 cache → 合并 → 写 tmp → rename → 回填 cache」这个读改写序列不会交错。
 */
let configWriteChain = Promise.resolve()

/** 当前出厂配置版本；低于它的旧配置需要一次性迁移。 */
const CONFIG_VERSION = defaultConfig().version

/**
 * 一次性迁移：把早期「带效果」的配置改成中立默认值。
 *
 * 为什么不能只改默认值：deepMerge(defaults, raw) 只在 raw 缺少该键时才采用
 * 默认值，而老配置里 blur/opacity/dim 都有值，旧值会赢。所以这里显式重置
 * 壁纸效果参数与当时已有的四个分区的玻璃参数；用户真正做过的选择（主题色、登记目录、
 * 当前壁纸、适配方式）全部保留。
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
  // 旧版已有的四个分区一律归零；新 assistant 分区由默认值合并补齐。
  for (const key of ['bars', 'input', 'bubble', 'menu']) {
    glass[key] = { ...(glass[key] ?? {}), opacity: 1, blur: 0 }
  }
  next.glass = glass
  return dropRetiredKeys(next)
}

/**
 * 已整体删除的分区名：旧配置里的残键会被删掉。
 *
 * - sidebar / topbar：先因「模糊断层」与效果代码整体移除而删除，后来用新键
 *   bars 重写；
 * - chat：选择器是中心列容器，会把顶边栏一起糊掉，效果与设置项一并删除；
 * - panel：设置界面自己的透明/模糊，已无对应开关。
 *
 * 重做某个分区时必须把它从这里移除，否则新写入的配置会被立刻清掉；
 * bars 是新键，sidebar / topbar 继续留在这里清旧值。
 * @type {readonly string[]}
 */
const RETIRED_REGIONS = ['sidebar', 'topbar', 'chat', 'panel']

/**
 * 已退役的分区参数：分区还在，但没有代码读这个字段。
 * 注意与 wallpaper.saturation 区分，后者仍在用（图片整体饱和度）。
 * @type {readonly string[]}
 */
const RETIRED_REGION_KEYS = ['saturation']

/**
 * 已退役的顶层键：读盘与写盘都会物理删除，避免配置文件里留下「看起来能调」
 * 却谁也不读的键。
 *
 * - perf：原「画质档位」，现在模糊半径上限由客户端固定常量（100px）决定；
 * - scope：从未有任何读取点，CSS 规则固定挂在根属性上，留着只会误导。
 * @type {readonly string[]}
 */
const RETIRED_TOP_LEVEL = ['perf', 'scope']

/**
 * 已退役的壁纸键。
 *
 * - hidden：「已移除候选」名单。没有恢复入口的名单是静默黑洞：图还在磁盘、
 *   路径还在名单里，界面却永远看不到，重新扫描甚至把文件放回原目录都救不回来
 *   （路径仍命中名单）。整套机制拆除后，被挡住过的图重新出现在候选墙；
 *   面板上的「移除」对文件夹来源只把图从本次会话的候选墙拿掉（若正好是当前
 *   壁纸则清空选择并落盘），不碰原文件。
 * - rotate：session/daily/manual 轮换策略，从未有读取点与 UI。
 * @type {readonly string[]}
 */
const RETIRED_WALLPAPER_KEYS = ['hidden', 'rotate']

/**
 * 判断一份原始配置里是否残留任何已退役的键。
 *
 * 与 dropRetiredKeys 配对：readConfig() 靠它决定「清理结果要不要立刻落盘」。
 * 不在别处重复判断具体键名，新增退役键时只改 RETIRED_* 列表即可。
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
 * 剔除已退役、没有代码读的配置键。
 *
 * 为什么需要：深合并只增键、不删键，老配置里的 glass.sidebar、glass.*.saturation、
 * perf、wallpaper.hidden 会一直留着 —— 既没人读，又会让打开配置文件的人以为
 * 「这些设置还在，只是界面没显示」。
 *
 * 为什么迁移与读盘都要调用：迁移只在版本号落后时跑一次，而删键不提升版本号，
 * 已迁到当前版本的配置不会再走迁移分支。两处都调用不会互相干扰（删不存在的键
 * 是空操作），并保证缓存里永远没有退役键。
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
 * 生成损坏配置备份文件名里的时间戳：本地时区 `yyyyMMdd-HHmmss`。
 *
 * 用本地时间而不是 UTC：用户在文件管理器里对照备份文件排查时，看到的就是本地时间。
 * @param date - 当前时间。
 * @returns 时间戳字符串。
 */
function corruptTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * 把损坏的 config.json 原样复制到同目录（config.json.corrupt-<时间戳>）。
 *
 * 命名与字节复制规则保持不变：用 copyFileSync 而不是读出来再 parse，是为了保留
 * 原始字节，方便事后人工抢救；同一秒内重复损坏时追加 -2 / -3，避免备份互相覆盖。
 *
 * 备份是「拒绝覆盖」的前提，而不是恢复默认值的前奏：调用方在备份成功后只会置
 * 损坏标记并报错，**不会**用默认值改写 config.json。
 *
 * @param reason - 判定为损坏的原因（写进日志）。
 * @returns 备份文件绝对路径；备份失败返回 null。
 */
function backupCorruptConfig(reason) {
  const base = `${CONFIG_FILE}.corrupt-${corruptTimestamp()}`
  let target = base
  for (let index = 2; fs.existsSync(target); index += 1) target = `${base}-${index}`
  try {
    fs.copyFileSync(CONFIG_FILE, target)
    console.error(`[dsh-theme-studio] 配置文件损坏（${reason}），原文件已备份到 ${target}；已拒绝覆盖原文件，等待重置恢复。`)
    return target
  } catch (error) {
    console.error(
      `[dsh-theme-studio] 配置文件损坏（${reason}），备份到 ${target} 失败：已拒绝覆盖原文件；重置时会重试备份。`,
      error,
    )
    return null
  }
}

/**
 * 生成损坏状态的对外文案（固定中文，只含备份文件**基名**）。
 *
 * 为什么不带绝对路径：文案会原样返回给浏览器，宿主数据目录结构不需要也不应该
 * 暴露；用户需要的是「哪份备份、该怎么恢复」。文案里必须给出唯一恢复入口
 * （/api/reset），否则面板只能把 500 显示成「内部错误」，用户无处可走。
 *
 * @returns 可直接展示的中文文案。
 */
function configCorruptMessage() {
  const reason = configCorrupt?.reason ?? '配置文件不可解析'
  const backupPath = configCorrupt?.backupPath ?? null
  if (backupPath === null) {
    return `配置损坏（${reason}），备份失败，已拒绝覆盖原文件；请检查数据目录权限或磁盘空间后使用重置（POST /api/reset）重试。`
  }
  return `配置损坏（${reason}），原文件已备份为 ${path.basename(backupPath)}；为避免覆盖原始数据，已拒绝读写配置，请使用重置（POST /api/reset）恢复出厂配置。`
}

/**
 * 读取配置（进程内缓存）。
 *
 * 文件存在且版本落后 / 有退役键时，把「迁移 / 清理」的结果落盘一次，升级与清理
 * 因此只发生一次。两条绝不能写盘的路径：
 *   - 文件不存在（ENOENT）：首次使用，读操作不能凭空生成 config.json；
 *   - 文件存在但读不出来（EACCES / 共享冲突等）：可能只是暂时性的，覆盖会丢数据。
 *
 * 文件存在但 JSON 解析失败 / 顶层不是对象：只备份一次，然后抛 ConfigCorruptError，
 * **绝不写回默认值**。旧实现边备份边写回默认值，等于把「原文件被覆盖」变成正常
 * 流程：备份成了唯一一份原始数据，用户之后随手保存一次（或下一次启动再判损坏）
 * 就再也找不回来。现在原字节一动不动，进程内记住损坏原因与备份路径，所有依赖
 * 配置的接口统一 500 + code=CONFIG_CORRUPT，由用户显式重置来恢复。
 *
 * 已处于损坏状态时直接抛错，不再读盘、不再备份：否则每次 GET 都会在目录里堆一份
 * 同样的 config.json.corrupt-*。
 *
 * @returns 合并了默认值的配置对象。
 * @throws {ConfigCorruptError} 配置文件损坏时。
 */
function readConfig() {
  // 损坏状态优先于缓存：一旦判定损坏，就不能再让任何接口拿到「内存里的旧值」。
  if (configCorrupt !== null) throw new ConfigCorruptError(configCorruptMessage())
  if (configCache !== undefined) return configCache

  let raw = {}
  let fileExists = false
  let readFailed = false
  let corruptReason = null

  try {
    const text = fs.readFileSync(CONFIG_FILE, 'utf8')
    fileExists = true
    try {
      const parsed = JSON.parse(text)
      if (isPlainObject(parsed)) {
        raw = parsed
      } else if (Array.isArray(parsed)) {
        corruptReason = '顶层是数组，不是 JSON 对象'
      } else {
        corruptReason = `顶层是 ${parsed === null ? 'null' : typeof parsed}，不是 JSON 对象`
      }
    } catch {
      corruptReason = 'JSON 解析失败'
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // 首次使用：用默认值，不落盘。否则一次普通 GET 就会创建 config.json。
      fileExists = false
    } else {
      // 先别把「读不出来」当成「没有配置」：Windows 上共享冲突、权限问题都可能是
      // 暂时性的，拿默认值覆盖上去等于把用户配置永久删掉。
      readFailed = true
      fileExists = true
      console.error('[dsh-theme-studio] 读取配置文件失败，本次使用默认配置，且不会自动覆盖原文件：', error)
    }
  }

  if (corruptReason !== null) {
    /* 只备份一次，然后报错 —— 这里绝不能调用 writeConfig / persistConfig：
     * 覆盖损坏的原文件才是真正的数据丢失，备份只是「亡羊补牢」，不是继续写盘的
     * 许可证。备份失败时 backupPath 为 null，重置时会重试，写盘门禁始终拦着。 */
    const backupPath = backupCorruptConfig(corruptReason)
    configCorrupt = { reason: corruptReason, backupPath }
    configCorruptNeedsBackup = backupPath === null
    configCache = undefined
    throw new ConfigCorruptError(configCorruptMessage())
  }

  const migrated = migrateConfig(raw)
  // 深合并只在 raw 缺少某个键时才采用默认值，所以退役键必须显式剔除。
  const hadRetired = hasRetiredKeys(raw)
  configCache = dropRetiredKeys(deepMerge(defaultConfig(), migrated))

  /* 只有「文件本来存在，且这次读做了迁移 / 清理」才顺手落盘。
   * ENOENT 时 migrated !== raw 也成立（默认值总带当前版本号），所以必须显式
   * 排除 fileExists === false —— 否则一次普通 GET 就会创建 config.json。 */
  if (fileExists && !readFailed && (migrated !== raw || hadRetired)) {
    configPersistPending = writeConfig({}).catch((error) => {
      console.error('[dsh-theme-studio] 配置迁移/清理结果落盘失败（不影响本次读取，下次启动会重试）：', error)
    })
  }
  return configCache
}

/**
 * 把局部配置合并进当前配置，并剔除退役键。
 *
 * 写路径也必须清理：deepMerge 只增键不删键，只要有一次 PUT 带了退役键
 * （老客户端、旧标签页、脚本都可能带），它就会进入 configCache 并落盘；
 * 之后读盘直接命中缓存，readConfig 的清理再也碰不到它。读写两条路径都清理，
 * 「缓存里永远没有退役键」才成立。
 *
 * @param base - 当前配置。
 * @param patch - 局部配置。
 * @returns 合并并清理后的新对象。
 */
function mergeConfig(base, patch) {
  return dropRetiredKeys(deepMerge(base, patch ?? {}))
}

/**
 * 把一次配置落盘任务排进模块级串行队列。
 *
 * 为什么必须串行：写配置是「读 cache → 合并 → 写 tmp → rename → 回填 cache」
 * 的读改写序列；并发时后写的 rename 会覆盖前一个请求的成果，cache 也可能停在
 * 更早的版本上。队列只排队、不合并请求：每个请求都看得到前一个请求的结果。
 *
 * 队列自身吞掉异常，避免一次失败卡死后续写入；调用方拿到的仍是自己的结果。
 *
 * @param task - 返回 Promise 的落盘任务。
 * @returns 该任务自己的 Promise。
 */
function enqueueConfigWrite(task) {
  const run = configWriteChain.then(task)
  configWriteChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * 覆盖原文件前，确保损坏的配置已经备份成功。
 *
 * 只在损坏状态下有意义：首次检测损坏时会尝试备份，失败（磁盘满 / 权限不足）则
 * 置 configCorruptNeedsBackup。这里给 /api/reset 一次重试机会；仍然失败就抛
 * ConfigCorruptError，宁可重置返回 500，也不覆盖用户唯一的一份数据。
 */
function ensureCorruptConfigBackedUp() {
  if (configCorrupt === null || !configCorruptNeedsBackup) return
  const backupPath = backupCorruptConfig(configCorrupt.reason)
  if (backupPath === null) {
    // 文案由 configCorruptMessage 生成：固定中文、只含基名，不泄露宿主目录。
    throw new ConfigCorruptError(configCorruptMessage())
  }
  configCorrupt.backupPath = backupPath
  configCorruptNeedsBackup = false
}

/**
 * 原子写入一份完整配置：同目录唯一临时文件 → fsync → rename。
 *
 *   - tmp 名带 pid + 6 字节随机数，并发写（即使跨进程）不会共用同一个文件；
 *   - rename 前 fsync，避免断电后留下「名字对了、内容空了」的配置；
 *   - 任何一步失败都清掉自己的 tmp 再抛错，不在数据目录留垃圾。
 * 已知残余：没有对目录本身 fsync，极端断电时 rename 可能回退到旧文件，
 * 但不会读到半截 JSON。
 *
 * @param config - 完整配置对象。
 */
async function persistConfig(config) {
  await fsp.mkdir(DATA_DIR, { recursive: true })
  const tmp = `${CONFIG_FILE}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  let handle
  try {
    handle = await fsp.open(tmp, 'w')
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await fsp.rename(tmp, CONFIG_FILE)
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {})
    // rename 失败 / 写一半失败：必须清理，否则目录里会残留 *.tmp。
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * 把局部配置合并进当前配置并原子落盘（串行执行）。
 *
 * 输入校验放在排队之前：patch 必须是普通对象（否则 400），合并后顶层键超过
 * 上限则拒绝写入（413）。两类错误都由 /api/config 路由原样映射，不被兜底成 500。
 *
 * @param patch - 需要合并进去的部分配置。
 * @returns 写入后的完整配置。
 */
function writeConfig(patch) {
  if (!isPlainObject(patch)) {
    return Promise.reject(new ConfigInputError(400, '配置必须是一个 JSON 对象'))
  }
  return enqueueConfigWrite(async () => {
    // 先读一次：磁盘上是损坏文件时，readConfig 会完成「备份一次 + 置损坏标记」，
    // 并抛出 ConfigCorruptError —— 写请求就此 500，绝不会走到 persistConfig。
    const base = readConfig()
    const merged = mergeConfig(base, patch)
    const keyCount = Object.keys(merged).length
    if (keyCount > MAX_CONFIG_TOP_LEVEL_KEYS) {
      // 413：语义上是「请求体太大/太宽」；文案给客户端，不含任何宿主信息。
      throw new ConfigInputError(
        413,
        `配置顶层键过多（${keyCount} 个，最多 ${MAX_CONFIG_TOP_LEVEL_KEYS} 个），已拒绝写入`,
      )
    }
    await persistConfig(merged)
    // 落盘成功后才更新 cache；失败时 cache 保持原值，不会出现「内存有、磁盘没有」。
    configCache = merged
    return merged
  })
}

/**
 * 把整份配置恢复为出厂值（/api/reset 专用，也是损坏状态的唯一出口）。
 *
 * 与 writeConfig 的区别：不合并、允许删键（重置必须能删掉用户原有键，而
 * mergeConfig 只增不删）。与普通写路径的区别：**允许在损坏状态下执行** ——
 * 先确保原文件已备份（启动时可能因磁盘满 / 权限失败，这里重试一次），备份不
 * 成功就抛 ConfigCorruptError 且绝不覆盖；备份成功后才写 defaultConfig()，
 * 然后清除损坏标记与缓存。这样「原文件被覆盖」只发生在用户显式重置、且原始
 * 字节已经安全落盘之后。
 *
 * 仍然走同一条写队列：reset 与并发 PUT 必须串行，否则谁最后 rename 谁赢，
 * 缓存也会分叉。
 *
 * @returns 写入后的出厂配置。
 */
function resetConfig() {
  return enqueueConfigWrite(async () => {
    /* 第一个配置操作就是 reset（此前没有任何读请求）时，损坏状态还没建立：
     * 这里先读一次，让 readConfig 完成「备份一次 + 置位」。它抛出的
     * ConfigCorruptError 正是本函数要继续处理的信号，不是失败 —— reset 是
     * 唯一允许在损坏时继续的接口。 */
    if (configCorrupt === null) {
      try {
        readConfig()
      } catch (error) {
        if (!(error instanceof ConfigCorruptError)) throw error
      }
    }
    // 备份失败过（或刚刚失败）就再试一次；仍失败则保持原文件不动并 500。
    ensureCorruptConfigBackedUp()
    const prepared = dropRetiredKeys(defaultConfig())
    await persistConfig(prepared)
    // 落盘成功后才解除损坏状态：失败时标记必须保留，接口继续 500，而不是假装正常。
    configCache = prepared
    configCorrupt = null
    configCorruptNeedsBackup = false
    return prepared
  })
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
 * 文件系统是否大小写不敏感。
 *
 * Windows / macOS 默认不敏感，必须折叠大小写才能匹配同一个目录；Linux（ext4 等）
 * 敏感，一律折叠会把 /a/X 误判成 /a/x。只按 process.platform 判断、不探测磁盘：
 * 宿主只支持这三个平台，探测反而引入 IO 与缓存问题。
 * 残余风险：Windows 支持按目录开启区分大小写，这里无法感知。
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

/**
 * 把路径规范化成「可比较」的形式：绝对路径 + 去掉结尾分隔符 + 按平台决定小写。
 *
 * 去掉结尾分隔符是为了让 `C:\Pictures\` 与 `C:\Pictures` 相等；但**盘根**
 * （`C:\`、`/`）必须原样保留 —— 把 `C:\` 截成 `C:` 会变成「当前盘当前目录」
 * 这种相对语义，包含判断就全错了。
 * @param value - 任意路径字符串。
 * @returns 用于比较的规范化字符串。
 */
function comparablePath(value) {
  const resolved = path.resolve(value)
  const root = path.parse(resolved).root
  const trimmed = resolved.length > root.length && resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved
  return CASE_INSENSITIVE_FS ? trimmed.toLowerCase() : trimmed
}

/**
 * 判断 child 是否等于 parent 或位于 parent 之内。
 *
 * 只负责包含关系，不做 realpath：调用方必须先 realpath（见 resolveAllowedImage
 * 与 resolveBrowseTarget），否则符号链接 / junction 可以绕过。大小写规则交给
 * comparablePath，结尾分隔符也在那里归一，所以 C:\a\b 不会被误判为 C:\a\bc 之内。
 * @param child - 待检查路径。
 * @param parent - 根路径。
 * @returns 是否在根内（含相等）。
 */
function isInside(child, parent) {
  const a = comparablePath(child)
  const b = comparablePath(parent)
  if (a === b) return true
  return a.startsWith(b.endsWith(path.sep) ? b : `${b}${path.sep}`)
}

/**
 * 两个路径是否指向同一位置（大小写规则同 comparablePath）。
 *
 * 单独抽出来是因为「相等」与「包含」在大小写敏感平台上语义不同，
 * isInside(a, b) && isInside(b, a) 读起来像绕口令。
 * @param left - 路径一。
 * @param right - 路径二。
 * @returns 是否等价。
 */
function samePath(left, right) {
  return comparablePath(left) === comparablePath(right)
}

/**
 * candidate 是否是 root 的严格祖先目录（给「上一级」导航用）。
 *
 * 允许祖先：在登记目录里选图时常要点「上一级」再进另一个子目录，只允许根内
 * 路径会让上一级立刻 403。必须排除文件系统根：C:\ 与 / 是所有路径的祖先，
 * 放行后白名单就退化成「全盘目录浏览器」。
 * @param candidate - 待检查路径（已 resolve）。
 * @param root - 允许的根目录。
 * @returns candidate 是否是 root 的严格祖先。
 */
function isProperAncestor(candidate, root) {
  const self = path.resolve(candidate)
  // dirname 等于自身 = 盘根（C:\ 或 /）；它永远不作为可浏览目标。
  if (path.dirname(self) === self) return false
  return !samePath(self, root) && isInside(root, self)
}

/**
 * 允许浏览的根目录 = 用户主目录 + 配置里登记的文件夹。
 *
 * 主目录也算根：新用户还没登记任何目录时，「浏览」也得能选到图；主目录之外的
 * 系统目录、其它用户目录、其它盘符必须先登记再浏览。这里故意不把盘根写进来，
 * 否则白名单形同虚设；要浏览其它盘符就在面板里输入绝对路径登记。
 * @returns 绝对路径数组（未 realpath；realpath 由 resolveBrowseTarget 负责）。
 */
function browseRoots() {
  const config = readConfig()
  const folders = (config.wallpaper?.folders ?? []).filter((item) => typeof item === 'string' && item.length > 0)
  return [os.homedir(), ...folders].map((item) => path.resolve(item))
}

/**
 * 目标路径是否落在浏览白名单内（字面判断）。
 * @param target - 已 resolve 的绝对路径。
 * @param roots - 允许的根目录。
 * @returns 是否允许浏览。
 */
function isBrowseAllowed(target, roots) {
  return roots.some((root) => isInside(target, root) || isProperAncestor(target, root))
}

/**
 * 把 /api/browse 的 path 参数解析成「确认在白名单内、可以 readdir」的目标。
 *
 * 两段式校验：
 *   1. 字面路径必须在白名单内（根本身、根内、或根的严格祖先）；
 *   2. 目标存在时再取 realpath 复核 —— 根内一个指向 C:\Windows 的符号链接 /
 *      junction，字面判断看不出越权，realpath 之后会露出来。
 * 目标不存在 / 无权限时不做第二段：那不是越权，交给 readdir 统一归入
 * 「无法读取该目录」，也避免对任意路径做磁盘探测。
 *
 * @param input - 查询参数原值；空串表示主目录。
 * @returns `{ ok: true, target, roots }` 或 `{ ok: false }`。
 *   失败不带任何原因细节：对外统一文案，避免泄露宿主目录结构。
 */
async function resolveBrowseTarget(input) {
  const target = input.length > 0 ? normalizeUserPath(input) : os.homedir()
  const roots = browseRoots()
  if (!isBrowseAllowed(target, roots)) return { ok: false }

  let real
  try {
    real = await fsp.realpath(target)
  } catch {
    // 不存在 / 不可访问：白名单已过，readdir 会给出同样的「无法读取该目录」。
    return { ok: true, target, roots }
  }
  // 登记目录本身可能就是符号链接，所以对根也补一份 realpath 再判断。
  const realRoots = []
  for (const root of roots) {
    realRoots.push(root)
    try {
      realRoots.push(await fsp.realpath(root))
    } catch {
      /* 登记目录暂时不可达：只保留字面值，不影响其它根 */
    }
  }
  if (!isBrowseAllowed(real, realRoots)) return { ok: false }
  return { ok: true, target, roots }
}

/**
 * 校验一个绝对路径是否指向「已登记目录内的可读图片文件」。
 *
 * 顺序：realpath → 扩展名 → 落在某个 realpath 后的根内 → 普通文件 → 大小。
 * 返回结构化原因而不是 null：静默失败会让人以为插件坏了，实际可能只是
 * 「图片太大」或「目录没登记」。realpath 与后续读文件之间文件仍可能被换掉
 * （TOCTOU），本插件不为本地可信用户加锁。
 *
 * @param target - 候选绝对路径。
 * @param roots - 已登记的根目录列表。
 * @returns `{ ok: true, real, stat }` 或 `{ ok: false, reason, size?, tooLarge? }`。
 *   stat 一并返回，/api/image 生成 ETag / Last-Modified 时不用再 stat 一次。
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
  return { ok: true, real, stat }
}

/**
 * 递归收集一个目录下的图片文件。
 *
 * 返回 `{ items, truncated }` 而不是裸数组：撞到上限时静默停下会让用户只看到
 * 「图库少了图」。truncated=true 表示这次扫描被上限截断、结果可能不完整，
 * /api/folders 把它原样带给面板提示「只显示了前 N 张」。
 *
 * 两种截断都置位：文件数达到 maxFiles；某个目录到了深度上限、未能继续向下。
 * 单文件 stat 失败只跳过该文件；读不了的子目录直接跳过。
 *
 * @param root - 根目录绝对路径。
 * @param recursive - 是否进入子目录。
 * @param limits - `{ maxFiles, maxDepth }`；省略时按测试钩子 / 默认值现读。
 *   由调用方一次性传入，保证同一次请求里顶层 limit 与各组扫描用同一个值。
 * @returns `{ items, truncated }`。
 */
async function scanFolder(root, recursive, limits = {}) {
  const maxFiles = Number.isFinite(limits.maxFiles) ? limits.maxFiles : maxScanFiles()
  const maxDepth = Number.isFinite(limits.maxDepth) ? limits.maxDepth : maxScanDepth()
  /** 扫描到的图片条目。 @type {{path:string,name:string,dir:string,size:number,mtime:number}[]} */
  const found = []
  let truncated = false
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length > 0) {
    // 队列里可能还有没扫的目录：文件数已经到顶，剩下的不可能再收进来。
    if (found.length >= maxFiles) {
      truncated = true
      break
    }
    const { dir, depth } = queue.shift()
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (found.length >= maxFiles) {
        truncated = true
        break
      }
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!recursive) continue
        if (depth < maxDepth) {
          queue.push({ dir: full, depth: depth + 1 })
        } else {
          // 还有子目录却不再向下：里面的图扫不到，必须让调用方知道。
          truncated = true
        }
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
  return { items: found, truncated }
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

/* ─────────────────────────── 图片缓存验证（ETag / 304） ─────────────────────────── */

/**
 * 根据文件元信息生成图片 ETag。
 *
 * 为什么 mtimeMs 要参与：只把「字节数 + 路径」放进哈希时，把一张图换成字节数
 * 相同的另一张，ETag 不变，浏览器带 If-None-Match 永远拿到 304，只能强刷。
 * mtimeMs 正常写入一定会变，内容变化就能传导到 ETag；realpath 参与是为了
 * 不同文件即使 mtime/size 相同也不会共用标签。
 *
 * 为什么不用内容哈希：/api/image 上限 256 MB，每次协商都把整图读一遍再算 sha1，
 * 等于把 304 省下的读盘又还回去；元信息哈希不读文件。
 *
 * @param real - 已 realpath 的文件路径。
 * @param stat - 该路径的 fs.Stats。
 * @returns 带引号的强 ETag。
 */
function imageETag(real, stat) {
  const digest = crypto
    .createHash('sha1')
    .update(real)
    .update(':')
    .update(String(stat.mtimeMs))
    .update(':')
    .update(String(stat.size))
    .digest('hex')
  return `"${digest.slice(0, 32)}"`
}

/**
 * 把 `If-None-Match` 头拆成标签列表。
 *
 * 不能简单 `split(',')`：ETag 的 opaque-tag 允许出现逗号（例如 `"a,b"`），
 * 按引号状态扫描才能正确切分。空段（结尾逗号、连续逗号）直接忽略。
 * Node 对重复的 If-None-Match 会用 `, ` 合并；这里仍兼容数组形态。
 *
 * @param value - 请求头原值。
 * @returns 标签字符串数组（保留 `W/` 前缀与引号）。
 */
function splitETagList(value) {
  const text = Array.isArray(value) ? value.join(',') : String(value ?? '')
  const tags = []
  let current = ''
  let quoted = false
  for (const char of text) {
    if (char === '"') {
      quoted = !quoted
      current += char
      continue
    }
    if (char === ',' && !quoted) {
      const tag = current.trim()
      if (tag.length > 0) tags.push(tag)
      current = ''
      continue
    }
    current += char
  }
  const tail = current.trim()
  if (tail.length > 0) tags.push(tail)
  return tags
}

/**
 * `If-None-Match` 是否命中当前 ETag。
 *
 * 三条语义都按 RFC 9110 实现：
 *   - `*`：资源存在即命中（调用方已经确认文件存在且可读）；
 *   - 逗号分隔多值：任一命中即可；
 *   - `W/` 弱比较：GET/HEAD 的缓存验证用弱比较，`W/"x"` 与 `"x"` 视为同一个
 *     entity-tag，所以比较前统一去掉 `W/` 前缀。
 *
 * @param header - If-None-Match 头原值。
 * @param etag - 当前响应的 ETag。
 * @returns 是否应返回 304。
 */
function ifNoneMatchHits(header, etag) {
  const tags = splitETagList(header)
  if (tags.includes('*')) return true
  const current = etag.replace(/^W\//i, '')
  return tags.some((tag) => tag.replace(/^W\//i, '') === current)
}

/**
 * `If-Modified-Since` 是否命中。
 *
 * 只在请求**没有** If-None-Match 时使用：RFC 9110 要求两者同时出现时忽略
 * If-Modified-Since，否则一个过期的日期可能盖过 ETag 的精确判断。
 * HTTP 日期精度只到秒，文件 mtime 却有毫秒（Windows 上还有 100ns 粒度），
 * 因此把 mtime 向下取整到秒再比较；否则同一秒内刚写过的文件会永远判成
 * 「已修改」，If-Modified-Since 等于失效。
 *
 * @param value - If-Modified-Since 头原值。
 * @param stat - 文件 fs.Stats。
 * @returns 是否应返回 304。
 */
function notModifiedSince(value, stat) {
  if (typeof value !== 'string' || value.length === 0) return false
  const since = Date.parse(value)
  if (!Number.isFinite(since)) return false
  return Math.floor(stat.mtimeMs / 1000) * 1000 <= since
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
    // 序列化失败同样是宿主内部错误：完整异常进日志，响应只给泛化文案。
    console.error('[dsh-theme-studio] 响应序列化失败：', error)
    body = JSON.stringify({ ok: false, error: '内部错误' })
    status = 500
  }
  res.writeHead(status, JSON_HEADERS)
  res.end(body)
}

/**
 * 发送 500：响应体只给泛化文案，完整错误只写宿主日志。
 *
 * 为什么不能回 error.message：Node 报错几乎都带宿主绝对路径
 * （ENOENT: no such file or directory, open 'C:\Users\...\config.json'），
 * 等于把目录结构直接交给浏览器。调用方只需知道「宿主内部出错」，排查靠日志。
 * @param res - http 响应对象。
 * @param error - 捕获到的异常。
 * @param context - 日志里用来说明「哪个接口」的短语。
 */
function sendInternalError(res, error, context) {
  console.error(`[dsh-theme-studio] ${context}：`, error)
  sendJson(res, 500, { ok: false, error: '内部错误' })
}

/** 安全方法：GET/HEAD 不改变状态，因此不参与 CSRF 闸门。 */
const SAFE_METHODS = new Set(['GET', 'HEAD'])

/* ──────────────────────── Host 白名单（防 DNS rebinding） ──────────────────────── */

/**
 * 解析并归一化 Host 头，返回裸主机名；无法解析时返回 null。
 *
 * 为什么不能直接把 Host 丢给 URL 解析：Host 来自对端，可能是畸形值；这里按
 * `host[:port]` / `[IPv6][:port]` 的形状解析主机名与端口，不校验域名语法；未命中
 * Host 白名单的畸形值一律由调用方返回 403，避免 `evil.example@127.0.0.1`、逗号
 * 拼接等歧义写法。
 *
 * 归一化规则：小写、去掉端口、去掉 FQDN 结尾的点。剥离端口前必须先认出方括号
 * IPv6，否则 `[::1]:3080` 会被最后一个冒号切错。
 *
 * @param value - req.headers.host 原值。
 * @returns 小写主机名（IPv6 不带方括号）；缺失/非法时 null。
 */
function parseRequestHost(value) {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (text.length === 0) return null

  /* IPv6 字面量按 RFC 3986 必须带方括号，端口只能出现在 `]` 之后。 */
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end < 0) return null
    const address = text.slice(1, end)
    const rest = text.slice(end + 1)
    if (rest.length > 0 && !/^:\d{1,5}$/.test(rest)) return null
    if (net.isIP(address) !== 6) return null
    return address
  }

  /* 不带方括号的完整 IPv6：没有端口可剥，整个值必须就是一个 IP 字面量。 */
  if (net.isIP(text) === 6) return text

  let hostname = text
  const colon = text.lastIndexOf(':')
  if (colon >= 0) {
    // 域名 / IPv4 里冒号最多只能有一个；多于一个且不是方括号 IPv6 = 畸形。
    if (text.indexOf(':') !== colon) return null
    if (!/^\d{1,5}$/.test(text.slice(colon + 1))) return null
    hostname = text.slice(0, colon)
  }
  // localhost. 与 localhost 是同一个名字：去掉结尾的点再比。
  if (hostname.endsWith('.')) hostname = hostname.slice(0, -1)
  return hostname.length > 0 ? hostname : null
}

/**
 * DSH_THEME_STUDIO_ALLOWED_HOSTS 是否命中（逗号或空白分隔的域名列表）。
 *
 * 两种条目：
 *   - 精确域名：theme.internal；
 *   - 通配子域：*.corp.example，只匹配子域（a.corp.example），不匹配裸域
 *     corp.example —— 通配若连裸域一起放行，等于把入口面扩大一整级。
 * 条目结尾的点会被忽略；空条目直接跳过。每次请求现读 process.env，与其它测试
 * 钩子一致，测试可以在同一进程里按用例切换。反向代理把 Host 改写成域名时，
 * 也要把该域名加进这个变量。
 *
 * @param hostname - 已归一化的 Host。
 * @returns 是否命中环境变量允许名单。
 */
function hostAllowedFromEnv(hostname) {
  const raw = process.env.DSH_THEME_STUDIO_ALLOWED_HOSTS
  if (typeof raw !== 'string' || raw.trim().length === 0) return false
  for (const part of raw.split(/[\s,]+/)) {
    let entry = part.trim().toLowerCase()
    if (entry.endsWith('.')) entry = entry.slice(0, -1)
    if (entry.length === 0) continue
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1) // 去掉前导 '*' 后是 '.corp.example'
      // 只认「有点、有子域前缀」的命中：裸域与空后缀都不放行。
      if (suffix.length > 1 && hostname.length > suffix.length && hostname.endsWith(suffix)) return true
      continue
    }
    if (hostname === entry) return true
  }
  return false
}

/**
 * 所有路由的第一道门：Host 必须是 localhost、IP 字面量或显式允许的域名。
 *
 * 为什么域名必须被挡（DNS rebinding）：浏览器访问 http://evil.example:3080 时
 * Host 与 Origin 天然一致；攻击者让自己的权威 DNS 在页面加载后把 evil.example
 * 重绑到 127.0.0.1，页面 JS 就能以同源身份读写本插件的接口。写方法闸门只比较
 * Origin 与 Host 是否同值，这种请求必然通过，所以必须在更前面按名字白名单拒绝。
 *
 * 为什么 IP 字面量可以放行：浏览器用 IP 访问时 Host 就是那个 IP，DNS 完全不
 * 参与，攻击者无法「重绑」一个 IP；而用户经常用 127.0.0.1 或局域网地址
 * （192.168.x.x / 10.x.x.x）直接打开面板，挡掉 IP 会破坏正常使用。放行任意 IP
 * 字面量不等于放开域名：能被 rebinding 利用的只有域名这一种 Host。
 *
 * 固定 403 文案，不回显 Host：Host 原值可能带端口或内部域名，回吐等于给探测
 * 工具提供指纹；这里也完全不写日志。
 *
 * @param req - http 请求对象。
 * @returns `{ status, error }` 表示拒绝；null 表示放行。
 */
function rejectDisallowedHost(req) {
  const hostname = parseRequestHost(req.headers.host)
  if (hostname === null) return { status: 403, error: 'Host 不被允许' }

  // IP 字面量（IPv4 / IPv6）一律放行：按 IP 访问是正常用法，且无法 rebinding。
  if (net.isIP(hostname) !== 0) return null
  // localhost、localhost.（已归一）与任意 *.localhost 子域。
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return null
  if (hostAllowedFromEnv(hostname)) return null
  return { status: 403, error: 'Host 不被允许' }
}

/**
 * JSON 接口的 Content-Type 是否合法。
 *
 * 只接受 `application/json`（允许 `; charset=utf-8` 这类参数）。浏览器跨站
 * 「简单请求」能用的 `text/plain` / `application/x-www-form-urlencoded` /
 * `multipart/form-data` 全部拒绝：这样跨站写请求必须走 CORS 预检，被浏览器先拦一次，
 * 服务端的 Origin 闸门是第二道。
 * @param value - 请求头原值。
 * @returns 是否接受。
 */
function isJsonContentType(value) {
  if (typeof value !== 'string') return false
  return value.split(';')[0].trim().toLowerCase() === 'application/json'
}

/**
 * 请求是否携带请求体（只看头部，不消费流）。
 *
 * 没有 Content-Length 也没有 Transfer-Encoding 时视为空体：
 * `/api/reset` 允许空体（等价于「只重置配置」），不该强迫它带 Content-Type。
 * @param req - http 请求对象。
 * @returns 是否有请求体。
 */
function hasRequestBody(req) {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > 0) return true
  return req.headers['transfer-encoding'] !== undefined
}

/**
 * 非 GET/HEAD 请求的请求级安全闸门（CSRF）。
 *
 * 放在 route() 包装层而不是各 handler：写接口有好几个，任何新增路由忘了写
 * 校验就有缺口；集中在入口才能「默认安全」，也不必每个 handler 抄一遍。
 * 不引入 token / 会话，只用浏览器必然发送的头：
 *   1. 带 Origin 时协议只限 http/https，host（含端口）必须与 Host 头忽略大小写
 *      相等 —— 拒绝 Origin: http://evil.example 与 Origin: null；
 *   2. Sec-Fetch-Site 为 cross-site / same-site 时拒绝；
 *   3. 没有 Origin 的请求放行：curl、测试脚本、同源导航都不发这个头，而浏览器
 *      跨站写请求一定带 Origin，放行不削弱防护。
 * 残余：这是 CSRF 防护，不是身份认证；判断依赖 Host 头，反向代理若改写 Host，
 * 必须把改写后的域名加入 DSH_THEME_STUDIO_ALLOWED_HOSTS（见 rejectDisallowedHost）。
 * @param req - http 请求对象。
 * @returns `{ status, error }` 表示拒绝；null 表示放行。
 */
function rejectUnsafeRequest(req) {
  const origin = req.headers.origin
  if (origin !== undefined) {
    let parsed = null
    try {
      parsed = new URL(String(origin))
    } catch {
      parsed = null
    }
    const host = String(req.headers.host ?? '').toLowerCase()
    const protocolOk = parsed !== null && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    const hostOk = parsed !== null && host.length > 0 && parsed.host.toLowerCase() === host
    if (!protocolOk || !hostOk) {
      return { status: 403, error: '拒绝跨站请求：Origin 与 Host 不一致' }
    }
  }
  const site = req.headers['sec-fetch-site']
  if (site !== undefined) {
    const value = String(site).trim().toLowerCase()
    if (value === 'cross-site' || value === 'same-site') {
      return { status: 403, error: `拒绝跨站请求：Sec-Fetch-Site=${value}` }
    }
  }
  return null
}

/**
 * 请求体超过上限（413）。
 *
 * 为什么要类型化而不是普通 Error：readBody 被 JSON 接口与上传接口共用，只有
 * `route()` 包装层知道该把它翻译成 413 JSON；用 `instanceof` 判定而不是匹配
 * message，避免把 `JSON.parse` 之类的普通错误也误判成「请求体过大」。
 */
class PayloadTooLargeError extends Error {
  /**
   * @param message - 可直接展示给用户的中文文案（不含任何宿主信息）。
   */
  constructor(message = '请求体过大') {
    super(message)
    this.name = 'PayloadTooLargeError'
    /** route() 包装层据此决定状态码。 */
    this.statusCode = 413
  }
}

/**
 * 请求方在读完请求体之前断开（用户取消上传 / 网络中断）。
 *
 * 与「宿主内部错误」区分：连接多半已经没了，写响应没有意义，更不该在
 * 日志里记成「未捕获异常」—— 那只是用户取消了一次上传。route() 收到它时
 * 静默收尾即可。
 */
class RequestAbortedError extends Error {
  constructor(message = '请求已中断') {
    super(message)
    this.name = 'RequestAbortedError'
    this.statusCode = 400
  }
}

/**
 * 读取请求体（带上限）。
 *
 * 三条实现要点：
 *   1. 超限时不调用 req.destroy()：停止累积、记下标记，把剩余字节读完（drain），
 *      再 reject 带 statusCode = 413 的类型化错误。立刻销毁连接会让 413 根本
 *      写不回去，浏览器只看到 fetch failed。
 *   2. 请求方中途断开（aborted / error）时 reject，并消费 error 事件，避免
 *      未处理的 error 变成进程级未捕获异常。
 *   3. Content-Length 预检：声明值已超限就直接 413、不累积字节，但仍
 *      req.resume() 排空请求体，保证 keep-alive 连接安全复用。
 *
 * @param req - http 请求对象。
 * @param limit - 字节上限。
 * @returns Buffer。
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    /** 已结算标记：'end' / 'aborted' / 'error' 可能先后到达，只认第一个。 */
    let settled = false
    let size = 0
    let oversized = false
    const chunks = []

    /**
     * 只结算一次。
     * @param fn - resolve 或 reject。
     * @param value - 传给它的值。
     */
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }

    req.on('data', (chunk) => {
      // 已经超限：后续字节只用于 drain，不再进 chunks，也不再累加 size。
      if (oversized) return
      size += chunk.length
      if (size > limit) {
        oversized = true
        // 已经读到的部分也没必要留着：这次请求注定 413。
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (oversized) settle(reject, new PayloadTooLargeError())
      else settle(resolve, Buffer.concat(chunks))
    })
    // 请求方中途断开：必须消费掉 'error'，否则会变成进程级未捕获异常。
    req.on('aborted', () => settle(reject, new RequestAbortedError()))
    req.on('error', () => settle(reject, new RequestAbortedError()))

    /* Content-Length 预检：声明值已超限时连一个字节都不累积，直接 413。
     * 仍然 req.resume() 把请求体排空 —— 否则 keep-alive 连接里残留的 body
     * 会被当成下一个请求的起始字节。 */
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      oversized = true
      req.resume()
      settle(reject, new PayloadTooLargeError())
    }
  })
}

/**
 * 读取并解析 JSON 请求体。
 * @param req - http 请求对象。
 * @returns 解析后的对象（空体返回 {}）。
 */
async function readJson(req) {
  const buf = await readBody(req, maxJsonBytes())
  if (buf.length === 0) return {}
  return JSON.parse(buf.toString('utf8'))
}

/**
 * 读一个查询参数，返回已经解码一次的值。
 *
 * 不额外 decodeURIComponent：URLSearchParams 内部就是 urlencoded 解析器，
 * 已经做过百分号解码；再解一次会把 encodeURIComponent 产生的 %2520 解成空格，
 * 真实路径变成另一个不存在的路径，随后被安全校验拒成 403。正确链路是
 * 「浏览器编码一次 + searchParams 解码一次」，这里直接用它的结果。
 *
 * 裸 + 按 urlencoded 语义当空格：客户端一律用 encodeURIComponent，文件名里的
 * 真 + 会变成 %2B；只有手工拼未编码 URL 的调用方需要自己写成 %2B。
 * 畸形的 %XX 不会抛错（非法序列原样保留，非法 UTF-8 字节替换成 U+FFFD）。
 *
 * 受益方：/api/image 与 /api/browse 的路径、/api/proxy 里合法的 %20 / %2F。
 *
 * @param req - http 请求对象。
 * @param key - 参数名。
 * @returns 解码一次后的参数值，缺省为空串。
 */
function queryParam(req, key) {
  // undefined 统一成空串，调用方不用再判空。
  return new URL(String(req.url ?? ''), 'http://localhost').searchParams.get(key) ?? ''
}

/* ──────────────────────── 代理目标安全校验（SSRF） ──────────────────────── */

/**
 * 一次代理请求最多跟随几跳重定向。
 *
 * 为什么手动跟随而不是 redirect: 'follow'：follow 由 fetch 内部完成，跳转后的
 * 目标不会再过私网 / 环回校验 —— 公网域名 302 到 http://127.0.0.1:3080 就能
 * 绕过 SSRF 防护。改 manual 后每一跳都回到这里重新解析、重新校验。
 */
const PROXY_MAX_REDIRECTS = 3

/** 单跳代理请求的超时。重定向的总耗时最多是「跳数 × 该值」。 */
const PROXY_TIMEOUT_MS = 20000

/**
 * 测试钩子：只有 `DSH_THEME_STUDIO_ALLOW_LOOPBACK=1` 时才放行 127.0.0.1 / ::1。
 * 生产默认不设置 = 环回地址按私网拒绝。
 *
 * 为什么需要它：本机回归测试要起一个回环地址上的上游 http 服务，而生产环境
 * 必须把环回地址当成 SSRF 目标拒绝。生产环境不要设置这个变量 —— 它只豁免
 * 这两个精确地址，127.0.0.2、10/8、192.168/16 等其它私网仍然拒绝，所以即使
 * 误设，也不会把整个 SSRF 防护关掉。
 *
 * 每次请求都读 process.env 而不是在模块加载时固化：这样测试可以在同一进程里
 * 通过 startHost({ env }) 切换开关，不必为两种策略各写一套代码。
 * @returns 是否放行精确环回地址。
 */
function allowLoopbackForTest() {
  return process.env.DSH_THEME_STUDIO_ALLOW_LOOPBACK === '1'
}

/**
 * 判断一个地址是不是测试钩子允许的精确环回地址。
 * 只认 127.0.0.1 与 ::1，不是整个 127/8，也不放行 IPv4 映射写法。
 * @param address - 已解析出的 IP 字符串。
 * @returns 是否放行。
 */
function isTestHookLoopback(address) {
  const value = String(address).toLowerCase()
  return value === '127.0.0.1' || value === '::1'
}

/**
 * IPv4 是否落在禁止代理的网段，返回中文原因。
 *
 * 覆盖环回、私有、链路本地，以及保留 / 文档 / 组播 / 前缀 0。按第一、二、
 * 三字节手写判断，而不是只查 /8 表：172.16/12、100.64/10、198.18/15 这类
 * 网段的前缀不落在字节边界上。
 * @param address - 点分十进制 IPv4。
 * @returns 禁止原因；公网地址返回 null。
 */
function blockedIPv4Reason(address) {
  const parts = address.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return '地址格式非法'
  }
  const [a, b, c] = parts
  if (a === 0) return '保留地址 0.0.0.0/8'
  if (a === 10) return '私有地址 10.0.0.0/8'
  if (a === 100 && b >= 64 && b <= 127) return '保留地址 100.64.0.0/10'
  if (a === 127) return '环回地址 127.0.0.0/8'
  if (a === 169 && b === 254) return '链路本地地址 169.254.0.0/16'
  if (a === 172 && b >= 16 && b <= 31) return '私有地址 172.16.0.0/12'
  if (a === 192 && b === 0 && c === 0) return '保留地址 192.0.0.0/24'
  if (a === 192 && b === 0 && c === 2) return '文档地址 192.0.2.0/24'
  if (a === 192 && b === 168) return '私有地址 192.168.0.0/16'
  if (a === 198 && (b === 18 || b === 19)) return '保留地址 198.18.0.0/15'
  if (a === 198 && b === 51 && c === 100) return '文档地址 198.51.100.0/24'
  if (a === 203 && b === 0 && c === 113) return '文档地址 203.0.113.0/24'
  if (a >= 224 && a <= 239) return '组播地址 224.0.0.0/4'
  if (a >= 240) return '保留地址 240.0.0.0/4'
  return null
}

/**
 * 把 IPv6 文本展开成 8 个 16 位分组。
 *
 * 手写展开而不是拼字符串查表：fc00::/7、fe80::/10 这些前缀必须按位判断，
 * 而 `::` 压缩、末尾内嵌 IPv4（`::ffff:127.0.0.1`）两种写法都要先归一化。
 * @param address - IPv6 文本（可带 %zone）。
 * @returns 8 个数字；格式非法时返回 null。
 */
function parseIPv6Groups(address) {
  let text = String(address).toLowerCase()
  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)

  // 末尾的 IPv4 先换成两个十六进制分组，后面就只剩纯 IPv6 语法。
  const v4Tail = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (v4Tail !== null) {
    const v4 = v4Tail[2].split('.').map((part) => Number(part))
    if (v4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
    text = `${v4Tail[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`
  }

  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] === '' ? [] : halves[0].split(':')
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : []
  const toNumber = (part) => (/^[0-9a-f]{1,4}$/.test(part) ? parseInt(part, 16) : null)

  if (halves.length === 2) {
    const zeros = 8 - head.length - tail.length
    // `::` 至少要压缩掉一个分组，否则这个写法本身是歧义的。
    if (zeros < 1) return null
    const groups = []
    for (const part of head) {
      const value = toNumber(part)
      if (value === null) return null
      groups.push(value)
    }
    for (let index = 0; index < zeros; index += 1) groups.push(0)
    for (const part of tail) {
      const value = toNumber(part)
      if (value === null) return null
      groups.push(value)
    }
    return groups
  }

  if (head.length !== 8) return null
  const groups = []
  for (const part of head) {
    const value = toNumber(part)
    if (value === null) return null
    groups.push(value)
  }
  return groups
}

/**
 * 判断一个 IP 地址是否属于禁止代理访问的范围。
 *
 * IPv6 里要特别处理 IPv4 映射/兼容地址（`::ffff:127.0.0.1`）：如果只看
 * IPv6 前缀，它会显得「不是环回」，但实际连的就是 127.0.0.1 —— 这是绕过
 * 私网过滤最常见的一种写法。
 * @param address - 已解析出的 IP 字符串。
 * @returns `{ reason }` 表示禁止；公网地址返回 null。
 */
function blockedAddressReason(address) {
  const family = net.isIP(address)
  if (family === 4) {
    const reason = blockedIPv4Reason(address)
    return reason === null ? null : { reason }
  }
  if (family !== 6) return { reason: '无法识别的地址类型' }

  const groups = parseIPv6Groups(address)
  if (groups === null) return { reason: '无法解析的 IPv6 地址' }
  if (groups.every((group) => group === 0)) return { reason: '未指定地址 ::' }
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return { reason: '环回地址 ::1' }

  // IPv4 映射（::ffff:a.b.c.d）与旧式 IPv4 兼容地址（::a.b.c.d）都按 IPv4 规则再判。
  if (groups.slice(0, 5).every((group) => group === 0) && (groups[5] === 0xffff || groups[5] === 0)) {
    const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`
    const reason = blockedIPv4Reason(v4)
    if (reason !== null) return { reason: `IPv4 映射地址 ${v4}（${reason}）` }
  }

  if ((groups[0] & 0xff00) === 0xff00) return { reason: 'IPv6 组播地址 ff00::/8' }
  if ((groups[0] & 0xfe00) === 0xfc00) return { reason: 'IPv6 唯一本地地址 fc00::/7' }
  if ((groups[0] & 0xffc0) === 0xfe80) return { reason: 'IPv6 链路本地地址 fe80::/10' }
  return null
}

/**
 * 校验代理 URL 的「字面部分」：协议、凭据、主机名。
 * 不查 DNS，因此可以同时用于首跳和每一跳重定向。
 * @param url - URL 对象。
 * @returns `{ ok: true, url }` 或 `{ ok: false, status, error }`。
 */
function validateProxyTarget(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, status: 400, error: '只代理 http/https 链接' }
  }
  // 带凭据的 URL 会把 Authorization 发给目标，且经常被用来绕过按 hostname 的过滤。
  if (url.username !== '' || url.password !== '') {
    return { ok: false, status: 403, error: '拒绝代理带用户名或密码的 URL' }
  }
  if (url.hostname.length === 0) {
    return { ok: false, status: 400, error: 'URL 缺少主机名' }
  }
  return { ok: true, url }
}

/**
 * 解析用户传入的 url 参数。
 * @param raw - 查询参数原值。
 * @returns 校验结果。
 */
function parseProxyUrl(raw) {
  const text = String(raw ?? '').trim()
  if (text.length === 0) return { ok: false, status: 400, error: '缺少 url 参数' }
  let url
  try {
    url = new URL(text)
  } catch {
    return { ok: false, status: 400, error: 'URL 不合法，只代理 http/https 链接' }
  }
  return validateProxyTarget(url)
}

/**
 * 从异常里取一个可对外暴露的机器可读错误码。
 *
 * 只接受大写字母 / 数字 / 下划线组成的短字符串（ECONNREFUSED、ENOTFOUND、
 * UND_ERR_CONNECT_TIMEOUT）。error.message 通常带主机名、内网 IP、端口，
 * 一律不进响应体：错误文案本身就是内网端口/服务探测器。
 * @param error - 捕获到的异常。
 * @returns 错误码；取不到或格式不可信时返回 null。
 */
function safeErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : error?.cause?.code
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code)) return code
  return null
}

/**
 * 代理失败的对外响应：只保留「拉取失败」与可选错误码。
 *
 * 为什么不复用原始 message：undici/DNS 的报错会带上目标地址、内网 IP、端口
 * （`connect ECONNREFUSED 127.0.0.1:54321`），直接回给浏览器就是信息泄露。
 * 原始异常只写宿主日志（logProxyFailure）。
 * @param error - 捕获到的异常（可为 null）。
 * @param status - HTTP 状态码，默认 502。
 * @returns `{ ok:false, status, error, code? }`。
 */
function proxyFailure(error, status = 502) {
  const failure = { ok: false, status, error: '拉取失败' }
  const code = safeErrorCode(error)
  if (code !== null) failure.code = code
  return failure
}

/**
 * 把一次代理失败的完整原因写进宿主日志（响应体里只给泛化文案）。
 * @param context - 发生了什么，例如「域名解析失败：example.com」。
 * @param error - 捕获到的异常。
 */
function logProxyFailure(context, error) {
  const code = safeErrorCode(error)
  const suffix = code === null ? '' : `（${code}）`
  console.warn(`[dsh-theme-studio] ${context}${suffix}：${String(error?.message ?? error)}`)
}

/**
 * 解析目标主机名的全部地址并逐个校验，任何一个是内网/保留地址就整体拒绝。
 *
 * 为什么必须 all: true：一个域名可能同时返回公网与内网地址，只查第一条会被
 * 轮询 / 多 A 记录绕过；也不做「优先公网」的挑选 —— 有一条脏记录就说明目标
 * 不可信。
 *
 * 出站 SSRF 的 TOCTOU 残余风险（不假装已解决）：这里 lookup 一次做校验，随后
 * fetch/undici 会再解析一次域名，两次解析之间权威 DNS 可以换答案：攻击者让
 * 第一次回答公网、第二次回答 127.0.0.1。彻底消除需要固定 IP 的连接（自定义
 * dispatcher 或 https.request 自行处理 SNI 与 Host），暂不引入这种复杂度。
 * 所以本防护挡住「直接填内网地址」「重定向到内网」这类主流 SSRF，不承诺免疫
 * 这种两次解析的绕过。注意这是出站代理面；入站请求的 DNS rebinding 由入口的
 * Host 白名单单独负责（见 rejectDisallowedHost），不要彼此混淆。
 *
 * @param url - 已通过字面校验的 URL。
 * @param allowLoopback - 是否放行精确环回地址（仅本地测试钩子）。
 * @returns `{ ok: true }` 或 `{ ok: false, status, error }`。
 */
async function resolveProxyTarget(url, allowLoopback) {
  let hostname = url.hostname
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1)
  if (hostname.length === 0) return { ok: false, status: 400, error: 'URL 缺少主机名' }

  let addresses
  try {
    addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true })
  } catch (error) {
    logProxyFailure(`域名解析失败：${hostname}`, error)
    return proxyFailure(error)
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    console.warn(`[dsh-theme-studio] 域名解析失败：${hostname} 没有可用地址`)
    return proxyFailure(null)
  }

  for (const item of addresses) {
    const address = String(item?.address ?? '')
    const blocked = blockedAddressReason(address)
    if (blocked === null) continue
    // 测试钩子只豁免 127.0.0.1 / ::1；10/8、169.254/16 等仍然在这里被拒。
    if (allowLoopback && isTestHookLoopback(address)) continue
    return {
      ok: false,
      status: 403,
      // 不回报「主机名 → 地址」：那串东西会被跨站请求当成内网地址/端口探测器。
      // 网段说明足够用户定位，具体地址只进宿主日志。
      error: `拒绝访问内网或保留地址（${blocked.reason}）`,
    }
  }
  return { ok: true }
}

/* ──────────────────────────── 位图文件头识别 ──────────────────────────── */

/**
 * 按文件头识别位图类型（magic bytes），上传与代理回源共用。
 *
 * 只认位图：SVG 是「可执行文档」而不是图片，能在同源下跑脚本，所以即使上游
 * 把类型写成 image/svg+xml 也绝不回吐。上游 Content-Type 只用于快速拒绝，
 * 最终类型必须以文件头为准 —— 服务器把 PNG 标成 text/html、把 HTML 标成
 * image/png 都很常见。缓存文件名用这里返回的扩展名，绝不拼上游头的值。
 *
 * @param buffer - 响应体。
 * @returns `{ mime, ext }`；不是白名单位图时返回 null。
 */
function sniffBitmap(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) return null

  // JPEG 魔数：FF D8 FF
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', ext: '.jpg' }
  }
  // PNG 魔数：89 50 4E 47
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { mime: 'image/png', ext: '.png' }
  }
  // GIF 魔数：GIF87a / GIF89a
  if (buffer.length >= 6) {
    const signature = buffer.toString('ascii', 0, 6)
    if (signature === 'GIF87a' || signature === 'GIF89a') return { mime: 'image/gif', ext: '.gif' }
  }
  // WEBP 魔数：RIFF....WEBP
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: '.webp' }
  }
  // BMP 魔数：'BM'
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return { mime: 'image/bmp', ext: '.bmp' }
  // AVIF：ISO BMFF 的 ftyp box，major brand 或 compatible brand 为 avif/avis。
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const declaredSize = buffer.readUInt32BE(0)
    const end = Math.min(declaredSize >= 16 ? declaredSize : buffer.length, buffer.length)
    const brands = [buffer.toString('ascii', 8, 12)]
    for (let offset = 16; offset + 4 <= end; offset += 4) {
      brands.push(buffer.toString('ascii', offset, offset + 4))
    }
    if (brands.some((brand) => brand === 'avif' || brand === 'avis')) {
      return { mime: 'image/avif', ext: '.avif' }
    }
  }
  return null
}

/* ─────────────────────────── 上传目录配额 ─────────────────────────── */

/**
 * 统计上传目录的「直接子文件」数量与总字节。
 *
 * 只扫直接子级、忽略子目录：上传接口只会往这一层写文件，子目录是用户或别的
 * 程序自己放的，不该算进配额（也不该在这里被递归读取，否则一个大目录会把
 * 每次上传都拖慢）。目录不存在视为 0 个 / 0 字节 —— 首次上传本来就要 mkdir。
 *
 * 读不出来的文件（共享冲突、刚被删）不计入，避免统计本身成为上传的故障点：
 * 少算一个文件最多让配额略微放宽，而拒绝上传会让用户以为插件坏了。
 *
 * @returns `{ files, bytes }`。
 */
async function uploadUsage() {
  let entries
  try {
    entries = await fsp.readdir(UPLOAD_DIR, { withFileTypes: true })
  } catch {
    return { files: 0, bytes: 0 }
  }
  let files = 0
  let bytes = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    files += 1
    try {
      bytes += (await fsp.stat(path.join(UPLOAD_DIR, entry.name))).size
    } catch {
      /* 单文件 stat 失败不影响其它文件的统计 */
    }
  }
  return { files, bytes }
}

/**
 * 上传「查配额 → 写盘」的串行队列。
 *
 * 与配置写队列同理：配额是「先读用量、再写文件」的读改写序列，两个并发上传
 * 都读到旧用量就会双双通过、一起越过上限。串行化只覆盖这两步，请求体读取
 * （可能几十 MB）发生在队列之外，不互相阻塞。
 */
let uploadWriteChain = Promise.resolve()

/**
 * 把一个「查配额 + 写盘」任务排进上传队列。
 * @param task - 返回 Promise 的任务。
 * @returns 该任务自己的 Promise（异常原样抛给调用方）。
 */
function enqueueUploadWrite(task) {
  const run = uploadWriteChain.then(task)
  uploadWriteChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/* ──────────────────────── 插件自有副本的清理 ──────────────────────── */

/**
 * 估算一个目录项的字节数：文件取 size，目录递归求和，符号链接不跟随。
 *
 * 为什么需要它：`removedBytes` 是给用户看的「这次清掉多少」，目录也必须有人算。
 * 为什么用 lstat 而不是 stat：`fsp.rm` 对符号链接只删链接本身，跟着链接去数目标
 * 文件会把「删了 2KB」报成「删了 2GB」；不跟随还能避免顺着 junction 走遍全盘。
 * 任何一级 stat/readdir 失败都按 0 算（允许近似，清理本身就是 best-effort）。
 *
 * @param full - 待估算的绝对路径。
 * @returns 字节数（读不出来时为 0）。
 */
async function measureEntryBytes(full) {
  let stat
  try {
    stat = await fsp.lstat(full)
  } catch {
    return 0
  }
  if (stat.isFile()) return stat.size
  if (!stat.isDirectory()) return 0
  let entries
  try {
    entries = await fsp.readdir(full, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) total += await measureEntryBytes(path.join(full, entry.name))
  return total
}

/**
 * 删除插件自己产生的两类本地副本：上传目录与 URL 缓存目录的**直接子项**。
 *
 * 这是 `/api/purge-cache` 与 `/api/reset?purgeFiles:true` 共用的唯一实现 ——
 * 两份复制迟早会漂移（其中一份忘了 recursive、忘了单条容错，用户就会看到
 * 「清理了但还剩几个文件」）。
 *
 * 边界（必须保持不变）：
 *   - 只碰 `UPLOAD_DIR` / `URL_CACHE_DIR` 的直接子项；子项是目录时整体递归删；
 *   - **绝不读取或改写配置**：purge 只清副本，调用方要重置配置是另一件事；
 *   - 用户登记目录里的原图完全不碰 —— 它们根本不在这两个目录里；
 *   - 单条删除失败不整体失败：删不掉的条目留在盘上，`removedFiles` 不虚报。
 *
 * 与上传配额的关系：配额是每次上传现算 `uploadUsage()`，没有额外缓存，所以
 * 这里删完文件后配额自然释放，不需要（也不应该）维护新的状态。
 *
 * @returns `{ removedFiles, removedBytes }`。removedFiles 按实际删掉的直接子项
 *   （文件或目录）计数；removedBytes 是删除前统计到的文件字节总和（允许近似）。
 */
async function purgeCacheFiles() {
  let removedFiles = 0
  let removedBytes = 0
  for (const dir of [UPLOAD_DIR, URL_CACHE_DIR]) {
    let entries = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue // 目录不存在 / 不可读 = 没有可删的，不算失败
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      // 先量体积再删：删完就什么都没得 stat 了。
      removedBytes += await measureEntryBytes(full)
      try {
        await fsp.rm(full, { recursive: true, force: true })
        removedFiles += 1
      } catch {
        /* 单个条目删不掉不影响其它条目，也不影响调用方 */
      }
    }
  }
  return { removedFiles, removedBytes }
}

/* ──────────────────────── 远程壁纸的本地缓存 ──────────────────────── */

/** 缓存数据文件允许的扩展名白名单（meta 里的 ext 必须命中它才参与路径拼接）。 */
const CACHE_EXT = new Set(['.jpg', '.png', '.gif', '.webp', '.bmp', '.avif'])

/**
 * 缓存有效期 24 小时。
 *
 * 没有 TTL 会让「远端换了图」永远看不到。过期按未命中回源；回源失败才报 502，
 * 宁可报错也不展示过期内容。
 */
const URL_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** 缓存最多保留多少个 URL。 */
const URL_CACHE_MAX_ENTRIES = 128

/** 缓存数据总大小上限：512 MB（数据文件，不含 meta）。 */
const URL_CACHE_MAX_BYTES = 512 * 1024 * 1024

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
 *
 * 这里只负责 JSON 解析，不信任任何字段：ext 白名单、TTL、magic 都交给
 * readCacheEntry 校验。解析失败时返回 `{ corrupt: true }` 而不是 null，
 * 这样调用方能把「没有缓存」与「缓存坏了」区分开，后者必须删除。
 * @param base - cacheFileFor 的返回值。
 * @returns meta 对象；文件不存在时返回 null。
 */
async function readCacheMeta(base) {
  let text
  try {
    text = await fsp.readFile(`${base}.json`, 'utf8')
  } catch {
    /* 没有 meta 就当未缓存 */
    return null
  }
  try {
    const meta = JSON.parse(text)
    if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) return meta
  } catch {
    /* 半截/损坏的 JSON 也要走删除分支 */
  }
  return { corrupt: true }
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

/**
 * 读取一份**可信**的缓存：meta、扩展名、有效期、文件头 magic 全部通过才返回。
 *
 * 为什么读缓存还要再验一遍 magic：url-cache 是磁盘目录，可能被旧版本写脏、
 * 被别的程序改坏，也可能被投毒（比如把 meta.ext 改成 `../../config.json`
 * 来诱导路径拼接）。任何一项不合法都当未命中并删掉，宁可回源重下。
 *
 * @param url - 目标 URL 字符串（与配置里保存的一致，作缓存键）。
 * @param base - cacheFileFor(url)。
 * @returns `{ buffer, mime, ext }` 或 null。
 */
async function readCacheEntry(url, base) {
  const meta = await readCacheMeta(base)
  if (meta === null) return null

  // 损坏的 JSON 与白名单之外的 ext 都不能参与路径拼接；命中即删除整个缓存条目。
  if (meta.corrupt === true || !CACHE_EXT.has(meta.ext)) {
    await dropCache(url)
    return null
  }
  const fetchedAt = Number(meta.fetchedAt)
  if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > URL_CACHE_TTL_MS) {
    await dropCache(url)
    return null
  }

  let buffer
  try {
    buffer = await fsp.readFile(`${base}${meta.ext}`)
  } catch {
    await dropCache(url)
    return null
  }
  const sniffed = sniffBitmap(buffer)
  // meta.ext 与 magic 不一致 = 缓存被替换过；不能把未知内容当图片回吐。
  if (sniffed === null || sniffed.ext !== meta.ext) {
    await dropCache(url)
    return null
  }
  return { buffer, mime: sniffed.mime, ext: sniffed.ext }
}

/** 缓存写入失败的告警是否已经打过。 */
let cacheWriteWarningShown = false

/**
 * 缓存写失败时告警一次。
 *
 * 为什么只告警一次：这个函数在图片回吐路径上，缓存目录只读/磁盘满时每个请求
 * 都会失败，逐次 console.warn 会把日志刷爆。但完全静默又会让「每次刷新都在
 * 重新下载」无从排查，所以保留第一条，并在文案里说明后续不再提示。
 * @param error - 写入异常。
 */
function warnCacheWriteFailure(error) {
  if (cacheWriteWarningShown) return
  cacheWriteWarningShown = true
  console.warn(
    `[dsh-theme-studio] 远程壁纸缓存写入失败，本次仍直接回吐图片；后续同类失败不再提示：${String(error?.message ?? error)}`,
  )
}

/**
 * 按 fetchedAt 淘汰最旧缓存，保证「URL 数 ≤ 128 且总大小 ≤ 512MB」。
 *
 * 为什么每次写入后都跑：缓存是用户点开一张图就长一点，没有主动清理入口；
 * 只在启动时清理意味着长会话会无限膨胀。扫描量最多是 128+ 个 meta，
 * 一次 readdir + stat 足够轻量。
 *
 * @returns 实际删掉的条目数。
 */
async function pruneUrlCache() {
  let entries
  try {
    entries = await fsp.readdir(URL_CACHE_DIR)
  } catch {
    return 0
  }

  const records = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const jsonPath = path.join(URL_CACHE_DIR, entry)
    let meta
    try {
      meta = JSON.parse(await fsp.readFile(jsonPath, 'utf8'))
    } catch {
      continue
    }
    const stem = entry.slice(0, -'.json'.length)
    // meta.ext 不可信：只有命中白名单才允许拼出数据文件名。
    const ext = typeof meta?.ext === 'string' && CACHE_EXT.has(meta.ext) ? meta.ext : null
    let bytes = Number.isFinite(meta?.bytes) ? Number(meta.bytes) : 0
    if (ext !== null) {
      try {
        bytes = (await fsp.stat(path.join(URL_CACHE_DIR, `${stem}${ext}`))).size
      } catch {
        bytes = 0
      }
    }
    records.push({
      stem,
      ext,
      bytes,
      fetchedAt: Number.isFinite(meta?.fetchedAt) ? Number(meta.fetchedAt) : 0,
    })
  }

  // 最旧的在前面；没有 fetchedAt 的旧条目按 0 处理，优先淘汰。
  records.sort((a, b) => a.fetchedAt - b.fetchedAt)
  let count = records.length
  let totalBytes = records.reduce((sum, record) => sum + record.bytes, 0)
  let removed = 0
  for (const record of records) {
    if (count <= URL_CACHE_MAX_ENTRIES && totalBytes <= URL_CACHE_MAX_BYTES) break
    if (record.ext !== null) {
      await fsp.rm(path.join(URL_CACHE_DIR, `${record.stem}${record.ext}`), { force: true }).catch(() => {})
    }
    await fsp.rm(path.join(URL_CACHE_DIR, `${record.stem}.json`), { force: true }).catch(() => {})
    count -= 1
    totalBytes -= record.bytes
    removed += 1
  }
  return removed
}

/**
 * 把一次成功回源的位图写入缓存。
 *
 * 写入失败**不影响本次回吐**：用户要的是壁纸，缓存只是加速与「可删除副本」，
 * 不能因为磁盘满就让图片也看不了。但失败必须留下告警（只一次），否则
 * 「为什么每次刷新都在下载」没有线索。
 * @param url - 目标 URL 字符串（与配置里保存的一致，作缓存键）。
 * @param base - cacheFileFor(url)。
 * @param entry - `{ buffer, mime, ext }`，ext/mime 均来自文件头识别。
 */
async function writeCacheEntry(url, base, entry) {
  const meta = {
    url,
    type: entry.mime,
    ext: entry.ext,
    bytes: entry.buffer.length,
    fetchedAt: Date.now(),
  }
  try {
    await fsp.mkdir(URL_CACHE_DIR, { recursive: true })
    await fsp.writeFile(`${base}${entry.ext}`, entry.buffer)
    await fsp.writeFile(`${base}.json`, JSON.stringify(meta), 'utf8')
  } catch (error) {
    // 半截写入（数据已落、meta 失败）会留下无法验证的孤儿文件，顺手清掉。
    await Promise.allSettled([
      fsp.rm(`${base}${entry.ext}`, { force: true }),
      fsp.rm(`${base}.json`, { force: true }),
    ])
    warnCacheWriteFailure(error)
    return
  }

  try {
    await pruneUrlCache()
  } catch {
    /* 淘汰失败不影响本次回吐；下次写入会再试 */
  }
}

/* ──────────────────────────── 代理回源与回吐 ──────────────────────────── */

/**
 * 代理成功响应的安全头（200 与 304 都必须带）。
 *
 * - nosniff：禁止浏览器把位图「猜」成别的类型执行；
 * - attachment：这张图只作 CSS 背景，不该被当文档直接打开 —— 即使 magic
 *   识别有漏网之鱼，下载语义也能阻止它进入文档上下文；
 * - CSP sandbox + default-src 'none'：万一将来出现能内联执行的格式，
 *   也拿不到脚本/网络能力；
 * - Cache-Control：只让浏览器短期复用 5 分钟，长期缓存由宿主 url-cache 负责。
 */
const PROXY_IMAGE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Disposition': 'attachment; filename="wallpaper"',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cache-Control': 'private, max-age=300',
}

/**
 * 校验并读取上游响应体，最终以文件头决定类型。
 *
 * 处理顺序刻意是「先快速拒绝、再完整读取、最后 magic 判定」：
 *   - 上游声明 image/svg+xml → 直接 415，连 body 都不读完（SVG 即使 magic
 *     判不出来也必须拒，这是同源 XSS 的入口）；
 *   - 声明长度过大 → 413，避免先下载再发现超限；
 *   - 其余情况读完后按 magic 判定，上游头不参与最终 Content-Type。
 *
 * @param response - fetch 返回的成功响应。
 * @returns `{ ok: true, buffer, mime, ext }` 或 `{ ok: false, status, error }`。
 */
async function readProxyImage(response) {
  const upstreamType = String(response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (upstreamType === 'image/svg+xml' || upstreamType.startsWith('image/svg')) {
    await response.body?.cancel().catch(() => {})
    return { ok: false, status: 415, error: '拒绝 SVG：壁纸代理只接受 JPEG/PNG/GIF/WEBP/BMP/AVIF 位图' }
  }

  const declared = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    await response.body?.cancel().catch(() => {})
    return { ok: false, status: 413, error: `图片过大：超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB 上限` }
  }

  let buffer
  try {
    buffer = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    logProxyFailure('读取上游响应失败', error)
    return proxyFailure(error)
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    return { ok: false, status: 413, error: `图片过大：超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB 上限` }
  }

  const sniffed = sniffBitmap(buffer)
  if (sniffed === null) {
    return { ok: false, status: 415, error: '不是受支持的位图（只接受 JPEG/PNG/GIF/WEBP/BMP/AVIF），已拒绝' }
  }
  return { ok: true, buffer, mime: sniffed.mime, ext: sniffed.ext }
}

/**
 * 手动跟随重定向地抓取上游图片。
 *
 * 每一跳都重新做「协议/凭据 → DNS 全地址 → 私网判定」，并且 `redirect: 'manual'`
 * 保证 fetch 不会自己偷偷跟到内网。最多 `PROXY_MAX_REDIRECTS` 跳，超过直接 502。
 *
 * 关于出站 SSRF 的两次解析 TOCTOU：resolveProxyTarget 的注释里写明了 lookup 与
 * fetch 之间仍有窗口；本函数按「每次连接前都重新校验」实现，属于纵深防御而不是
 * 绝对隔离。入站请求的 DNS rebinding 由 Host 白名单负责，不依赖这里。
 *
 * @param startUrl - 首跳 URL 对象。
 * @returns `{ ok: true, buffer, mime, ext }` 或 `{ ok: false, status, error }`。
 */
async function fetchProxyUpstream(startUrl) {
  const allowLoopback = allowLoopbackForTest()
  let current = startUrl

  for (let hop = 0; hop <= PROXY_MAX_REDIRECTS; hop += 1) {
    const target = validateProxyTarget(current)
    if (!target.ok) {
      // 首跳的 400（参数写错）保留；重定向目标非法说明上游行为不可信，归为 502。
      return {
        ...target,
        status: hop === 0 ? target.status : 502,
        error: `${hop === 0 ? '' : '重定向目标不合法：'}${target.error}`,
      }
    }
    const resolved = await resolveProxyTarget(current, allowLoopback)
    if (!resolved.ok) {
      return { ...resolved, error: `${hop === 0 ? '' : '重定向目标被拒绝：'}${resolved.error}` }
    }

    let response
    try {
      response = await fetch(current.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
        headers: { accept: 'image/*' },
      })
    } catch (error) {
      logProxyFailure('拉取上游图片失败', error)
      return proxyFailure(error)
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      // 重定向响应体没有用，先取消掉，避免占着连接。
      await response.body?.cancel().catch(() => {})
      if (location === null) {
        return { ok: false, status: 502, error: `上游返回 ${response.status} 重定向但没有 Location` }
      }
      if (hop === PROXY_MAX_REDIRECTS) {
        return { ok: false, status: 502, error: `重定向超过 ${PROXY_MAX_REDIRECTS} 跳，已停止` }
      }
      let next
      try {
        next = new URL(location, current)
      } catch {
        return { ok: false, status: 502, error: '上游重定向的 Location 不是合法 URL' }
      }
      current = next
      continue
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      return { ok: false, status: 502, error: `上游返回 ${response.status}` }
    }
    return await readProxyImage(response)
  }

  // 循环上限之外还有重定向（理论到不了这里，保留明确的失败出口）。
  return { ok: false, status: 502, error: `重定向超过 ${PROXY_MAX_REDIRECTS} 跳，已停止` }
}

/**
 * 回吐一张代理图片：安全头 + 识别出的 Content-Type + ETag/304。
 *
 * Content-Type 只来自 sniffBitmap 的结果，绝不回显上游头 —— 上游把 HTML 标成
 * image/png 时，回显就会制造同源 HTML 文档。
 *
 * ETag 必须由**响应体内容**算出，不能掺 URL 或长度：url-cache 按 URL 保留 24h，
 * 上游完全可能重新压缩、同尺寸换图 —— 字节数一模一样但像素已经变了。若标签
 * 只看 URL + 长度，这种更新会永远命中旧 ETag，浏览器只拿到 304 空 body，最长
 * 24 小时看不到新图。sha1(buffer) 让「同长度不同内容」必然产生新标签。
 *
 * 协商直接复用 ifNoneMatchHits：它已按 RFC 9110 处理 `*`、`W/` 弱比较与逗号
 * 分隔多值，并与 /api/image 共用同一套语义；这里不能再写一份精确字符串比较，
 * 否则弱标签和多值列表又会漏判。
 *
 * @param req - http 请求（用于 If-None-Match）。
 * @param res - http 响应。
 * @param entry - `{ buffer, mime }`。
 */
function sendProxyImage(req, res, entry) {
  const buffer = entry.buffer
  const etag = `"${crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16)}"`
  if (ifNoneMatchHits(req.headers['if-none-match'], etag)) {
    // 304 不带 body，但安全头与 ETag 必须和 200 一致：否则浏览器可能沿用一份未硬化的旧响应。
    res.writeHead(304, { ...PROXY_IMAGE_HEADERS, ETag: etag })
    res.end()
    return
  }
  res.writeHead(200, {
    ...PROXY_IMAGE_HEADERS,
    'Content-Type': entry.mime,
    'Content-Length': String(buffer.length),
    ETag: etag,
  })
  res.end(buffer)
}

/* ────────────────────────────── 插件主体 ────────────────────────────── */

/**
 * 插件入口：注册全部宿主路由。
 * @param ctx - cordis 上下文（已注入 webServer）。
 */
export function apply(ctx) {
  /** 已注册的清理函数。 @type {(() => void)[]} */
  const disposers = []

  /**
   * 注册一条前缀路由（所有请求的统一入口）。
   *
   * 顺序：Host 白名单 → 方法白名单 → 写方法安全闸门 → JSON Content-Type →
   * HEAD 去 body → handler → 错误映射。
   *   - Host 缺失/不在允许名单 → 403「Host 不被允许」，发生在任何读配置、
   *     读盘、写盘之前（第一步就挡 DNS rebinding）；
   *   - 方法不在声明列表 → 405 + Allow 头，并排空请求体；
   *   - 非 GET/HEAD → Origin / Sec-Fetch-Site 校验（见 rejectUnsafeRequest）；
   *   - 声明 jsonBody 且带请求体 → 必须是 application/json，否则 415；
   *   - HEAD 复用 GET 的业务逻辑，只吞掉响应体，响应头照常发出；
   *   - PayloadTooLargeError → 413；RequestAbortedError → 静默收尾；
   *     ConfigCorruptError → 500 + `code:'CONFIG_CORRUPT'` + 固定中文文案；
   *     其它异常 → 500「内部错误」，message 只进日志。
   * 插件不做身份认证：Host 白名单挡 DNS rebinding，写方法闸门挡 CSRF；访问控制
   * 仍依赖宿主 webServer 的部署边界。
   *
   * @param sub - 前缀之后的路径，例如 '/api/config'。
   * @param handler - 处理函数。
   * @param options - `{ methods?: string[], jsonBody?: boolean }`。
   */
  const route = (sub, handler, options = {}) => {
    const methods = options.methods ?? ['GET', 'HEAD']
    const allow = methods.join(', ')
    const jsonBody = options.jsonBody === true
    disposers.push(
      ctx.webServer.register({
        kind: 'prefix',
        path: `${ROUTE_PREFIX}${sub}`,
        handler: async (req, res) => {
          try {
            /* 第一道门：Host 白名单。必须早于方法判断与 handler —— 后者会读配置、
             * 扫目录、写盘，而 DNS rebinding 的请求在方法/Origin 层看起来完全正常。 */
            const hostRejection = rejectDisallowedHost(req)
            if (hostRejection !== null) {
              req.resume()
              sendJson(res, hostRejection.status, { ok: false, error: hostRejection.error })
              return
            }
            const method = String(req.method ?? 'GET').toUpperCase()
            if (!methods.includes(method)) {
              res.setHeader('Allow', allow)
              // 405 也要把请求体排空，否则 keep-alive 连接里残留的 body 会串到下一个请求。
              req.resume()
              sendJson(res, 405, { ok: false, error: `不支持的方法 ${method}，仅允许 ${allow}` })
              return
            }
            if (!SAFE_METHODS.has(method)) {
              const rejection = rejectUnsafeRequest(req)
              if (rejection !== null) {
                req.resume()
                sendJson(res, rejection.status, { ok: false, error: rejection.error })
                return
              }
              if (jsonBody && hasRequestBody(req) && !isJsonContentType(req.headers['content-type'])) {
                req.resume()
                sendJson(res, 415, { ok: false, error: '该接口要求 Content-Type: application/json' })
                return
              }
            }
            if (method === 'HEAD') {
              // HEAD 与 GET 共用业务逻辑，但响应体必须为空：只吞掉 res.end 的 body 参数，
              // handler 写出的响应头（Content-Type / Content-Length 等）照常保留。
              const end = res.end
              res.end = function endWithoutBody() {
                return end.call(this)
              }
            }
            await handler(req, res)
          } catch (error) {
            /* readBody 的「请求体过大」必须在路由层翻译成 413 JSON：一旦连接被
             * 销毁，这里就没有机会写响应了。 */
            if (error instanceof PayloadTooLargeError) {
              if (!res.headersSent) sendJson(res, error.statusCode, { ok: false, error: error.message })
              return
            }
            /* 客户端主动断开：没有可写的响应，也不该按宿主内部错误记日志。 */
            if (error instanceof RequestAbortedError) return
            /* 配置损坏是确定的、可恢复的状态：必须把 code 与不含路径的中文文案交
             * 给客户端，否则用户只看到「内部错误」，不知道该去重置。文案在生成时
             * 已保证只有备份文件基名，所以这里可以安全地回显。 */
            if (error instanceof ConfigCorruptError) {
              if (!res.headersSent) {
                sendJson(res, 500, { ok: false, code: error.code, error: error.message })
              } else {
                try {
                  res.end()
                } catch {
                  /* 连接可能已断开 */
                }
              }
              return
            }
            if (!res.headersSent) {
              // 不在响应里回显 error.message：它通常带宿主绝对路径。
              // 这里只能用 req.method：上面 try 块里的 `method` 是块级 const，catch 里不可见。
              sendInternalError(res, error, `处理 ${String(req.method ?? 'GET')} ${sub} 时发生未捕获异常`)
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
   * 收集当前允许读取图片的根目录：登记的文件夹 + 上传目录。
   *
   * 上传目录无条件算根：上传副本必须能回吐给面板。
   * @returns 根目录数组。
   */
  const allowedRoots = () => {
    const config = readConfig()
    const roots = [...(config.wallpaper?.folders ?? []), UPLOAD_DIR]
    return roots.filter((item) => typeof item === 'string' && item.length > 0)
  }

  /* ── 健康检查 ──
   *
   * GET / HEAD → 200 `{ ok, plugin, version }`。只回报版本、不回 dataDir：
   * 绝对路径对客户端无用，还会泄露宿主目录结构。
   */
  route('/api/ping', (req, res) => {
    sendJson(res, 200, { ok: true, plugin: name, version: PLUGIN_VERSION })
  }, { methods: ['GET', 'HEAD'] })

  /* ── 配置读写 ──
   *
   * GET → 200 `{ ok, config }`，等首次读盘触发的迁移/清理落盘完成再响应；
   * PUT/POST（JSON patch）→ 200 `{ ok, config }`，深合并后原子落盘，不是整体替换。
   * 配置损坏时一律 500 `{ ok:false, code:'CONFIG_CORRUPT', error }`，绝不回默认值：
   * 默认值一旦落盘就覆盖了用户仅存的原始数据，恢复只能走 /api/reset。
   * 输入错误 400/413 原样回中文文案，其余异常 500 脱敏。删键只能走 /api/reset。
   */
  route('/api/config', async (req, res) => {
    if (req.method === 'PUT' || req.method === 'POST') {
      let next
      try {
        const patch = await readJson(req)
        next = await writeConfig(patch)
      } catch (error) {
        // 只有我们自己构造的输入错误可以原样回文案；其余异常交给 route() 统一 500 脱敏。
        if (error instanceof ConfigInputError) {
          sendJson(res, error.status, { ok: false, error: error.message })
          return
        }
        throw error
      }
      sendJson(res, 200, { ok: true, config: next })
      return
    }
    const config = readConfig()
    // 首次读盘可能触发「迁移 / 清理」的落盘。等写完再响应：否则客户端拿到的
    // 配置与磁盘上的可能不是同一份。
    await configPersistPending
    sendJson(res, 200, { ok: true, config })
  }, { methods: ['GET', 'HEAD', 'PUT', 'POST'], jsonBody: true })

  /* ── 目录浏览：给「选择文件夹」用的服务器端目录列表 ──
   *
   * GET ?path=<绝对路径>（空 = 主目录）→ 200 `{ ok, path, parent, dirs, imageCount }`。
   * 只回目录名与图片数量，不回图片列表（图片走 /api/folders 扫描）；dirs 最多 500 条。
   * 白名单：主目录、登记目录，以及它们的严格祖先（不含盘根），并用 realpath 复核；
   * 越界 403，目录读不出来 200 + ok:false（客户端按 body.ok 判断，不用状态码区分）。
   * 失败文案不带宿主绝对路径。
   * ─────────────────────────────────────────────────────────────── */
  route('/api/browse', async (req, res) => {
    const input = queryParam(req, 'path')
    const allowed = await resolveBrowseTarget(input)
    if (allowed.ok !== true) {
      sendJson(res, 403, { ok: false, error: '该目录不在允许浏览的范围内，请直接在上方输入绝对路径' })
      return
    }
    const target = allowed.target
    let entries
    try {
      entries = await fsp.readdir(target, { withFileTypes: true })
    } catch (error) {
      // 只给泛化文案 + 机器可读 code：error.message 里几乎总带着完整绝对路径。
      // 状态码保持 200 + ok:false：客户端按 body.ok 判断，换状态码会落进通用
      // 失败提示，而不是这句可操作的中文。
      const payload = { ok: false, error: '无法读取该目录' }
      if (typeof error?.code === 'string') payload.code = error.code
      sendJson(res, 200, payload)
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
    const parent = path.dirname(target)
    // 上一级只在仍处于白名单内时才给：否则面板会渲染出一个必然 403 的按钮。
    // 盘根没有上一级，同样返回 null（保持原有字段形状）。
    const parentAllowed = parent !== target && isBrowseAllowed(parent, allowed.roots)
    sendJson(res, 200, {
      ok: true,
      path: target,
      parent: parentAllowed ? parent : null,
      dirs: dirs.slice(0, 500),
      imageCount: images.length,
    })
  }, { methods: ['GET', 'HEAD'] })

  /* ── 目录扫描：把登记目录里的图片列成候选墙 ──
   *
   * GET → 200 `{ ok, limit, groups }`；每组 `{ folder, exists, count, scanned,
   * truncated, items }`，上传目录有图时额外一组 uploads:true。
   * limit 是本次每组的上限；truncated 表示该组被截断、结果可能不完整。
   * 只读目录、不改配置；候选的「移除」是前端会话状态（恰好清空当前选择时会落盘）。
   */
  route('/api/folders', async (req, res) => {
    const config = readConfig()
    const folders = (config.wallpaper?.folders ?? []).filter((item) => typeof item === 'string' && item.length > 0)
    const recursive = config.wallpaper?.recursive !== false
    /* 一次请求只读一次上限：顶层 `limit` 与各组扫描必须用同一个值，否则面板
     * 显示的「上限」和实际截断点会对不上（测试钩子也按请求切换）。 */
    const limits = { maxFiles: maxScanFiles(), maxDepth: maxScanDepth() }
    const groups = []
    for (const folder of folders) {
      let exists = true
      try {
        const stat = await fsp.stat(folder)
        exists = stat.isDirectory()
      } catch {
        exists = false
      }
      // 目录不存在时没有扫描结果，也没有「被截断」这回事。
      const scan = exists
        ? await scanFolder(folder, recursive, limits)
        : { items: [], truncated: false }
      groups.push({
        folder,
        exists,
        count: scan.items.length,
        // scanned 与 count 同值，保留 count 兼容只读它的客户端。
        scanned: scan.items.length,
        truncated: scan.truncated,
        items: scan.items,
      })
    }
    const uploadScan = await scanFolder(UPLOAD_DIR, false, limits)
    if (uploadScan.items.length > 0) {
      groups.push({
        folder: UPLOAD_DIR,
        exists: true,
        count: uploadScan.items.length,
        scanned: uploadScan.items.length,
        truncated: uploadScan.truncated,
        items: uploadScan.items,
        uploads: true,
      })
    }
    // 顶层 limit = 本次每组的文件数上限；客户端据此显示「已达上限」的提示。
    sendJson(res, 200, { ok: true, limit: limits.maxFiles, groups })
  }, { methods: ['GET', 'HEAD'] })

  /* ── 图片回吐：本地文件 → 浏览器 ──
   *
   * GET ?path=<绝对路径> → 200 二进制（Content-Type 按扩展名，带 ETag /
   * Last-Modified），协商命中 → 304。没有 path → 400；被拒 → 403，
   * 「图片太大」→ 413 并带 size；读盘失败 → 500。只允许登记目录与上传目录内的图片。
   */
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
    /* 缓存验证全部基于 resolveAllowedImage 已经拿到的 stat：
     * 内容变了但字节数不变时，只看长度的 ETag 会永远 304；mtimeMs 参与哈希后
     * 这种改写一定能被识别。304 分支也因此不需要先读整张图。 */
    const info = resolved.stat
    const etag = imageETag(real, info)
    const cacheHeaders = {
      'Cache-Control': 'private, max-age=60',
      ETag: etag,
      // ETag 与 Last-Modified 并存：只认日期的老缓存客户端仍能协商。
      'Last-Modified': info.mtime.toUTCString(),
    }
    // RFC 9110：If-None-Match 存在时优先用它，只有它缺席才看 If-Modified-Since。
    const ifNoneMatch = req.headers['if-none-match']
    const notModified =
      ifNoneMatch === undefined
        ? notModifiedSince(req.headers['if-modified-since'], info)
        : ifNoneMatchHits(ifNoneMatch, etag)
    if (notModified) {
      // 304 不带 body；ETag / Cache-Control / Last-Modified 与 200 保持一致。
      res.writeHead(304, cacheHeaders)
      res.end()
      return
    }
    let bytes
    try {
      bytes = await fsp.readFile(real)
    } catch (error) {
      // 读取失败仍是 500「内部错误」：error.message 带绝对路径，不能回给浏览器。
      sendInternalError(res, error, '读取图片失败')
      return
    }
    res.writeHead(200, {
      ...cacheHeaders,
      'Content-Type': mimeFor(real),
      'Content-Length': String(bytes.length),
    })
    res.end(bytes)
  }, { methods: ['GET', 'HEAD'] })

  /* ── 远程图片代理：绕开 CORS，只代理位图，带本地缓存 ──
   *
   * GET ?url=<http(s) URL> → 200 图片（nosniff / attachment / CSP / Cache-Control，
   * 带 ETag，命中 If-None-Match → 304）；失败回 JSON：400 参数、403 目标被拒
   * （内网地址 / 带凭据）、413 超限、415 非位图、502 上游失败。
   * 安全：协议与凭据校验 → 每跳 DNS 全地址校验 → 手动跟随重定向 → 文件头识别
   * （SVG 一律 415）。缓存是可删的本地副本，删除只影响下次回源。
   * ─────────────────────────────────────────────────────────────── */
  route('/api/proxy', async (req, res) => {
    const requested = queryParam(req, 'url')
    const parsed = parseProxyUrl(requested)
    if (parsed.ok !== true) {
      sendJson(res, parsed.status, { ok: false, error: parsed.error })
      return
    }

    // 缓存键用「配置里保存的原始 URL 字符串」（两端都 trim），而不是规范化后的
    // href：/api/forget-url 是按配置里的字符串删缓存的，若这里换用 href，大小写或
    // 默认端口不同的同一链接就会出现「删了候选、缓存还在」的不一致。
    const target = requested.trim()
    const base = cacheFileFor(target)

    // 1) 命中可信缓存：不回源，因此也不需要再做 DNS 校验（缓存只可能由通过校验
    //    的成功回源写入）。但 meta.ext 与文件头 magic 仍要重验：url-cache 是磁盘
    //    目录，可能被旧版本写脏或被投毒，坏缓存一律删掉当未命中。
    const cached = await readCacheEntry(target, base)
    if (cached !== null) {
      sendProxyImage(req, res, cached)
      return
    }

    // 2) 未命中或缓存不可信：回源。手动跟随重定向，每一跳都重新做 SSRF 校验。
    const fetched = await fetchProxyUpstream(parsed.url)
    if (fetched.ok !== true) {
      // 失败文案已在 fetchProxyUpstream 里脱敏（只有「拉取失败」+ 可选错误码），
      // 这里只负责把 code 透传出去，不要拼接任何目标地址。
      const payload = { ok: false, error: fetched.error }
      if (typeof fetched.code === 'string') payload.code = fetched.code
      sendJson(res, fetched.status, payload)
      return
    }
    // 写缓存失败只告警一次，图片照常回吐（缓存不能成为看图的单点故障）。
    await writeCacheEntry(target, base, fetched)
    sendProxyImage(req, res, fetched)
  }, { methods: ['GET', 'HEAD'] })

  /* ── 删除远程壁纸的本地缓存 + 从候选列表移除 ──
   *
   * POST `{ url }` → 200 `{ ok, removedCacheFiles, urls }`；缺 url → 400。
   * 两件事一起做：删 url-cache 里的副本（下次回源）；把 URL 从 wallpaper.urls
   * 去掉，并在 current / fixed 指向它时一起清空。不触碰远端原图。
   * ─────────────────────────────────────────────────────────────── */
  route('/api/forget-url', async (req, res) => {
    let payload
    try {
      payload = await readJson(req)
    } catch (error) {
      // JSON.parse 的 message 会带请求体片段，不回给调用方；细节进宿主日志。
      console.warn('[dsh-theme-studio] /api/forget-url 请求体不是合法 JSON：', error)
      sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    const target = String(payload?.url ?? '').trim()
    if (target.length === 0) {
      sendJson(res, 400, { ok: false, error: 'missing url' })
      return
    }
    const removed = await dropCache(target)
    const config = readConfig()
    const urls = (config.wallpaper?.urls ?? []).filter((item) => item !== target)
    const current = String(config.wallpaper?.current ?? '')
    const fixed = String(config.wallpaper?.fixed ?? '')
    /** 配置里保存的就是 URL 原文，比较前 trim 一下即可；空串不能参与匹配。 */
    const isActiveUrl = (value) => value.length > 0 && value.trim() === target
    const patch = { wallpaper: { urls } }
    /* 删掉候选后，如果 current / fixed 还指着这条 URL，下次刷新只会重新下载一份
     * 刚被删掉的缓存，壁纸等于「删了又回来」。两者必须一起清空：只清命中的那个
     * 会把另一个留在同样的悬空状态。 */
    if (isActiveUrl(current) || isActiveUrl(fixed)) {
      patch.wallpaper.current = ''
      patch.wallpaper.fixed = ''
    }
    const next = await writeConfig(patch)
    sendJson(res, 200, { ok: true, removedCacheFiles: removed, urls: next.wallpaper.urls })
  }, { methods: ['POST'], jsonBody: true })

  /* ── 删除「上传」来源的本地副本（真删）──
   *
   * POST `{ path }` → 200 `{ ok, removed:true, removedFiles:1, path }`；
   * 不在上传目录 / 非图片 → 403 `{ ok:false, removed:false }`；缺 path → 400；
   * 删除失败 → 500。
   *
   * 上传图是插件复制到 wallpapers/ 的副本（原图在用户自己选的位置），所以删它
   * 是真删。这个端点同时是「归属判定」的权威：客户端不复制 UPLOAD_DIR 的布局
   * 知识，只问「这是不是插件自己产生的副本」—— 不在上传目录就是用户登记目录里
   * 的原图，本插件绝不删。
   * 只允许删 UPLOAD_DIR 的直接子级：isInside 挡 .. 逃逸，dirname 必须恰好是
   * UPLOAD_DIR，且必须是图片扩展名（目录因 rm 不带 recursive 而删不掉）。
   * ─────────────────────────────────────────────────────────────── */
  route('/api/delete-upload', async (req, res) => {
    let payload
    try {
      payload = await readJson(req)
    } catch (error) {
      console.warn('[dsh-theme-studio] /api/delete-upload 请求体不是合法 JSON：', error)
      sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      return
    }
    const target = String(payload?.path ?? '').trim()
    if (target.length === 0) {
      sendJson(res, 400, { ok: false, error: 'missing path' })
      return
    }
    const normalized = normalizeUserPath(target)
    const uploadRoot = path.resolve(UPLOAD_DIR)
    /* 403 在这里是正常分支（「不是插件的副本」），不是故障 —— 客户端靠它降级。
     * removed:false 让这个语义在响应体里也显式可见，不依赖调用方去读状态码。 */
    // 用 samePath 而不是硬编码 toLowerCase：Linux 上大小写敏感，…/Wallpapers/x.png
    // 不该被当成上传目录的直接子级。
    if (!isInside(normalized, uploadRoot) || !samePath(path.dirname(normalized), uploadRoot)) {
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
      sendInternalError(res, error, '删除上传副本失败')
      return
    }
    // 删掉的正好是当前/固定壁纸时，把配置里那个悬空路径一起清掉，避免指向不存在的文件。
    // 比较用 samePath（按平台处理大小写与结尾分隔符），且 current 与 fixed 都要查：
    // 只查一个会留下另一个悬空引用。
    const config = readConfig()
    const current = String(config.wallpaper?.current ?? '')
    const fixed = String(config.wallpaper?.fixed ?? '')
    /** 空串不能被 path.resolve 解成进程 cwd，必须先挡掉。 */
    const isActivePath = (value) =>
      value.length > 0 && (samePath(value, normalized) || samePath(value, target))
    if (isActivePath(current) || isActivePath(fixed)) {
      // 两个一起清：只清命中的那个会留下另一个仍指向已删文件的引用。
      await writeConfig({ wallpaper: { current: '', fixed: '' } })
    }
    sendJson(res, 200, { ok: true, removed: true, removedFiles: 1, path: normalized })
  }, { methods: ['POST'], jsonBody: true })

  /* ── 重置配置：把插件造成的所有效果退回出厂 ──
   *
   * POST `{ purgeFiles?: boolean }`（空体合法）→ 200
   * `{ ok, purged, removedFiles, config }`。
   *
   * 与设置页「一键关闭」的区别：
   *   · 关闭：只把 enabled 置 false —— 效果撤了，配置保留，再打开全回来；
   *   · 重置：整份配置退回 defaultConfig() —— 壁纸、玻璃、主题色、登记目录全
   *     清空，等于这个插件从没被配置过。
   *
   * 它同时是配置损坏后的**唯一恢复路径**：依赖配置的接口在损坏时全部 500 且不落盘，
   * 只有 reset 允许继续（/api/ping 不读配置，仍返回 200）—— 先确保原始字节已备份
   * （失败则重试一次），成功后才写回出厂值并解除损坏状态。备份始终失败时 reset
   * 也 500，原文件不动。
   *
   * purgeFiles 控制要不要连插件自己产生的文件一起删：
   *   · false（默认）：只重置配置，原图在用户自己的目录里，插件从不碰；
   *   · true：额外删 wallpapers/（上传副本）与 url-cache/（远程图缓存）。
   *   两者都只是副本；用户登记目录里的原图永远不动。
   */
  route('/api/reset', async (req, res) => {
    let payload = {}
    try {
      payload = await readJson(req)
    } catch {
      // 空 body 也算合法：等价于默认的「只重置配置」。
      payload = {}
    }
    const purgeFiles = payload?.purgeFiles === true
    /* 直接覆盖成出厂值，不走 mergeConfig —— 合并是「只增不删」，拿它做重置会把
     * 用户原有的键留下来（那正是「关闭 ≠ 重置」的老问题）。resetConfig 内部会
     * 先处理损坏备份再写盘，仍然走同一条配置写队列：reset 与并发 PUT 必须串行，
     * 否则谁最后 rename 谁赢，缓存也会分叉。 */
    const fresh = await resetConfig()

    /* 删除逻辑与 /api/purge-cache 共用同一个实现：reset 只是「额外把配置写回出厂值」，
     * 文件清理的边界（只删插件自己的副本、绝不碰登记目录）必须两边完全一致。 */
    const purged = purgeFiles ? await purgeCacheFiles() : { removedFiles: 0, removedBytes: 0 }
    sendJson(res, 200, { ok: true, purged: purgeFiles, removedFiles: purged.removedFiles, config: fresh })
  }, { methods: ['POST'], jsonBody: true })

  /* ── 只清理插件自己的本地副本，不动配置 ──
   *
   * POST（无参数）→ 200 `{ ok, removedFiles, removedBytes }`。
   *
   * 为什么单独开一个端点：清理副本与重置配置是两件事。若让「清理本地缓存」走
   * reset + 客户端回写快照，中间任何失败（网络、并发写、关页面）都会让用户配置
   * 变成出厂值。这里只调 purgeCacheFiles()：删 wallpapers/ 与 url-cache/ 的
   * 直接子项，不读也不改配置，绝不碰登记目录里的原图。方法校验由 route() 统一
   * 返回 405，handler 不重复判断。
   */
  route('/api/purge-cache', async (req, res) => {
    try {
      await readJson(req)
    } catch (error) {
      /* 本接口不读任何参数：只有「请求体不是合法 JSON」可以忽略；
       * 超限（413）与中途断开必须继续抛，交给 route() 包装层处理。 */
      if (!(error instanceof SyntaxError)) throw error
    }
    const purged = await purgeCacheFiles()
    sendJson(res, 200, {
      ok: true,
      removedFiles: purged.removedFiles,
      removedBytes: purged.removedBytes,
    })
  }, { methods: ['POST'], jsonBody: true })

  /* ── 上传：浏览器选图落盘，避免每次刷新重新传 ──
   *
   * POST 原始二进制（不要求 JSON Content-Type），查询参数 name 只用于日志。
   * → 200 `{ ok, path, url, bytes, type }`；空体 400；超过体积或配额 413；
   * 文件头不是位图 415（不写盘）。仍受 Origin / Sec-Fetch-Site 闸门约束。
   * 扩展名与 Content-Type 只由 sniffBitmap 决定，客户端传的 name 不参与落盘。
   */
  route('/api/upload', async (req, res) => {
    // 上传体是原始二进制，不做 JSON 类型检查，但仍受 Origin / Sec-Fetch-Site 闸门约束。
    /* name 只用于日志：扩展名与 Content-Type 全部由文件头识别结果决定。
     * 若让客户端传的 name 决定落盘类型，任意二进制都能伪装成图片落盘，再以
     * image/png 回吐。 */
    const rawName = queryParam(req, 'name')
    // 超限由 readBody 统一拒绝为 413（不掐断连接），不用 handler 自己判断。
    const buffer = await readBody(req, maxUploadBytes())
    if (buffer.length === 0) {
      sendJson(res, 400, { ok: false, error: '上传内容为空' })
      return
    }
    // 与 /api/proxy 共用同一套识别逻辑：只认位图 magic bytes，SVG/HTML 一律拒绝。
    const sniffed = sniffBitmap(buffer)
    if (sniffed === null) {
      console.warn(
        `[dsh-theme-studio] 拒绝上传：文件头不是受支持的位图（name=${JSON.stringify(rawName).slice(0, 120)}，${buffer.length} 字节）`,
      )
      sendJson(res, 415, {
        ok: false,
        error: '不是受支持的图片（只接受 PNG/JPEG/GIF/WEBP/BMP/AVIF），已拒绝',
      })
      return
    }
    /* 配额检查与写盘必须原子：先读用量、再写文件是读改写序列，两个并发上传若都
     * 读到旧用量就会一起越过上限。串行队列只包住这两步，读 body 不在队列里。 */
    const outcome = await enqueueUploadWrite(async () => {
      const usage = await uploadUsage()
      const maxFiles = maxUploadFiles()
      if (usage.files >= maxFiles) {
        return {
          ok: false,
          status: 413,
          error: `上传目录已有 ${usage.files} 个文件，达到上限 ${maxFiles} 个，请先清理本地缓存后再上传`,
        }
      }
      const maxTotal = maxUploadTotalBytes()
      if (usage.bytes + buffer.length > maxTotal) {
        return {
          ok: false,
          status: 413,
          error: `上传目录已占用 ${usage.bytes} 字节，加上这张将超过上限 ${maxTotal} 字节，请先清理本地缓存后再上传`,
        }
      }
      await fsp.mkdir(UPLOAD_DIR, { recursive: true })
      // 存储名只用识别出的扩展名；时间戳便于排序，8 位随机 hex 防同毫秒互相覆盖。
      const safeName = `up-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${sniffed.ext}`
      const target = path.join(UPLOAD_DIR, safeName)
      await fsp.writeFile(target, buffer)
      return { ok: true, target }
    })
    if (outcome.ok !== true) {
      sendJson(res, outcome.status, { ok: false, error: outcome.error })
      return
    }
    sendJson(res, 200, {
      ok: true,
      path: outcome.target,
      url: `${ROUTE_PREFIX}/api/image?path=${encodeURIComponent(outcome.target)}`,
      bytes: buffer.length,
      type: sniffed.mime,
    })
  }, { methods: ['POST'] })

  /* 卸载时释放全部路由：单个 dispose 失败不影响其它路由。 */
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
