/**
 * dsh-theme-studio 的浏览器半侧。
 *
 * 文件交付为惰性 CJS bundle：__ModuleLoader__.load 只登记模块 id 与工厂，client-modules
 * 首次物化工厂时才执行模块体。因此所有 DOM 副作用都必须留在 factory 内，不能在文件
 * 顶层提前运行，否则会与宿主的加载时序脱节。
 *
 * 工厂只 require react 与客户端 UI primitives；不引入构建步骤，样式由本文件生成后注入。
 */
window.__ModuleLoader__.load({
  id: 'dsh-theme-studio',
  factory: (require) => {
    /**
     * 模块加载器可能以非严格模式执行工厂。显式声明严格模式，让未声明赋值之类的手误在
     * 工厂物化时立刻抛错，而不是静默写进全局对象、拖到面板渲染才暴露。
     */
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')


    /**
     * 客户端所有宿主接口的公共前缀，具体路由由 lib/index.js 注册。
     */
    const API = '/theme-studio/api'
    /**
     * 客户端上传预检上限（32 MB）。
     *
     * 这里只做提前提示：宿主的上限可由环境变量覆盖，客户端看不到；提前拦下明显超限的
     * 文件可以省掉一次白传，最终能否落盘仍以 /api/upload 的校验为准。
     */
    const UPLOAD_MAX_BYTES = 32 * 1024 * 1024

    /**
     * 选图后的客户端预检。
     *
     * 只拦确定错误：空文件、超过本地提示上限、file.type 非空且不是 image/*。type 为空时
     * 必须放行，因为部分系统提供不了 MIME，真正的类型判断由宿主按文件魔数完成。宿主还会
     * 检查上传目录的文件数与总字节配额，那部分客户端无法预判。
     */
    function precheckUpload(file) {
      if (file.size === 0) return `上传失败：${file.name} 是空文件（0 字节），请换一张图片`
      if (file.size > UPLOAD_MAX_BYTES) {
        const megabytes = (file.size / (1024 * 1024)).toFixed(1)
        const limitMegabytes = UPLOAD_MAX_BYTES / (1024 * 1024)
        return `上传失败：${file.name} 有 ${megabytes}MB，超过 ${limitMegabytes}MB 上限；请先压缩或换一张（客户端只做提前提示，最终以宿主校验为准）`
      }
      const type = String(file.type ?? '')
      if (type !== '' && !/^image\//i.test(type)) {
        return `上传失败：${file.name} 不是图片（类型 ${type}），已取消上传`
      }
      return null
    }

    /**
     * 页面根属性、主题样式表 id 与背景层 id。
     *
     * 三者共同标记插件是否已接管界面；样式选择器全部挂在根属性下，关闭时移除属性即可让
     * 整套规则失效。
     */
    const ROOT_ATTR = 'data-dsh-theme-studio'
    const STYLE_ID = 'dsh-theme-studio/theme.css'
    const BG_ID = 'dsh-theme-studio-bg'
    /**
     * 本地缓存格式版本。
     *
     * 缓存只为刷新后的首帧服务，不是配置的权威源；版本不匹配时直接丢弃，不做兼容读取。
     * 改变缓存或配置形状时同步递增版本，不匹配的缓存键会在读取路径被删除。
     */
    const CACHE_VERSION = '1.0'
    const CACHE_KEY = `dsh-theme-studio:config:${CACHE_VERSION}`
    /**
     * 无版本号的缓存键；启动时删除一次，避免无法校验版本的结构被当作当前缓存。
     */
    const CACHE_KEY_LEGACY = 'dsh-theme-studio:config'
    const SETTINGS_NS = 'theme-studio'

    /**
     * 候选墙首屏渲染张数。
     *
     * 每张候选都通过 /api/image 读全尺寸原图，没有缩略图端点；一次渲染整个图库会同时压垮
     * 浏览器解码与宿主读盘。窗口只限制渲染数量，完整扫描结果保存在 gallery，避免静默丢图。
     */
    const CANDIDATE_WINDOW = 200
    /**
     * 点一次「加载更多」追加的张数，与首屏同量级。
     */
    const CANDIDATE_WINDOW_STEP = 200
    /**
     * 目录浏览器一次最多渲染的子目录数。
     *
     * 宿主单次最多返回 500 个目录，这里再截到 60 个；达到上限时必须显示「仅显示前 N 个」，
     * 同时保留手动输入完整路径的入口。
     */
    const BROWSE_DIR_LIMIT = 60

    /**
     * 设置页可调的毛玻璃分区。
     *
     * required 为 false 表示目标元素只在应用的某种状态出现，自检 0 命中是正常结果，面板会
     * 显示中性提示；note 就是那条提示，避免把正常状态误报成故障。
     */
    const REGIONS = [
      { key: 'bars', zh: '边栏', hint: '侧边栏与顶边栏，共用一份参数' },
      { key: 'input', zh: '输入框', hint: '底部输入卡片、AI 提问与计划审批卡片' },
      {
        key: 'bubble',
        zh: '气泡',
        hint: '你的消息气泡与附件卡',
        required: false,
        note: '气泡只在当前会话里有你的消息时才存在（附件卡同理，要带附件）—— 0 命中通常只说明这个会话还没有你的消息，发一条就会出现。',
      },
      {
        key: 'assistant',
        zh: 'AI 回复',
        hint: 'AI 输出的左侧气泡，与用户消息独立调节',
        required: false,
        note: 'AI 回复只在当前会话里有助手输出时才出现；0 命中通常表示还没有 AI 回复。',
      },
      {
        key: 'menu',
        zh: '弹层菜单',
        hint: '下拉菜单、悬浮提示、Toast',
        required: false,
        note: '本区主要靠令牌覆盖生效，元素规则只是条件 —— 那几条只在对应浮层真正弹出时才存在，0 命中属正常。',
      },
    ]

    // DSH 0.2.1-rc.2 ui-theme 的浅/深色 RGB：供自定义颜色预设和调色盘显示。
    // auto 始终使用下方的原生 CSS 令牌；菜单原生底色自带 alpha，预设是其不透明 RGB，
    // 不能据此替代 auto。用户主动选预设时仍由本分区的不透明度滑块决定最终 alpha。
    // AI 回复原生无气泡背景；为保留插件的独立气泡，采用其所在页面的原生底色。
    // 边栏是一个调节项，但侧栏和顶边栏在 DSH 原生样式里不是同一种底色。
    const GLASS_COLORS = {
      bars: { light: [249, 250, 251], dark: [27, 27, 28] },
      input: { light: [255, 255, 255], dark: [44, 44, 46] },
      bubble: { light: [237, 243, 254], dark: [44, 44, 46] },
      assistant: { light: [255, 255, 255], dark: [21, 21, 23] },
      menu: { light: [248, 249, 250], dark: [67, 69, 74] },
    }
    const GLASS_NATIVE = {
      // sidebar 根节点使用 --dsw-specific-sidebar-fill；只在侧栏节点上把它置透明，
      // body 上的原生值仍可在这里读取，不会把透明值拿来当遮罩。
      bars: { light: '--dsw-specific-sidebar-fill', dark: '--dsw-specific-sidebar-fill' },
      // 顶栏的背景来自 --dsw-alias-bg-base，但壁纸开启时该令牌被插件设为透明；
      // 因此这里直接引用 DSH 原生的浅色/深色页面底色令牌。
      barsHeader: { light: '--dsw-static-neutral-bluish-00', dark: '--dsw-static-neutral-bluish-950' },
      // input / bubble 的语义令牌会被插件在 body 上覆盖；从其原生源令牌取色
      // 才能避免 var() 自引用，也不受其它分区设置的影响。
      input: { light: '--dsw-static-neutral-bluish-00', dark: '--dsw-static-neutral-bluish-850' },
      bubble: { light: '--dsw-static-deepseek-50', dark: '--dsw-static-neutral-bluish-850' },
      bubbleFile: { light: '--dsw-static-neutral-bluish-00', dark: '--dsw-static-neutral-bluish-850' },
      assistant: { light: '--dsw-static-neutral-bluish-00', dark: '--dsw-static-neutral-bluish-950' },
      // 读取 body 上的原生值（macOS 另有半透明菜单色）；菜单子节点再就地覆盖该令牌。
      menu: { light: '--dsw-specific-menu', dark: '--dsw-specific-menu' },
      menuLayer2: { light: '--dsw-alias-bg-layer-2', dark: '--dsw-alias-bg-layer-2' },
      menuLayer3: { light: '--dsw-alias-bg-layer-3', dark: '--dsw-alias-bg-layer-3' },
      menuTip: { light: '--dsw-specific-tip', dark: '--dsw-specific-tip' },
    }

    /**
     * 主题色预设：中文名与 RGB 三元组。面板正文固定中文，不维护没有读取点的英文名。
     */
    const ACCENT_PRESETS = [
      { id: 'deepseek', zh: 'DeepSeek 蓝', rgb: [65, 118, 230] },
      { id: 'ocean', zh: '远洋青', rgb: [20, 150, 160] },
      { id: 'violet', zh: '星云紫', rgb: [124, 92, 232] },
      { id: 'sakura', zh: '樱花粉', rgb: [232, 106, 148] },
      { id: 'amber', zh: '琥珀金', rgb: [214, 138, 32] },
      { id: 'forest', zh: '松林绿', rgb: [46, 160, 96] },
      { id: 'crimson', zh: '朱砂红', rgb: [214, 62, 62] },
      { id: 'graphite', zh: '石墨灰', rgb: [120, 126, 138] },
    ]

    /**
     * 所有分区共用的模糊上限（px）。
     *
     * 上限留足余量，让滑块的物理最大值就是实际生效值，避免出现「拉到底却不再变化」的隐形截断。
     */
    const MAX_BLUR = 100

    /**
     * 出厂配置，形状必须与宿主 lib/index.js 的 defaultConfig() 保持一致。
     *
     * 默认不使用壁纸，玻璃不透明度为 1、模糊为 0，主题色关闭；新增的 AI 回复
     * 气泡默认开启，但可单独关闭并还原 DSH 原本的无气泡正文。
     * 客户端与宿主各维护一份同形配置，新增或删除字段时两侧要同步。
     */
    function defaultConfig() {
      return {
        version: 2,
        enabled: true,
        accent: { enabled: false, rgb: [65, 118, 230], preset: 'deepseek' },
        wallpaper: {
          source: 'none',
          folders: [],
          urls: [],
          current: '',
          fixed: '',
          recursive: true,
          fit: 'cover',
          position: 'center',
          blur: 0,
          brightness: 1,
          saturation: 1,
          dim: 0,
          dimColor: 'auto',
          vignette: 0,
          noise: 0,
        },
        glass: {
          bars: { enabled: true, opacity: 1, blur: 0, color: 'auto' },
          input: { enabled: true, opacity: 1, blur: 0, color: 'auto' },
          bubble: { enabled: true, opacity: 1, blur: 0, color: 'auto' },
          assistant: { enabled: true, opacity: 1, blur: 0, color: 'auto' },
          menu: { enabled: true, opacity: 1, blur: 0, color: 'auto' },
          border: 0.6,
          highlight: 0.5,
        },
      }
    }


    /**
     * 深合并默认值与已有值：数组和标量整体覆盖，对象递归补齐缺失字段。
     */
    function merge(base, patch) {
      if (patch === undefined || patch === null) return base
      if (Array.isArray(base) || Array.isArray(patch)) return patch
      if (typeof base !== 'object' || typeof patch !== 'object') return patch
      const out = { ...base }
      for (const key of Object.keys(base)) if (key in patch) out[key] = merge(base[key], patch[key])
      for (const key of Object.keys(patch)) if (!(key in out)) out[key] = patch[key]
      return out
    }

    /**
     * 把数值夹紧到 [min, max]。
     *
     * 非有限数字（NaN、Infinity、Number("x")）穿过 Math.min/Math.max 会拼出非法 CSS，因此
     * 先回退到 fallback，fallback 也非法时再回退 min。
     */
    const clamp = (value, min, max, fallback = min) => {
      const number = Number(value)
      const fallbackNumber = Number(fallback)
      const safe = Number.isFinite(number)
        ? number
        : Number.isFinite(fallbackNumber)
          ? fallbackNumber
          : min
      return Math.min(max, Math.max(min, safe))
    }

    const DEFAULT_ACCENT_RGB = [65, 118, 230]

    /**
     * 把任意 RGB 输入规范成三个 0–255 的整数。
     *
     * 通道可以是数字或数字字符串；任一通道无法转为有限数字时整体回退 fallback，不让半合法
     * 颜色进入 CSS。
     */
    function normalizeRgb(value, fallback = DEFAULT_ACCENT_RGB) {
      if (!Array.isArray(value) || value.length < 3) return [...fallback]
      const channels = value.slice(0, 3).map((channel) => {
        const number = Number(channel)
        return Number.isFinite(number) ? Math.round(clamp(number, 0, 255)) : NaN
      })
      return channels.some((channel) => Number.isNaN(channel)) ? [...fallback] : channels
    }


    /**
     * 配置清洗用到的白名单与退役键表。
     *
     * 退役键先显式删除，再由 pruneUnknown 按默认形状裁掉未知键；来源、适配与对齐只接受
     * 白名单值，避免不可信配置或手改对象把非法枚举带进运行时。
     */
    const RETIRED_ROOT_KEYS = ['perf', 'scope']
    const RETIRED_WALLPAPER_KEYS = ['hidden', 'rotate']
    const RETIRED_GLASS_REGIONS = ['sidebar', 'topbar', 'chat', 'panel']

    const WALLPAPER_SOURCES = ['none', 'folder', 'url', 'upload']
    const WALLPAPER_FITS = ['cover', 'contain', 'repeat', 'center']
    const WALLPAPER_POSITIONS = ['center', 'top', 'bottom', 'left', 'right']

    const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

    /**
     * 只接受有限数字或非空数字字符串。
     *
     * 不复用 Number() 的宽松转换：Number(null) 是 0、Number(true) 是 1，那会把缺字段误读成
     * 用户把值调到 0。无法判断时返回 null，由调用方回退默认值。
     */
    function toFiniteNumber(value) {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null
      if (typeof value === 'string' && value.trim() !== '') {
        const number = Number(value)
        return Number.isFinite(number) ? number : null
      }
      return null
    }

    function sanitizeNumber(value, min, max, fallback) {
      const number = toFiniteNumber(value)
      return number === null ? fallback : Math.min(max, Math.max(min, number))
    }

    /**
     * 只接受真正的 boolean；字符串 "true"、0/1 等一律回退。
     */
    function sanitizeBoolean(value, fallback) {
      return typeof value === 'boolean' ? value : fallback
    }

    /**
     * 字符串列表清洗：丢弃非字符串、空串和重复项，保持首次出现顺序。
     */
    function sanitizeStringList(value) {
      if (!Array.isArray(value)) return []
      const seen = new Set()
      const out = []
      for (const item of value) {
        if (typeof item !== 'string') continue
        const text = item.trim()
        if (text === '' || seen.has(text)) continue
        seen.add(text)
        out.push(text)
      }
      return out
    }

    /**
     * 按默认配置的形状重建对象：默认值没有的键一律丢弃，数组整体复制。
     */
    function pruneUnknown(defaults, value) {
      if (Array.isArray(defaults)) return Array.isArray(value) ? [...value] : [...defaults]
      if (!isPlainObject(defaults)) return value === undefined ? defaults : value
      const source = isPlainObject(value) ? value : {}
      const out = {}
      for (const key of Object.keys(defaults)) {
        const next = key in source ? source[key] : defaults[key]
        out[key] = pruneUnknown(defaults[key], next)
      }
      return out
    }

    /**
     * 单个玻璃分区只保留 enabled/opacity/blur/color，并夹紧到合法范围。
     * color='auto' 是可写回的默认状态（宿主深合并会忽略 null）。
     */
    function sanitizeGlassRegion(value, fallback) {
      const region = isPlainObject(value) ? value : {}
      return {
        enabled: sanitizeBoolean(region.enabled, fallback.enabled),
        opacity: sanitizeNumber(region.opacity, 0, 1, fallback.opacity),
        blur: sanitizeNumber(region.blur, 0, MAX_BLUR, fallback.blur),
        color: typeof region.color === 'string' && region.color !== 'auto'
          ? toHex(parseColor(region.color), '') || 'auto'
          : 'auto',
      }
    }

    /**
     * 把任意来源的配置清洗成默认形状。
     *
     * 宿主配置、本地缓存、宿主写回三个入口都经过这里：先合并默认值，再显式删除退役键，
     * 按默认形状裁掉未知键，最后逐字段校验类型与范围。非法值回退默认值而不是区间下界，
     * 例如 brightness 的下界 0.2 会变成全黑，不适合作为中立兜底。
     */
    function sanitizeConfig(raw) {
      const defaults = defaultConfig()
      if (!isPlainObject(raw)) return defaults

      const merged = merge(defaults, raw)

      for (const key of RETIRED_ROOT_KEYS) delete merged[key]
      if (isPlainObject(merged.wallpaper)) {
        for (const key of RETIRED_WALLPAPER_KEYS) delete merged.wallpaper[key]
      }
      if (isPlainObject(merged.glass)) {
        for (const key of RETIRED_GLASS_REGIONS) delete merged.glass[key]
        for (const key of Object.keys(merged.glass)) {
          const region = merged.glass[key]
          if (isPlainObject(region) && 'saturation' in region) delete region.saturation
        }
      }

      const clean = pruneUnknown(defaults, merged)

      clean.enabled = sanitizeBoolean(clean.enabled, defaults.enabled)
      const version = toFiniteNumber(clean.version)
      clean.version = version === null ? defaults.version : version

      const accent = isPlainObject(clean.accent) ? clean.accent : {}
      clean.accent = {
        enabled: sanitizeBoolean(accent.enabled, defaults.accent.enabled),
        rgb: normalizeRgb(accent.rgb, DEFAULT_ACCENT_RGB),
        preset: typeof accent.preset === 'string' ? accent.preset : defaults.accent.preset,
      }

      const wp = isPlainObject(clean.wallpaper) ? clean.wallpaper : {}
      clean.wallpaper = {
        source: WALLPAPER_SOURCES.includes(wp.source) ? wp.source : 'none',
        folders: sanitizeStringList(wp.folders),
        urls: sanitizeStringList(wp.urls),
        current: typeof wp.current === 'string' ? wp.current : '',
        fixed: typeof wp.fixed === 'string' ? wp.fixed : '',
        recursive: sanitizeBoolean(wp.recursive, defaults.wallpaper.recursive),
        fit: WALLPAPER_FITS.includes(wp.fit) ? wp.fit : 'cover',
        position: WALLPAPER_POSITIONS.includes(wp.position) ? wp.position : 'center',
        blur: sanitizeNumber(wp.blur, 0, 60, 0),
        brightness: sanitizeNumber(wp.brightness, 0.2, 2, 1),
        saturation: sanitizeNumber(wp.saturation, 0, 2, 1),
        dim: sanitizeNumber(wp.dim, 0, 0.9, 0),
        dimColor: typeof wp.dimColor === 'string' && wp.dimColor !== 'auto'
          ? toHex(parseColor(wp.dimColor), '') || 'auto'
          : 'auto',
        vignette: sanitizeNumber(wp.vignette, 0, 1, 0),
        noise: sanitizeNumber(wp.noise, 0, 0.2, 0),
      }

      const glass = isPlainObject(clean.glass) ? clean.glass : {}
      clean.glass = {
        bars: sanitizeGlassRegion(glass.bars, defaults.glass.bars),
        input: sanitizeGlassRegion(glass.input, defaults.glass.input),
        bubble: sanitizeGlassRegion(glass.bubble, defaults.glass.bubble),
        assistant: sanitizeGlassRegion(glass.assistant, defaults.glass.assistant),
        menu: sanitizeGlassRegion(glass.menu, defaults.glass.menu),
        border: sanitizeNumber(glass.border, 0, 1, defaults.glass.border),
        highlight: sanitizeNumber(glass.highlight, 0, 1, defaults.glass.highlight),
      }

      return clean
    }


    /**
     * 读取本地首帧缓存。
     *
     * 只接受带当前版本号且 config 为对象的记录；损坏、过期或不可解析时删除该键并返回 null。
     * 缓存不可用只影响首帧，不能阻止插件启动。
     */
    function readCachedConfig() {
      try {
        const raw = window.localStorage.getItem(CACHE_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        const valid = isPlainObject(parsed) &&
          parsed.version === CACHE_VERSION &&
          isPlainObject(parsed.config)
        if (!valid) {
          window.localStorage.removeItem(CACHE_KEY)
          return null
        }
        return sanitizeConfig(parsed.config)
      } catch {
        try {
          window.localStorage.removeItem(CACHE_KEY)
        } catch {
        }
        return null
      }
    }

    /**
     * 写入前再次清洗，保证缓存中不会出现退役键或非法值；写入失败（隐私模式、配额）忽略。
     */
    function writeCachedConfig(config) {
      try {
        window.localStorage.setItem(CACHE_KEY, JSON.stringify({
          version: CACHE_VERSION,
          config: sanitizeConfig(config),
        }))
      } catch {
      }
    }

    /**
     * 删除无版本缓存键，完成本地存储迁移；缓存不可用时忽略错误。
     */
    function clearLegacyCachedConfig() {
      try {
        window.localStorage.removeItem(CACHE_KEY_LEGACY)
      } catch {
      }
    }

    /**
     * URL 与列表读取的小工具：远程来源只认 http/https，非数组列表一律当作空数组。
     */
    const isRemoteUrl = (value) => /^https?:/i.test(String(value ?? ''))

    const toList = (value) => (Array.isArray(value) ? value : [])

    const rgbPair = (rgb) => normalizeRgb(rgb).join(' ')

    /**
     * 把 RGB 转成 #rrggbb，供面板的 style 直接使用；输入不是合法数组时返回固定兜底色。
     */
    const toHex = (rgb, fallback = '#000000') => {
      if (!Array.isArray(rgb) || rgb.length < 3) return fallback
      return `#${normalizeRgb(rgb, [0, 0, 0])
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('')}`
    }

    /**
     * 解析 #rgb、#rrggbb、rgb()/rgba()。
     *
     * 只接受完整闭合的输入；通道越界时夹紧，避免非法值进入 CSS 后整条声明失效。解析失败
     * 返回 null，调用方据此保留用户正在编辑的文本。
     */
    function parseColor(text) {
      const value = String(text ?? '').trim()
      const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)
      if (hex !== null) {
        let body = hex[1]
        if (body.length === 3) body = body.split('').map((c) => c + c).join('')
        return [0, 2, 4].map((i) => clamp(parseInt(body.slice(i, i + 2), 16), 0, 255))
      }
      const rgb = /^rgba?\(\s*(-?\d+)[\s,]+(-?\d+)[\s,]+(-?\d+)(?:\s*[,/]\s*[\d.]+%?)?\s*\)$/i.exec(value)
      if (rgb !== null) return [rgb[1], rgb[2], rgb[3]].map((channel) => clamp(channel, 0, 255))
      return null
    }

    /** 自定义取色框的二维饱和度/亮度区域及色相条共用的颜色转换。 */
    function rgbToHsv(rgb) {
      const [r, g, b] = rgb.map((channel) => channel / 255)
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const delta = max - min
      let hue = 0
      if (delta !== 0) {
        if (max === r) hue = ((g - b) / delta) % 6
        else if (max === g) hue = (b - r) / delta + 2
        else hue = (r - g) / delta + 4
        hue = (hue * 60 + 360) % 360
      }
      return { hue, saturation: max === 0 ? 0 : delta / max, brightness: max }
    }

    function hsvToRgb({ hue, saturation, brightness }) {
      const h = ((hue % 360) + 360) % 360
      const c = brightness * saturation
      const x = c * (1 - Math.abs((h / 60) % 2 - 1))
      const m = brightness - c
      const rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] :
        h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
      return rgb.map((channel) => Math.round((channel + m) * 255))
    }

    const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)

    const tint = (rgb, t) => mix(rgb, [255, 255, 255], t)
    const shade = (rgb, t) => mix(rgb, [0, 0, 0], t)

    function get(object, path, fallback) {
      let cursor = object
      for (const key of path.split('.')) {
        if (cursor === null || cursor === undefined || typeof cursor !== 'object') return fallback
        cursor = cursor[key]
      }
      return cursor === undefined ? fallback : cursor
    }

    /**
     * 按点分路径不可变写入：克隆沿途对象并返回新根，不修改传入对象。
     */
    function setIn(object, path, value) {
      const keys = path.split('.')
      const clone = Array.isArray(object) ? [...object] : { ...object }
      let cursor = clone
      for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i]
        const next = cursor[key]
        cursor[key] = Array.isArray(next) ? [...next] : { ...(next ?? {}) }
        cursor = cursor[key]
      }
      cursor[keys[keys.length - 1]] = value
      return clone
    }

    function isPlainPatchObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    /**
     * 合并同一防抖窗口内的多笔局部配置。
     *
     * 普通对象递归合并，数组与标量由新值整体覆盖；数组不能拼接，否则删除目录或链接后，
     * 被删掉的值会被另一笔 patch 补回来。类型冲突同样以新值为准，后写的动作代表最新意图。
     * 函数不修改入参。
     */
    function mergePatch(base, patch) {
      const next = patch ?? {}
      if (!isPlainPatchObject(base) || !isPlainPatchObject(next)) return next
      const merged = { ...base }
      for (const key of Object.keys(next)) {
        const previous = base[key]
        const value = next[key]
        merged[key] = isPlainPatchObject(previous) && isPlainPatchObject(value)
          ? mergePatch(previous, value)
          : value
      }
      return merged
    }


    /**
     * 各分区的候选选择器。
     *
     * 原生表面以变量覆盖为主，元素规则负责 backdrop-filter；新增的 AI 回复还用
     * 元素规则生成气泡外形。DSH 的类名由构建工具生成，升级后可能变化，全部失配
     * 只会失去该分区的效果。提问/计划审批卡片使用
     * DSH 自身的 data-* 标记，避免依赖它们各自生成的 CSS Modules 类名。面板自检复用这张表。
     * bars 的选择器由 buildBarsCss 单独生成，这里保留它们是为了自检能统计命中数。
     */
    const INPUT_CARD_SELECTORS = ['.uV2eYG_card']
    const INPUT_TAKEOVER_SELECTORS = ['[data-question-key] > section', '[data-plan-review-key] > section']
    const REGION_SELECTORS = {
      bars: ['.hHd-Xa_root', '.wSkVaW_header'],
      input: [...INPUT_CARD_SELECTORS, ...INPUT_TAKEOVER_SELECTORS],
      bubble: ['.Sixlwa_bubble', '.Sixlwa_fileCard'],
      // DSH 的稳定语义标记限定在 assistant-step；只给 AssistantMarkdown 的根节点
      // 加气泡，不包住整条会话（工具调用、状态行），也不碰拆分出的 reasoning 分区。
      // renderSlot 可能插入一层 data-slot 包裹，两个选择器覆盖这两种 DOM 形态。
      assistant: [
        '[data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"]) > [class*="_root"]:has(> [class*="_body"])',
        '[data-chat-flow-kind="assistant-step"]:not([data-chat-group-part="reasoning"]) > [data-slot="conversation.chat.node"] > [class*="_root"]:has(> [class*="_body"])',
      ],
      menu: ['.bRhRbq_panel', '.JObwrW_panel', '.mufS8W_card', '.Nqubda_panel', '.ZKlsPq_menu', '[class*="_menu_"]'],
    }
    // 设置弹窗与普通菜单共用 bg-layer-2/3。排除面板及整个设置浮层内的菜单：
    // 菜单即使挂在面板外、浮层内，也不能让设置页随菜单不透明度一起变透明。
    const MENU_GLASS_SELECTORS = REGION_SELECTORS.menu.map((selector) =>
      `${selector}:not(.VOzbGW_panel *, .VOzbGW_overlay *)`)

    /**
     * 背景层自身的固定定位与各子层样式。
     *
     * 图层挂在 html 下并置于负层，尺寸和滤镜参数由 BackgroundLayer.apply 写到元素上。
     * z-index 必须低于边栏伪元素的 -1，否则壁纸会盖住边栏玻璃。该组规则始终输出，没有
     * 背景元素时自然不生效。
     */
    const BACKGROUND_LAYER_CSS = `
html[${ROOT_ATTR}] #${BG_ID} { position: fixed; inset: 0; z-index: -2; pointer-events: none; overflow: hidden; contain: strict; }
html[${ROOT_ATTR}] #${BG_ID} > div { position: absolute; inset: 0; }
html[${ROOT_ATTR}] #${BG_ID} .ds-ts-bg-base { background: var(--ds-ts-bg-basecolor, #fff); }
html[${ROOT_ATTR}] #${BG_ID} .ds-ts-bg-image {
  background-image: var(--ds-ts-bg-url, none);
  background-size: var(--ds-ts-bg-size, cover);
  background-position: var(--ds-ts-bg-position, center);
  background-repeat: var(--ds-ts-bg-repeat, no-repeat);
  filter: blur(var(--ds-ts-bg-blur, 0px)) brightness(var(--ds-ts-bg-brightness, 1)) saturate(var(--ds-ts-bg-saturate, 1));
}
html[${ROOT_ATTR}]:has(body[data-ds-dark-theme]) #${BG_ID} .ds-ts-bg-base { background: #0f1115; }
html[${ROOT_ATTR}] #${BG_ID} .ds-ts-bg-dim { background: rgb(var(--ds-ts-bg-dim-rgb, 0 0 0) / var(--ds-ts-bg-dim, 0)); }
html[${ROOT_ATTR}]:has(body[data-ds-dark-theme]) #${BG_ID} .ds-ts-bg-dim { background: rgb(var(--ds-ts-bg-dim-rgb, 0 0 0) / calc(var(--ds-ts-bg-dim, 0) * .7)); }
html[${ROOT_ATTR}] #${BG_ID} .ds-ts-bg-vignette { background: radial-gradient(120% 90% at 50% 40%, transparent 45%, rgb(0 0 0 / var(--ds-ts-bg-vignette, 0)) 100%); }
html[${ROOT_ATTR}] #${BG_ID} .ds-ts-bg-noise { background-image: var(--ds-ts-bg-noise, none); background-repeat: repeat; opacity: .9; mix-blend-mode: overlay; }
`

    /**
     * 把 html/body 的背景让给背景层。
     *
     * 必须跟「壁纸是否真正生效」绑定：enabled 允许、来源不是 none，并且运行时已经解析出
     * 非空的 resolved（真正的本地文件或 URL）时才输出。source 只代表用户选了来源，不等于
     * 有图 —— folder 可能候选为空、候选全部失效或宿主不可达；此时若仍把外壳调透明，
     * 背景层没有任何图片，页面就会失去 DSH 原生底色。resolved 才是判据。
     */
    const SHELL_TRANSPARENT_CSS = `html[${ROOT_ATTR}], html[${ROOT_ATTR}] body { background: transparent !important; }`

    /**
     * 生成边栏分区的玻璃规则（侧边栏与顶边栏共用）。
     *
     * 膜与模糊必须落在同一个 ::before 上：放在子元素上时，子元素采到的是父级铺好的平膜，
     * 模糊看不出效果；放在元素自身上又会让元素成为 fixed 后代的包含块，把设置弹窗锁在
     * 侧栏尺寸内。伪元素不可能是任何元素的祖先，因此能同时满足两个约束。
     *
     * 侧栏的实色来自元素自身、父级列与底部渐隐遮罩三处。有壁纸时必须一起剥掉，
     * 否则伪元素背后仍是平色；无壁纸时 DSH 的不透明 frame 会盖住负层伪元素，
     * 此时改由父级列直接绘制遮罩，才能让左侧整列真正呈现所选的原生/自定义颜色。
     * 侧栏绝不能加 z-index / isolation：那会创建层叠上下文，
     * 把内部 fixed 弹窗的 z-index 关进侧栏。顶边栏不包含设置弹窗；它的负层伪元素
     * 则必须在自己的层叠上下文里，否则可能落到会话根容器后面，只留下透明度、不显模糊。
     */
    function buildBarsCss(glass, wallpaperActive) {
      const lines = []
      if (get(glass, 'bars.enabled', true) === false) return lines
      const opacity = clamp(get(glass, 'bars.opacity', 1), 0, 1, 1)
      const blur = clamp(get(glass, 'bars.blur', 0), 0, MAX_BLUR, 0)

      const selectors = REGION_SELECTORS.bars
      const scoped = selectors.map((selector) => `html[${ROOT_ATTR}] ${selector}`)
      const pseudo = selectors.map((selector) => `html[${ROOT_ATTR}] ${selector}::before`)

      lines.push(`${scoped.join(',\n')} {`)
      lines.push('  position: relative;')
      lines.push('  background: transparent !important;')
      lines.push('}')

      // 仅隔离顶边栏：把 z-index:-1 的膜留在顶边栏内、内容下。侧栏里有 fixed
      // 设置弹窗，不能对侧栏做相同处理，也不能给顶边栏自身加 backdrop-filter。
      lines.push(`html[${ROOT_ATTR}] .wSkVaW_header { isolation: isolate; }`)

      if (selectors.includes('.hHd-Xa_root')) {
        lines.push(`html[${ROOT_ATTR}] .hHd-Xa_root { --dsw-specific-sidebar-fill: transparent !important; }`)
        lines.push(`html[${ROOT_ATTR}] .pI_x6G_sidebarCol { background: ${wallpaperActive ? 'transparent' : 'var(--ds-ts-bars)'} !important; }`)
      }

      lines.push(`${pseudo.join(',\n')} {`)
      lines.push("  content: '';")
      lines.push('  position: absolute;')
      lines.push('  inset: 0;')
      lines.push('  z-index: -1;')
      lines.push('  pointer-events: none;')
      lines.push('  border-radius: inherit;')
      lines.push('  background-color: var(--ds-ts-bars);')
      if (opacity < 0.995 && blur > 0) {
        lines.push(`  backdrop-filter: blur(${blur}px);`)
        lines.push(`  -webkit-backdrop-filter: blur(${blur}px);`)
      }
      lines.push('}')
      // 边栏原生底色被剥掉后，侧栏右缘与顶栏下缘的分隔线也会看不见。
      // 仅在两层玻璃膜内侧补回原生色描边，不修改全局 elevation，也不占据布局宽度。
      lines.push(`html[${ROOT_ATTR}] .hHd-Xa_root::before { box-shadow: inset -1px 0 0 var(--dsw-alias-border-l1); }`)
      lines.push(`html[${ROOT_ATTR}] .wSkVaW_header::before { background-color: var(--ds-ts-bars-head); box-shadow: inset 0 -1px 0 var(--dsw-alias-border-l1); }`)
      return lines
    }

    /**
     * 调用方没传 resolved 时的兼容兜底：只承认配置里明确指向某张图的 fixed/current。
     *
     * 运行时一定会把 resolveWallpaper 的结果传进来；这里不能拿 source 当作「有图」，
     * folder 候选池是否为空只有运行时知道，所以兜底最多回到显式选择，不能凭来源猜。
     */
    function fallbackResolved(config) {
      const wp = config?.wallpaper ?? {}
      if (wp.source === 'none') return ''
      if (typeof wp.fixed === 'string' && wp.fixed !== '') return wp.fixed
      if (typeof wp.current === 'string' && wp.current !== '') return wp.current
      return ''
    }

    /**
     * 把配置编译成完整样式表。
     *
     * 输出分组依次是：分区变量与暗色变量、表面 token 覆盖、描边/高光、主题色派生、元素级
     * 玻璃规则、背景层与外壳透明。分区关闭时不输出该分区的任何变量、token 与元素规则，
     * 完整还原 DSH 原生；只有壁纸会生效时才允许把外壳调透明。
     *
     * `resolved` 是运行时真正解析出的壁纸文件/URL：连同 enabled、source 一起决定外壳透明、
     * frame 变量与文字阴影是否输出。source 不等于有图（候选池可能为空），resolved 才是判据。
     *
     * 所有数字都先经过 clamp/normalizeRgb，最终 CSS 不允许出现 NaN。
     */
    function buildCss(config, resolved = fallbackResolved(config)) {
      const glass = config.glass ?? {}
      const accent = config.accent ?? {}

      const wallpaperActive =
        config.enabled !== false &&
        (config.wallpaper?.source ?? 'none') !== 'none' &&
        typeof resolved === 'string' &&
        resolved.trim() !== ''

      const lines = []

      const on = (key) => get(glass, `${key}.enabled`, true) !== false
      const alphaOf = (key) => clamp(get(glass, `${key}.opacity`, 1), 0, 1, 1)
      const colorOf = (key, theme, nativeKey = key) => {
        const value = get(glass, `${key}.color`, 'auto')
        const custom = typeof value === 'string' && value !== 'auto' ? parseColor(value) : null
        const alpha = alphaOf(key)
        if (custom !== null) return `rgb(${rgbPair(custom)} / ${alpha.toFixed(3)})`
        const native = `var(${GLASS_NATIVE[nativeKey][theme]})`
        // 对含固有 alpha 的原生菜单色，滑块按比例降低透明度；在 100% 时原样保留。
        return alpha >= 0.995 ? native : `color-mix(in srgb, ${native} ${(alpha * 100).toFixed(1)}%, transparent)`
      }

      const barsOn = on('bars')
      const inputOn = on('input')
      const bubbleOn = on('bubble')
      const assistantOn = on('assistant')
      const menuOn = on('menu')
      const menuA = alphaOf('menu')

      const rootVars = []
      const darkVars = []
      if (wallpaperActive) {
        rootVars.push(['--ds-ts-frame', 'transparent'])
        darkVars.push(['--ds-ts-frame', 'transparent'])
      }
      if (barsOn) {
        rootVars.push(['--ds-ts-bars', colorOf('bars', 'light')], ['--ds-ts-bars-head', colorOf('bars', 'light', 'barsHeader')])
        darkVars.push(['--ds-ts-bars', colorOf('bars', 'dark')], ['--ds-ts-bars-head', colorOf('bars', 'dark', 'barsHeader')])
      }
      if (inputOn) {
        rootVars.push(['--ds-ts-input', colorOf('input', 'light')])
        darkVars.push(['--ds-ts-input', colorOf('input', 'dark')])
      }
      if (bubbleOn) {
        rootVars.push(['--ds-ts-bubble', colorOf('bubble', 'light')], ['--ds-ts-bubble-file', colorOf('bubble', 'light', 'bubbleFile')])
        darkVars.push(['--ds-ts-bubble', colorOf('bubble', 'dark')], ['--ds-ts-bubble-file', colorOf('bubble', 'dark', 'bubbleFile')])
      }
      if (assistantOn) {
        rootVars.push(['--ds-ts-assistant', colorOf('assistant', 'light')])
        darkVars.push(['--ds-ts-assistant', colorOf('assistant', 'dark')])
      }
      if (menuOn) {
        rootVars.push(['--ds-ts-menu', colorOf('menu', 'light')])
        darkVars.push(['--ds-ts-menu', colorOf('menu', 'dark')])
        if (menuA < 0.995 && get(glass, 'menu.color', 'auto') === 'auto') {
          for (const [suffix, native] of [['layer-2', 'menuLayer2'], ['layer-3', 'menuLayer3'], ['tip', 'menuTip']]) {
            rootVars.push([`--ds-ts-menu-${suffix}`, colorOf('menu', 'light', native)])
            darkVars.push([`--ds-ts-menu-${suffix}`, colorOf('menu', 'dark', native)])
          }
        }
      }

      if (rootVars.length > 0) {
        // DSH 的 --dsw-static-* / --dsw-menu-surface-fill 在 body 上声明：
        // 在 html 上定义引用它们的变量，会在 html 计算时因找不到令牌而失效。
        lines.push(`html[${ROOT_ATTR}] body {`)
        for (const [name, value] of rootVars) lines.push(`  ${name}: ${value};`)
        lines.push('}')
      }
      if (darkVars.length > 0) {
        lines.push(`html[${ROOT_ATTR}][data-ds-dark-theme] body, html[${ROOT_ATTR}] body[data-ds-dark-theme] {`)
        for (const [name, value] of darkVars) lines.push(`  ${name}: ${value};`)
        lines.push('}')
      }

      const bodyTokens = []
      if (wallpaperActive) bodyTokens.push(['--dsw-alias-bg-base', 'var(--ds-ts-frame)'])
      if (inputOn) bodyTokens.push(['--dsw-specific-input-major', 'var(--ds-ts-input)'])
      if (bubbleOn) bodyTokens.push(['--dsw-specific-bubble', 'var(--ds-ts-bubble)'])
      const borderA = clamp(get(glass, 'border', 0.6), 0, 1, 0.6)
      const highA = clamp(get(glass, 'highlight', 0.5), 0, 1, 0.5)
      // 默认强度就是「维持 DSH 原生描边与阴影」；只在用户真正改了描边滑块后
      // 才替换 elevation。此前无条件改为白色外描边，导致整个界面边界与原生不同。
      if (borderA !== 0.6) bodyTokens.push(
        ['--dsw-elevation-soft', 'var(--ds-ts-edge)'],
        ['--dsw-elevation-panel', 'var(--ds-ts-edge)'],
        ['--dsw-elevation-prominent', 'var(--ds-ts-edge)'],
        ['--dsw-elevation-stroke-color', 'var(--ds-ts-edge-color)'],
      )
      if (bodyTokens.length > 0) {
        lines.push(`html[${ROOT_ATTR}] body {`)
        for (const [name, value] of bodyTokens) lines.push(`  ${name}: ${value} !important;`)
        lines.push('}')
      }

      if (menuOn && (menuA < 0.995 || get(glass, 'menu.color', 'auto') !== 'auto')) {
        // 不在 body 上改共享令牌：设置面板使用原生 bg-layer-2，必须继续继承 DSH 的
        // 明暗主题值。仅在菜单表面及其后代继承插件令牌，设置面板内的菜单也予以排除。
        const nativeMenu = menuA < 0.995 && get(glass, 'menu.color', 'auto') === 'auto'
        const menuTokens = [
          ['--dsw-alias-bg-layer-2', nativeMenu ? 'var(--ds-ts-menu-layer-2)' : 'var(--ds-ts-menu)'],
          ['--dsw-alias-bg-layer-3', nativeMenu ? 'var(--ds-ts-menu-layer-3)' : 'var(--ds-ts-menu)'],
          ['--dsw-specific-tip', nativeMenu ? 'var(--ds-ts-menu-tip)' : 'var(--ds-ts-menu)'],
          ['--dsw-specific-selector', nativeMenu ? 'var(--ds-ts-menu-tip)' : 'var(--ds-ts-menu)'],
          ['--dsw-specific-menu', 'var(--ds-ts-menu)'],
        ]
        lines.push(`${MENU_GLASS_SELECTORS.map((selector) => `html[${ROOT_ATTR}] ${selector}`).join(',\n')} {`)
        for (const [name, value] of menuTokens) lines.push(`  ${name}: ${value} !important;`)
        lines.push('}')
      }

      if (borderA !== 0.6 || highA !== 0.5) {
        lines.push(`html[${ROOT_ATTR}] {`)
        lines.push(`  --ds-ts-edge-color: rgb(255 255 255 / ${(borderA * 0.42).toFixed(3)});`)
        lines.push(`  --ds-ts-edge: 0 0 0 .5px rgb(255 255 255 / ${(borderA * 0.34).toFixed(3)}), 0 6px 22px rgb(0 0 0 / ${(borderA * 0.16).toFixed(3)});`)
        lines.push(`  --ds-ts-inset: inset 0 1px 0 rgb(255 255 255 / ${(highA * 0.5).toFixed(3)});`)
        lines.push('}')
        lines.push(`html[${ROOT_ATTR}]:has(body[data-ds-dark-theme]), html[${ROOT_ATTR}][data-ds-dark-theme] {`)
        lines.push(`  --ds-ts-edge-color: rgb(255 255 255 / ${(borderA * 0.2).toFixed(3)});`)
        lines.push(`  --ds-ts-edge: 0 0 0 .5px rgb(255 255 255 / ${(borderA * 0.18).toFixed(3)}), 0 6px 22px rgb(0 0 0 / ${(borderA * 0.4).toFixed(3)});`)
        lines.push(`  --ds-ts-inset: inset 0 1px 0 rgb(255 255 255 / ${(highA * 0.28).toFixed(3)});`)
        lines.push('}')
      }

      if (accent.enabled) {
        const rgb = normalizeRgb(accent.rgb)
        const l1 = tint(rgb, 0.72)
        const l2 = tint(rgb, 0.45)
        const base = rgb
        const l5 = mix(rgb, [0, 0, 0], 0.12)
        const l6 = shade(rgb, 0.3)
        const soft = tint(rgb, 0.86)
        const lite = tint(rgb, 0.93)
        lines.push(`html[${ROOT_ATTR}] body {`)
        lines.push(`  --dsw-static-deepseek-100: rgb(${rgbPair(lite)}) !important;`)
        lines.push(`  --dsw-static-deepseek-200: rgb(${rgbPair(soft)}) !important;`)
        lines.push(`  --dsw-static-deepseek-300: rgb(${rgbPair(l2)}) !important;`)
        lines.push(`  --dsw-static-deepseek-400: rgb(${rgbPair(l1)}) !important;`)
        lines.push(`  --dsw-static-deepseek-450: rgb(${rgbPair(l1)}) !important;`)
        lines.push(`  --dsw-static-deepseek-500: rgb(${rgbPair(base)}) !important;`)
        lines.push(`  --dsw-static-deepseek-600: rgb(${rgbPair(l5)}) !important;`)
        lines.push(`  --dsw-static-deepseek-700-delete: rgb(${rgbPair(l6)}) !important;`)
        lines.push(`  --dsw-alias-brand-primary-new-colorprimary-new-color: rgb(${rgbPair(base)}) !important;`)
        lines.push(`  --dsw-alias-link: rgb(${rgbPair(l5)}) !important;`)
        lines.push(`  --dsw-alias-button-info-fill: rgb(${rgbPair(base)}) !important;`)
        lines.push('}')
        lines.push(`html[${ROOT_ATTR}]:has(body[data-ds-dark-theme]) body {`)
        lines.push(`  --dsw-alias-link: rgb(${rgbPair(l1)}) !important;`)
        lines.push('}')
      }

      const backdrop = (key, fallbackOpacity, fallbackBlur) => {
        if (!on(key)) return null
        const opacity = clamp(get(glass, `${key}.opacity`, fallbackOpacity), 0, 1, fallbackOpacity)
        if (opacity >= 0.995) return null
        const blur = clamp(get(glass, `${key}.blur`, fallbackBlur), 0, MAX_BLUR, fallbackBlur)
        return `backdrop-filter: blur(${blur}px); -webkit-backdrop-filter: blur(${blur}px);`
      }

      const regionRule = (key, selectors, vars, fallbackOpacity, fallbackBlur) => {
        const filter = backdrop(key, fallbackOpacity, fallbackBlur)
        if (filter === null) return
        const list = selectors.map((selector) => `html[${ROOT_ATTR}] ${selector}`).join(',\n')
        lines.push(`${list} {`)
        for (const [prop, value] of Object.entries(vars)) lines.push(`  ${prop}: ${value};`)
        lines.push(`  ${filter}`)
        lines.push('}')
      }

      // 没有壁纸时别无条件剥掉原生框架底色。
      if (wallpaperActive) {
        lines.push(`html[${ROOT_ATTR}] .pI_x6G_frame { background: transparent !important; }`)
        if (!barsOn) {
          // 顶边栏原生背景透明，原生实色来自 .wSkVaW_root 的 bg-base。
          // 壁纸运行时 bg-base 必须透明以露出壁纸，因此关闭边栏时只给顶边栏
          // 恢复 DSH bg-base 原本引用的静态明暗色；不能把实色铺到会话根/主区。
          lines.push(`html[${ROOT_ATTR}] .wSkVaW_header { background: var(--dsw-static-neutral-bluish-00, #fff) !important; }`)
          lines.push(`html[${ROOT_ATTR}]:has(body[data-ds-dark-theme]) .wSkVaW_header, html[${ROOT_ATTR}][data-ds-dark-theme] .wSkVaW_header { background: var(--dsw-static-neutral-bluish-950, #151517) !important; }`)
        }
      }

      lines.push(...buildBarsCss(glass, wallpaperActive))

      regionRule('input', INPUT_CARD_SELECTORS, {
        background: 'var(--ds-ts-input)',
        ...(borderA !== 0.6 || highA !== 0.5 ? { 'box-shadow': `var(--ds-ts-inset), ${borderA === 0.6 ? 'var(--dsw-elevation-soft)' : 'var(--ds-ts-edge)'}` } : {}),
      }, 1, 0)
      // DSH 的提问/计划审批卡片已用 --dsw-specific-input-major 获取相同的不透明度；
      // 只补上缺失的模糊，不覆盖卡片原有的阴影、圆角与滚动布局。
      regionRule('input', INPUT_TAKEOVER_SELECTORS, {}, 1, 0)

      regionRule('bubble', ['.Sixlwa_bubble'], {
        background: 'var(--ds-ts-bubble)',
      }, 1, 0)
      regionRule('bubble', ['.Sixlwa_fileCard'], {
        background: 'var(--ds-ts-bubble-file)',
      }, 1, 0)

      if (assistantOn) {
        lines.push(`${REGION_SELECTORS.assistant.map((selector) => `html[${ROOT_ATTR}] ${selector}`).join(',\n')} {`)
        lines.push('  box-sizing: border-box;')
        lines.push('  width: fit-content;')
        lines.push('  max-width: 100%;')
        lines.push('  min-width: 0;')
        lines.push('  padding: 10px 16px;')
        lines.push('  border-radius: var(--dsw-radius-xl);')
        lines.push('  background: var(--ds-ts-assistant);')
        lines.push('}')
        regionRule('assistant', REGION_SELECTORS.assistant, {}, 1, 0)
      }

      if (menuA < 0.995 || get(glass, 'menu.color', 'auto') !== 'auto') {
        regionRule('menu', MENU_GLASS_SELECTORS, {
          'background-color': 'var(--ds-ts-menu)',
        }, 1, 0)
      }

      lines.push(BACKGROUND_LAYER_CSS)
      if (wallpaperActive) {
        lines.push(SHELL_TRANSPARENT_CSS)
        lines.push(`html[${ROOT_ATTR}] body {`)
        lines.push('  text-shadow: 0 0 1px rgb(0 0 0 / .06);')
        lines.push('}')
        lines.push(`html[${ROOT_ATTR}]:has(body[data-ds-dark-theme]) body {`)
        lines.push('  text-shadow: 0 0 1.5px rgb(0 0 0 / .35);')
        lines.push('}')
      }

      return lines.join('\n')
    }

    /**
     * 复用或创建带插件归属标记的 <style>，避免重复注入，也让宿主的样式管理能识别来源。
     */
    function injectStyle(css) {
      let tag = document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`)
      if (tag === null) {
        tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-theme-studio'
        tag.dataset.pluginCss = STYLE_ID
        document.head.appendChild(tag)
      }
      tag.textContent = css
    }


    /**
     * 生成噪点纹理的 data URL；强度为 0 时返回 none。SVG 内联后转义 # 与引号，保证整段 URL 能安全放进 CSS。
     */
    function noiseLayer(strength) {
      if (!Number.isFinite(strength) || strength <= 0.001) return 'none'
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160">` +
        `<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch"/>` +
        `<feColorMatrix type="saturate" values="0"/></filter>` +
        `<rect width="160" height="160" filter="url(%23n)" opacity="${strength.toFixed(3)}"/></svg>`
      return `url("data:image/svg+xml;utf8,${svg.replace(/#/g, '%23').replace(/"/g, "'")}")`
    }

    /**
     * 读取响应并尽量解析 JSON。
     *
     * 不直接调用 response.json()：宿主尚未注册新路由时会返回空 body 的 404，json() 会抛出
     * 难以理解的解析错误。这里保留状态码和原始文本，交给 describeHostFailure 翻译。
     */
    async function readJsonResponse(response) {
      let raw = ''
      try {
        raw = await response.text()
      } catch {
        return { status: response.status, body: null, raw: '' }
      }
      try {
        return { status: response.status, body: JSON.parse(raw), raw }
      } catch {
        return { status: response.status, body: null, raw }
      }
    }

    /**
     * 把宿主失败响应翻译成面板可读的中文；优先采用响应体自带的 error，其次按状态码区分
     * 404 / 405 / 网络失败，其余状态附带截断后的响应原文。
     */
    function describeHostFailure(result, what) {
      if (result.body?.error !== undefined) return String(result.body.error)
      if (result.status === 404) {
        return `${what}失败：宿主没有这个接口（HTTP 404）。这个功能需要**重启 dsh web** 才会生效 —— 浏览器半侧刷新页面就行，宿主半侧不行。`
      }
      if (result.status === 405) return `${what}失败：请求方式不对（HTTP 405）`
      if (result.status === 0) return `${what}失败：请求没能到达宿主`
      const body = result.raw.trim().slice(0, 120)
      return `${what}失败：HTTP ${result.status}${body === '' ? '（响应体为空）' : ` — ${body}`}`
    }

    /**
     * 转义 CSS 双引号字符串里的反斜杠、引号和 ASCII 控制字符，阻断 CSS 声明注入。
     */
    function cssString(value) {
      return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/[\u0000-\u001f\u007f]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `)
    }

    function unescapeCssString(value) {
      return String(value ?? '').replace(/\\(?:([0-9a-f]{1,6})\s?|([\s\S]))/gi, (match, hex, char) => {
        if (hex === undefined) return char
        const code = parseInt(hex, 16)
        return code <= 0x10ffff ? String.fromCodePoint(code) : '\uFFFD'
      })
    }

    /**
     * 把壁纸值编译成 CSS url()。
     *
     * 只接受本站 /theme-studio 路径、http(s) 代理、已登记来源的 data/blob，以及本地绝对路径；
     * 远程地址经宿主代理，本地路径经 /api/image 读取。其他协议一律返回 none，避免不可信值
     * 进入样式表。
     */
    function toCssUrl(source, value) {
      if (value === undefined || value === null || value === '') return 'none'
      const text = String(value)
      const quoted = (url) => `url("${cssString(url)}")`

      if (text.startsWith('/theme-studio/')) return quoted(text)
      if (/^https?:\/\//i.test(text)) return quoted(`${API}/proxy?url=${encodeURIComponent(text)}`)
      if (/^(?:data|blob):/i.test(text)) {
        const fromStoredConfig = source === 'url' || source === 'upload'
        const clean = !/["'\u0000-\u001f\u007f]/.test(text)
        return fromStoredConfig && clean ? quoted(text) : 'none'
      }
      if (/^[a-zA-Z]:[\\/]/.test(text) || /^[\\/]/.test(text)) {
        return quoted(`${API}/image?path=${encodeURIComponent(text)}`)
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return 'none'
      return quoted(`${API}/image?path=${encodeURIComponent(text)}`)
    }

    /**
     * 从 url("…") 中还原地址；格式不完整或无法解析时返回空串。
     */
    function cleanCssUrl(cssUrl) {
      if (typeof cssUrl !== 'string') return ''
      const match = /^url\(\s*(?:"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'|([^)]*))\s*\)$/i.exec(cssUrl.trim())
      if (match === null) return ''
      const body = match[1] ?? match[2] ?? match[3] ?? ''
      return unescapeCssString(body.trim())
    }

    /**
     * 固定背景层的 DOM 生命周期与加载探测。
     *
     * 元素只在有可用壁纸时创建，关闭或清空后立即销毁。apply 用临时 Image 预加载实际 URL，
     * 把加载失败原因交回面板，而不是让页面静默变成纯色。
     */
    class BackgroundLayer {
      constructor() {
        this.element = null
        this.imageEl = null
      }

      ensure() {
        if (this.element !== null && this.element.isConnected) return
        const host = document.createElement('div')
        host.id = BG_ID
        host.setAttribute('aria-hidden', 'true')
        const base = document.createElement('div')
        base.className = 'ds-ts-bg-base'
        const image = document.createElement('div')
        image.className = 'ds-ts-bg-image'
        const vignette = document.createElement('div')
        vignette.className = 'ds-ts-bg-vignette'
        const noise = document.createElement('div')
        noise.className = 'ds-ts-bg-noise'
        const dim = document.createElement('div')
        dim.className = 'ds-ts-bg-dim'
        host.append(base, image, vignette, noise, dim)
        document.documentElement.appendChild(host)
        this.element = host
        this.imageEl = image
      }

      destroy() {
        this.element?.remove()
        this.element = null
        this.imageEl = null
      }

      apply(config, resolved) {
        const wp = config.wallpaper ?? {}
        const active = config.enabled !== false && wp.source !== 'none' && Boolean(resolved)
        if (!active) {
          this.destroy()
          return Promise.resolve({ ok: true, skipped: true })
        }
        this.ensure()
        const element = this.element
        const fit = wp.fit ?? 'cover'
        const position = WALLPAPER_POSITIONS.includes(wp.position) ? wp.position : 'center'
        const size = fit === 'repeat' ? 'auto' : fit === 'center' ? 'auto' : fit
        const cssUrl = toCssUrl(wp.source, resolved)
        element.style.setProperty('--ds-ts-bg-url', cssUrl)
        element.style.setProperty('--ds-ts-bg-size', size)
        element.style.setProperty('--ds-ts-bg-repeat', fit === 'repeat' ? 'repeat' : 'no-repeat')
        element.style.setProperty('--ds-ts-bg-position', position)
        // cover 只按原图宽高比铺满这一层，background-position 决定多余部分从哪边裁切。
        // 不放大/移动图片层：右对齐必须是原图右边缘贴视口，而不是靠缩放制造位移。
        this.imageEl.style.setProperty('background-position', position)
        element.style.setProperty('--ds-ts-bg-blur', `${clamp(wp.blur, 0, 60, 0)}px`)
        element.style.setProperty('--ds-ts-bg-brightness', String(clamp(wp.brightness, 0.2, 2, 1)))
        element.style.setProperty('--ds-ts-bg-saturate', String(clamp(wp.saturation, 0, 2, 1)))
        element.style.setProperty('--ds-ts-bg-dim', String(clamp(wp.dim, 0, 0.9, 0)))
        element.style.setProperty('--ds-ts-bg-dim-rgb', rgbPair(parseColor(wp.dimColor) ?? [0, 0, 0]))
        element.style.setProperty('--ds-ts-bg-vignette', String(clamp(wp.vignette, 0, 1, 0)))
        element.style.setProperty('--ds-ts-bg-noise', noiseLayer(clamp(wp.noise, 0, 0.2, 0)))
        if (cssUrl === 'none') {
          return Promise.resolve({ ok: false, reason: '壁纸地址不受支持，已拒绝加载', url: '' })
        }
        const url = cleanCssUrl(cssUrl)
        return new Promise((resolve) => {
          const probe = new Image()
          probe.onload = () => {
            resolve({ ok: true, width: probe.naturalWidth, height: probe.naturalHeight })
          }
          probe.onerror = () => {
            resolve({ ok: false, reason: '图片无法加载', url })
          }
          probe.src = url
        })
      }
    }


    /**
     * 主题运行时：持有配置、同步 DOM，并向面板广播。
     *
     * 配置以宿主为权威源，本地缓存只负责首帧；所有应用动作都汇入 apply，避免样式、背景层
     * 和订阅者各自维护一份状态。
     */
    class ThemeRuntime {
      constructor() {
        this.config = defaultConfig()
        this.background = new BackgroundLayer()
        this.wallpapers = []
        this.resolved = ''
        this.pendingWallpaper = ''
        this.sessionPick = ''
        this.sessionPickSignature = null
        this.lastLoadResult = null
        this.listeners = new Set()
      }

      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      }

      emit() {
        for (const listener of this.listeners) {
          try {
            listener(this.config)
          } catch (error) {
            console.error('[theme-studio] listener failed', error)
          }
        }
      }

      /**
       * 启动加载：优先采用宿主配置，失败时保留默认值；刷新候选后统一 apply 并广播。
       * 返回值为首帧配置，便于调用方等待完成。
       */
      async load() {
        try {
          const response = await fetch(`${API}/config`, { cache: 'no-store' })
          const payload = (await readJsonResponse(response)).body
          if (payload?.config) this.config = sanitizeConfig(payload.config)
        } catch (error) {
          console.warn('[theme-studio] 读取配置失败，使用默认值', error)
        }
        await this.refreshWallpapers()
        this.apply(this.config)
        this.emit()
        return this.config
      }

      async refreshWallpapers() {
        try {
          const response = await fetch(`${API}/folders`, { cache: 'no-store' })
          const payload = (await readJsonResponse(response)).body
          const items = []
          for (const group of payload?.groups ?? []) {
            for (const item of group.items ?? []) items.push(item.path)
          }
          this.wallpapers = items
        } catch (error) {
          console.warn('[theme-studio] 扫描壁纸目录失败', error)
        }
      }

      /**
       * 按来源选择候选池：URL 来源取登记链接，其余取最近一次扫描结果。
       */
      wallpaperPool(config) {
        const wp = config?.wallpaper ?? {}
        return wp.source === 'url' ? toList(wp.urls) : toList(this.wallpapers)
      }

      /**
       * 候选池签名，用来稳定「会话内随机」的选择。
       *
       * 签名覆盖来源、登记目录、链接与扫描结果，并先排序再序列化，只有候选集合真的变化才
       * 允许重抽。玻璃、主题色等无关配置不进入签名，拖动滑块不应导致壁纸乱跳。
       */
      wallpaperSignature(config) {
        const wp = config?.wallpaper ?? {}
        return JSON.stringify([
          wp.source ?? 'none',
          [...toList(wp.folders)].sort(),
          [...toList(wp.urls)].sort(),
          [...toList(this.wallpapers)].sort(),
        ])
      }

      /**
       * 解析本次要显示的壁纸，优先级依次为：pendingWallpaper（刚选中的一次性覆盖）→ fixed
       * （显式选择）→ current（仍有效的上次值）→ 会话内随机（按候选池签名缓存）。
       *
       * 显式选择即使暂时不在候选池里也保留，让加载失败提示说明原因；folder 来源的 current
       * 则要求仍在扫描结果中，避免悬挂路径。source 为 none 时始终返回空串。
       */
      resolveWallpaper(config) {
        const wp = config?.wallpaper ?? {}
        if (this.pendingWallpaper !== '') {
          const pending = this.pendingWallpaper
          this.pendingWallpaper = ''
          return pending
        }
        if (wp.source === 'none') return ''
        if (wp.fixed) return wp.fixed
        if (wp.current) {
          if (wp.source !== 'folder' || toList(this.wallpapers).includes(wp.current)) return wp.current
        }
        const pool = this.wallpaperPool(config)
        if (pool.length === 0) return ''
        const signature = this.wallpaperSignature(config)
        if (this.sessionPickSignature !== signature) {
          this.sessionPick = pool[Math.floor(Math.random() * pool.length)]
          this.sessionPickSignature = signature
        }
        return this.sessionPick
      }

      /**
       * 用户主动换一张：排除当前值后随机抽取；没有可选值时返回空串，调用方必须先判空。
       */
      pickRandomWallpaper(exclude = this.resolved) {
        const pool = this.wallpaperPool(this.config).filter((item) => item !== exclude)
        if (pool.length === 0) return ''
        return pool[Math.floor(Math.random() * pool.length)]
      }

      /**
       * 把配置应用到文档；关闭时撤掉根属性、样式表与背景层，不留下接管痕迹。壁纸解析统一
       * 走 resolveWallpaper，保证重复 apply 不会无故更换图片。
       *
       * 必须先解析出 resolved 再生成 CSS：外壳透明只在壁纸真的会生效时才允许输出，
       * 没有可用壁纸（候选为空 / 宿主不可达）时必须把原生底色留给 DSH。
       */
      apply(config) {
        this.config = config
        const enabled = config.enabled !== false
        const root = document.documentElement
        if (!enabled) {
          root.removeAttribute(ROOT_ATTR)
          document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`)?.remove()
          this.background.destroy()
          this.lastLoad = Promise.resolve({ ok: true, skipped: true })
          return this.lastLoad
        }
        root.setAttribute(ROOT_ATTR, '')
        this.resolved = this.resolveWallpaper(config)
        injectStyle(buildCss(config, this.resolved))
        this.lastLoad = this.background.apply(config, this.resolved).then((result) => {
          this.lastLoadResult = result
          this.emit()
          return result
        })
        return this.lastLoad
      }

      patch(path, value) {
        const next = setIn(this.config, path, value)
        this.apply(next)
        this.emit()
        return next
      }

      /**
       * 用完整的权威配置替换并重新应用；宿主回写与重置都走这里，确保内存、画面和订阅者同步。
       */
      setConfig(next) {
        this.config = next
        this.apply(next)
        this.emit()
      }

      destroy() {
        document.documentElement.removeAttribute(ROOT_ATTR)
        document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`)?.remove()
        this.background.destroy()
      }
    }

    function labelOf(element) {
      const classes = String(element.className ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join('.')
      const tag = element.tagName?.toLowerCase() ?? '?'
      return classes === '' ? tag : `${tag}.${classes}`
    }

    /**
     * 在真实 DOM 上运行每个分区的选择器，报告命中数与首个命中元素。
     *
     * 必需分区 0 命中视为故障；条件分区只在特定界面状态渲染，0 命中是正常结果，面板用中性
     * 色显示。非法选择器记为 count=-1，它属于代码错误，不能和失配混为一谈。
     */
    function diagnose() {
      const report = []
      for (const region of REGIONS) {
        const selectors = REGION_SELECTORS[region.key] ?? []
        const hits = []
        for (const selector of selectors) {
          let count = 0
          let sample = ''
          try {
            const found = document.querySelectorAll(selector)
            count = found.length
            if (count > 0) sample = labelOf(found[0])
          } catch {
            count = -1
          }
          hits.push({ selector, count, sample })
        }
        const matched = hits.filter((hit) => hit.count > 0).length
        const invalid = hits.filter((hit) => hit.count < 0).length
        const required = region.required !== false
        const ok = !required || matched > 0
        report.push({ region: region.key, zh: region.zh, note: region.note ?? '', required, hits, matched, total: hits.length, invalid, ok })
      }
      return report
    }


    /**
     * 面板样式，全部使用 ds-ts- 前缀与 DSW 设计令牌，不依赖 DSH 内部类名。
     */
    const PANEL_CSS = `
.ds-ts-page { display: flex; flex-direction: column; gap: 18px; max-width: 860px; padding: 4px 2px 40px; }
.ds-ts-page h2 { font-size: 15px; font-weight: 600; margin: 0; color: var(--dsw-alias-label-primary); }
.ds-ts-page p { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.ds-ts-card { border: .5px solid var(--dsw-alias-border-l2); border-radius: 14px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.ds-ts-card > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; }
.ds-ts-card > header .ds-ts-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.ds-ts-card > header .ds-ts-sub { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.ds-ts-body { padding: 0 16px 16px; display: flex; flex-direction: column; gap: 14px; }
.VOzbGW_overlay:has(.ds-ts-page[data-ds-ts-preview]) .VOzbGW_mask { background: transparent !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
.VOzbGW_overlay:has(.ds-ts-page[data-ds-ts-preview]) .VOzbGW_panel { background: transparent !important; box-shadow: none !important; }
.VOzbGW_overlay:has(.ds-ts-page[data-ds-ts-preview]) .VOzbGW_nav,
.VOzbGW_overlay:has(.ds-ts-page[data-ds-ts-preview]) .VOzbGW_header,
.VOzbGW_overlay:has(.ds-ts-page[data-ds-ts-preview]) .ds-ts-page > :not(.ds-ts-tabpanel),
.VOzbGW_overlay:has(.ds-ts-page[data-ds-ts-preview]) .ds-ts-tabpanel > :not(.ds-ts-card[data-ds-ts-preview-card]) { visibility: hidden !important; }
.ds-ts-row { display: flex; align-items: center; gap: 12px; min-height: 28px; }
.ds-ts-row .ds-ts-name { flex: none; width: 128px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.ds-ts-row .ds-ts-val { flex: none; width: 74px; font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary); }
.ds-ts-slider { flex: 1; appearance: none; -webkit-appearance: none; height: 4px; border-radius: 999px; background: var(--dsw-alias-border-l3); outline: none; cursor: pointer; }
.ds-ts-slider::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: var(--ds-ts-accent, var(--dsw-alias-brand-primary-new-colorprimary-new-color)); border: 2px solid var(--dsw-alias-bg-layer-2); box-shadow: 0 1px 3px rgb(0 0 0 / .25); }
.ds-ts-slider::-moz-range-thumb { width: 14px; height: 14px; border: 2px solid var(--dsw-alias-bg-layer-2); border-radius: 50%; background: var(--ds-ts-accent, #4176e6); }
.ds-ts-text, .ds-ts-select, .ds-ts-num { box-sizing: border-box; padding: 6px 10px; font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: .5px solid var(--dsw-alias-border-l2); border-radius: 8px; outline: none; }
.ds-ts-text:focus, .ds-ts-select:focus, .ds-ts-num:focus { border-color: var(--dsw-alias-brand-primary-new-colorprimary-new-color); }
.ds-ts-color { flex: none; width: 42px; height: 30px; padding: 3px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); cursor: pointer; }
.ds-ts-color:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color); outline-offset: 2px; }
.ds-ts-color-preview { display: block; width: 100%; height: 100%; border-radius: 5px; box-shadow: inset 0 0 0 .5px rgb(0 0 0 / .18); }
.ds-ts-color-status { flex: 1; min-width: 0; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.ds-ts-color-popover:not(:popover-open) { display: none; }
.ds-ts-color-popover:popover-open { box-sizing: border-box; position: fixed; display: flex; flex-direction: column; gap: 10px; width: 292px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); margin: 0; padding: 12px; overflow-y: auto; border: .5px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 12px 36px rgb(0 0 0 / .22); }
.ds-ts-color-field { position: relative; flex: none; height: 172px; border-radius: 6px; background: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent); cursor: crosshair; touch-action: none; }
.ds-ts-color-field:focus-visible, .ds-ts-color-preset:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color); outline-offset: 2px; }
.ds-ts-color-cursor { position: absolute; width: 12px; height: 12px; border: 2px solid #fff; border-radius: 50%; box-shadow: 0 0 0 1px rgb(0 0 0 / .55); transform: translate(-50%, -50%); pointer-events: none; }
.ds-ts-color-hue { width: 100%; height: 14px; margin: 1px 0; appearance: none; -webkit-appearance: none; border-radius: 999px; background: linear-gradient(to right, red, yellow, lime, cyan, blue, magenta, red); cursor: pointer; }
.ds-ts-color-hue::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; width: 14px; height: 14px; border: 2px solid #fff; border-radius: 50%; background: transparent; box-shadow: 0 0 0 1px rgb(0 0 0 / .55); }
.ds-ts-color-hue::-moz-range-thumb { width: 14px; height: 14px; border: 2px solid #fff; border-radius: 50%; background: transparent; box-shadow: 0 0 0 1px rgb(0 0 0 / .55); }
.ds-ts-color-presets { display: flex; align-items: center; gap: 8px; }
.ds-ts-color-preset { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.ds-ts-color-preset[data-active=true] { border-color: var(--dsw-alias-brand-primary-new-colorprimary-new-color); }
.ds-ts-color-preset > span { width: 17px; height: 17px; border: .5px solid rgb(0 0 0 / .2); border-radius: 4px; }
.ds-ts-color-rgb { display: flex; align-items: center; justify-content: center; gap: 8px; }
.ds-ts-color-rgb label { display: flex; flex: 1; flex-direction: column; align-items: center; gap: 3px; font-size: 11px; }
.ds-ts-color-rgb input { box-sizing: border-box; width: 100%; min-width: 0; height: 32px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 5px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; text-align: center; }
.ds-ts-color-native { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.ds-ts-color-native input { width: 28px; height: 26px; padding: 1px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 5px; background: transparent; cursor: pointer; }
.ds-ts-dim-color { padding-left: 140px; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.ds-ts-dim-toggle { display: inline-flex; align-items: center; gap: 8px; }
.ds-ts-dim-panel { box-sizing: border-box; width: 100%; display: flex; flex-direction: column; gap: 6px; }
.ds-ts-dim-panel .ds-ts-row { flex-wrap: wrap; }
.ds-ts-dim-panel .ds-ts-name { width: auto; }
@media (max-width: 650px) { .ds-ts-dim-color { padding-left: 0; } }
.ds-ts-btn:disabled { opacity: .5; cursor: default; }
.ds-ts-text { flex: 1; min-width: 0; }
.ds-ts-num { width: 88px; font-variant-numeric: tabular-nums; }
.ds-ts-btn { flex: none; padding: 6px 12px; font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: .5px solid var(--dsw-alias-border-l2); border-radius: 8px; cursor: pointer; white-space: nowrap; }
.ds-ts-btn:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ds-ts-btn[data-variant=primary] { color: var(--dsw-alias-label-primary-inverted); background: var(--dsw-alias-brand-primary-new-colorprimary-new-color); border-color: transparent; }
.ds-ts-btn[data-variant=ghost] { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
.ds-ts-btn[data-variant=danger] { color: var(--dsw-alias-state-error-primary); }
.ds-ts-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.ds-ts-chip { display: inline-flex; align-items: center; gap: 7px; padding: 5px 11px; font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border: .5px solid var(--dsw-alias-border-l2); border-radius: 999px; cursor: pointer; }
.ds-ts-chip[data-active=true] { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-brand-primary-new-colorprimary-new-color); box-shadow: inset 0 0 0 1px var(--dsw-alias-brand-primary-new-colorprimary-new-color); }
.ds-ts-swatch { width: 12px; height: 12px; border-radius: 50%; box-shadow: inset 0 0 0 .5px rgb(0 0 0 / .25); }
.ds-ts-path { display: flex; gap: 8px; align-items: center; }
.ds-ts-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.ds-ts-list li { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border: .5px solid var(--dsw-alias-border-l1); border-radius: 8px; }
.ds-ts-list li .ds-ts-mono { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--ds-font-family-code, monospace); }
.ds-ts-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 10px; }
/* 缩略图容器：只负责定位与圆角裁剪，本身不再可点击。
   点击目标与删除按钮是它的两个兄弟子节点，因此点 ✕ 绝不会连带触发「应用为壁纸」。 */
.ds-ts-thumb { position: relative; border: .5px solid var(--dsw-alias-border-l2); border-radius: 10px; overflow: hidden; aspect-ratio: 16 / 10; background: var(--dsw-alias-bg-skeleton, rgb(0 0 0 / .06)); }
.ds-ts-thumb[data-active=true] { border-color: var(--dsw-alias-brand-primary-new-colorprimary-new-color); box-shadow: 0 0 0 2px var(--dsw-alias-brand-primary-new-colorprimary-new-color); }
/* 选图按钮：铺满容器承载图片与文件名角标。 */
.ds-ts-thumb-pick { display: block; width: 100%; height: 100%; margin: 0; padding: 0; border: none; background: none; cursor: pointer; }
.ds-ts-thumb-pick img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ds-ts-thumb-pick:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary-new-colorprimary-new-color); outline-offset: -2px; }
/* 文件名角标：必须用专属类名。
   早期写成 .ds-ts-thumb span { position:absolute; left:0; right:0; bottom:0 }，
   把删除按钮内部的文案 span 也一起命中了 —— 那两个 span 各自被拉成整行宽度、
   文字从左边溢出，看上去就像「按钮往右偏出去了」。
   注意：这段 CSS 在模板字符串里，注释中不能出现反引号。 */
.ds-ts-thumb-name { position: absolute; left: 0; right: 0; bottom: 0; padding: 3px 6px; font-size: 11px; line-height: 15px; color: #fff; text-align: left; background: linear-gradient(transparent, rgb(0 0 0 / .65)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; pointer-events: none; }
/* 悬停删除：只放一个 ✕ 圆形按钮，悬停时不显示任何文字（按用户要求）。
   默认透明且不接收指针事件，避免盖住选图按钮的点击区域。 */
.ds-ts-thumb-del { position: absolute; top: 6px; right: 6px; z-index: 2; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; font: inherit; color: #fff; background: rgb(0 0 0 / .66); border: none; border-radius: 999px; cursor: pointer; opacity: 0; transform: translateY(-3px); transition: opacity .14s var(--ds-ease-in-out, ease), transform .14s var(--ds-ease-in-out, ease), background-color .14s ease; pointer-events: none; backdrop-filter: blur(6px); }
.ds-ts-thumb:hover .ds-ts-thumb-del, .ds-ts-thumb:focus-within .ds-ts-thumb-del { opacity: 1; transform: none; pointer-events: auto; }
.ds-ts-thumb-del:hover { background: var(--dsw-alias-state-error-primary, #d54941); }
.ds-ts-thumb-del:focus-visible { opacity: 1; transform: none; pointer-events: auto; outline: 2px solid #fff; outline-offset: 1px; }
.ds-ts-thumb-del-x { font-size: 12px; line-height: 1; font-weight: 700; }
/* 触屏没有 hover：正文常显，否则根本点不到。 */
@media (hover: none) {
  .ds-ts-thumb-del { opacity: 1; transform: none; pointer-events: auto; }
}
.ds-ts-tabs { display: flex; gap: 4px; padding: 3px; background: var(--dsw-alias-bg-layer-1); border: .5px solid var(--dsw-alias-border-l1); border-radius: 10px; align-self: flex-start; }
.ds-ts-tabs button { padding: 5px 14px; font: inherit; font-size: 13px; color: var(--dsw-alias-label-secondary); background: transparent; border: none; border-radius: 8px; cursor: pointer; }
.ds-ts-tabs button[data-active=true] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-3); box-shadow: var(--dsw-shadow-lv1); }
/* 标签页正文容器（role=tabpanel）不能生成盒子：
   .ds-ts-page 是 flex 列 + gap:18px，卡片间距由父级 gap 提供。包裹层一旦有盒子，
   卡片就不再是 .ds-ts-page 的直接 flex 子项，间距消失。display:contents 只保留
   语义、不参与布局，卡片位置与改动前完全一致。 */
.ds-ts-tabpanel { display: contents; }
.ds-ts-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.ds-ts-warn { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-primary); }
.ds-ts-err { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.ds-ts-ok { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-success-primary); }
.ds-ts-foot { display: flex; align-items: center; gap: 10px; }
.ds-ts-spacer { flex: 1; }
/* 自检明细。
   这一整块是为了修掉一个真实故障：原先整份报告挤在一条 .ds-ts-mono 里，
   而那条规则带 white-space: nowrap 加 text-overflow: ellipsis（本是给
   「文件夹 / URL 列表」的一行一短路径用的），6 条选择器拼成的长串必然被省略号吃掉。
   现在改成「每分区一行、点开看明细、每条选择器独占一行并允许换行」。
   注意：这段 CSS 在模板字符串里，注释中不能出现反引号。 */
.ds-ts-diag { display: flex; flex-direction: column; gap: 6px; }
.ds-ts-diag-row { border: .5px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; background: var(--dsw-alias-bg-layer-1); }
.ds-ts-diag-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 10px; font: inherit; font-size: 12px; text-align: left; color: var(--dsw-alias-label-secondary); background: none; border: none; cursor: pointer; }
.ds-ts-diag-head:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ds-ts-diag-name { flex: none; width: 64px; font-size: 12px; color: var(--dsw-alias-label-primary); }
.ds-ts-diag-count { flex: 1; min-width: 0; overflow-wrap: anywhere; font-family: var(--ds-font-family-code, monospace); }
.ds-ts-diag-status { flex: none; font-size: 12px; }
.ds-ts-diag-status[data-tone=ok] { color: var(--dsw-alias-state-success-primary); }
.ds-ts-diag-status[data-tone=warn] { color: var(--dsw-alias-state-error-primary); }
.ds-ts-diag-status[data-tone=soft] { color: var(--dsw-alias-label-tertiary); }
.ds-ts-diag-caret { flex: none; width: 12px; font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.ds-ts-diag-body { padding: 0 10px 8px 10px; }
.ds-ts-diag-list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.ds-ts-diag-list li { padding: 5px 8px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.ds-ts-diag-sel { display: block; overflow-wrap: anywhere; font-family: var(--ds-font-family-code, monospace); font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-secondary); }
.ds-ts-diag-sel[data-count="0"] { color: var(--dsw-alias-label-tertiary); }
/* 非法选择器必须显眼：那是**真**故障（写错了），不是「没命中」。 */
.ds-ts-diag-sel[data-count="-1"] { color: var(--dsw-alias-state-error-primary); }
.ds-ts-diag-meta { display: block; margin-top: 2px; overflow-wrap: anywhere; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.ds-ts-diag-note { margin-top: 6px; }
`

    const PANEL_STYLE_ID = 'dsh-theme-studio/panel.css'
    let panelCssInjected = false

    /**
     * 面板样式只注入一次；先查已存在的 <style>，避免热重载或重复挂载产生多份副本。
     */
    function injectPanelCss() {
      if (panelCssInjected) return
      const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(PANEL_STYLE_ID)}]`)
      if (existing === null) {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-theme-studio'
        tag.dataset.pluginCss = PANEL_STYLE_ID
        tag.textContent = PANEL_CSS
        document.head.appendChild(tag)
      }
      panelCssInjected = true
    }


    let fallbackIdSeq = 0

    /**
     * 生成供 aria-labelledby / aria-controls 使用的稳定 id。
     *
     * 优先使用 React.useId；最小化测试桩没有这个 Hook，因此在模块加载时做一次特性检测，
     * 缺省时退回自增编号，不能把 Hook 放进条件分支。
     */
    const useDomId = typeof React.useId === 'function'
      ? () => React.useId()
      : () => {
          fallbackIdSeq += 1
          return `dsh-ts-id-${fallbackIdSeq}`
        }

    const SLIDER_PREVIEW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])
    let activeSliderPreview = null

    function endSliderPreview(slider) {
      const active = activeSliderPreview
      if (active === null || (slider !== undefined && slider !== active.slider)) return
      activeSliderPreview = null
      if (active.frame !== null) window.cancelAnimationFrame?.(active.frame)
      active.card.removeAttribute('data-ds-ts-preview-card')
      active.page.removeAttribute('data-ds-ts-preview')
      window.removeEventListener?.('pointerup', active.onPointerEnd, true)
      window.removeEventListener?.('pointercancel', active.onPointerEnd, true)
      window.removeEventListener?.('keyup', active.onKeyEnd, true)
      window.removeEventListener?.('blur', active.onWindowBlur, true)
    }

    /** 先让浏览器完成 range 的焦点与指针捕获，再隐藏其它卡片；原卡片祖先始终可见。 */
    function beginSliderPreview(slider, pointerId) {
      if (activeSliderPreview?.slider === slider) return
      endSliderPreview()
      const card = slider?.closest?.('.ds-ts-card')
      const page = card?.closest?.('.ds-ts-page')
      if (!page?.closest?.('.VOzbGW_overlay')) return
      const onPointerEnd = (event) => {
        if (pointerId === undefined || event.pointerId === pointerId) endSliderPreview(slider)
      }
      const onKeyEnd = (event) => {
        if (SLIDER_PREVIEW_KEYS.has(event.key) || event.key === 'Escape') endSliderPreview(slider)
      }
      const onWindowBlur = () => endSliderPreview(slider)
      const active = { slider, card, page, pointerId, onPointerEnd, onKeyEnd, onWindowBlur, frame: null, show: null }
      activeSliderPreview = active
      window.addEventListener?.('pointerup', onPointerEnd, true)
      window.addEventListener?.('pointercancel', onPointerEnd, true)
      window.addEventListener?.('keyup', onKeyEnd, true)
      window.addEventListener?.('blur', onWindowBlur, true)
      const show = () => {
        if (activeSliderPreview !== active) return
        active.frame = null
        card.setAttribute('data-ds-ts-preview-card', '')
        page.setAttribute('data-ds-ts-preview', '')
      }
      active.show = show
      // 指针首次按下时，立刻改祖先的可见性会干扰原生 range 建立拖动；
      // 下一帧再显现预览。若只是点了一下，pointerup 会取消待执行的帧。
      if (pointerId !== undefined && typeof window.requestAnimationFrame === 'function') {
        active.frame = window.requestAnimationFrame(show)
      } else {
        show()
      }
    }

    /**
     * 名称、滑块与数值组成的行。
     *
     * 名称通过 aria-labelledby 关联到 range，读屏才知道调节项；可见数值对读屏隐藏，改由
     * aria-valuetext 播报带单位的读数，避免同一个数字被念两遍。
     */
    function SliderRow({ label, value, min, max, step, unit, onChange }) {
      const labelId = useDomId()
      const rounded = typeof value === 'number' ? Math.round(value * 100) / 100 : value
      const display = `${rounded}${unit ?? ''}`
      const spoken = unit === undefined ? String(rounded) : `${rounded} ${unit}`
      return h(
        'div',
        { className: 'ds-ts-row' },
        h('div', { className: 'ds-ts-name', id: labelId }, label),
        h('input', {
          className: 'ds-ts-slider',
          type: 'range',
          min,
          max,
          step,
          value,
          'aria-labelledby': labelId,
          'aria-valuetext': spoken,
          onPointerDown: (event) => {
            if (event.button === undefined || event.button === 0) beginSliderPreview(event.currentTarget, event.pointerId)
          },
          onPointerUp: (event) => {
            if (activeSliderPreview?.pointerId === undefined || activeSliderPreview.pointerId === event.pointerId) {
              endSliderPreview(event.currentTarget)
            }
          },
          onPointerCancel: (event) => {
            if (activeSliderPreview?.pointerId === undefined || activeSliderPreview.pointerId === event.pointerId) {
              endSliderPreview(event.currentTarget)
            }
          },
          onKeyDown: (event) => {
            if (event.key === 'Escape') endSliderPreview(event.currentTarget)
            else if (SLIDER_PREVIEW_KEYS.has(event.key)) beginSliderPreview(event.currentTarget)
          },
          onKeyUp: (event) => {
            if (SLIDER_PREVIEW_KEYS.has(event.key)) endSliderPreview(event.currentTarget)
          },
          // 首次指针按下可能短暂改变焦点，不能因此中止拖动；指针由 up/cancel/窗口失焦收尾。
          onBlur: (event) => {
            if (activeSliderPreview?.pointerId === undefined) endSliderPreview(event.currentTarget)
          },
          onChange: (event) => {
            const active = activeSliderPreview
            // 非常快的首次拖动可能先产生 input、后到下一帧：原生控件已经开始调值，
            // 此刻就进入预览，避免松手前都没机会看到效果。
            if (active?.slider === event.currentTarget && active.frame !== null) {
              window.cancelAnimationFrame?.(active.frame)
              active.show()
            }
            onChange(Number(event.target.value))
          },
        }),
        h('div', { className: 'ds-ts-val', 'aria-hidden': 'true' }, display),
      )
    }

    /** 原生取色弹窗不能扩展；Popover 顶层不受卡片 overflow:hidden 裁切。 */
    function GlassColorRow({ label, color, fallback, defaultNote, presets, onChange }) {
      const labelId = useDomId()
      const statusId = useDomId()
      const pickerId = useDomId()
      const isDefault = color === 'auto'
      const shownColor = isDefault ? fallback : color
      const [open, setOpen] = React.useState(false)
      const [draft, setDraft] = React.useState(() => rgbToHsv(parseColor(shownColor) ?? [0, 0, 0]))
      const [rgbFields, setRgbFields] = React.useState(() => (parseColor(shownColor) ?? [0, 0, 0]).map(String))
      const anchorRef = React.useRef(null)
      const popoverRef = React.useRef(null)
      const fieldRef = React.useRef(null)
      const dragging = React.useRef(null)
      const currentRgb = hsvToRgb(draft)

      const updateColor = (next) => {
        setDraft(next)
        const rgb = hsvToRgb(next)
        setRgbFields(rgb.map(String))
        onChange(toHex(rgb))
      }
      const selectColor = (hex) => {
        const rgb = parseColor(hex)
        if (rgb === null) return
        setDraft(rgbToHsv(rgb))
        setRgbFields(rgb.map(String))
        onChange(toHex(rgb))
      }
      const positionPopover = () => {
        const anchor = anchorRef.current
        const popover = popoverRef.current
        if (!anchor || !popover) return
        const rect = anchor.getBoundingClientRect()
        const width = popover.getBoundingClientRect().width
        const height = popover.getBoundingClientRect().height
        const viewportWidth = document.documentElement.clientWidth || window.innerWidth
        const viewportHeight = document.documentElement.clientHeight || window.innerHeight
        popover.style.left = `${Math.max(8, Math.min(rect.left, viewportWidth - width - 8))}px`
        const below = rect.bottom + 6
        const top = below + height + 8 <= viewportHeight ? below : rect.top - height - 6
        popover.style.top = `${Math.max(8, Math.min(top, viewportHeight - height - 8))}px`
      }
      React.useEffect(() => {
        const popover = popoverRef.current
        if (!popover) return
        const onToggle = (event) => setOpen(event.newState === 'open')
        popover.addEventListener('toggle', onToggle)
        return () => popover.removeEventListener('toggle', onToggle)
      }, [])
      React.useEffect(() => {
        if (!open) return
        window.addEventListener('resize', positionPopover)
        document.addEventListener('scroll', positionPopover, true)
        return () => {
          window.removeEventListener('resize', positionPopover)
          document.removeEventListener('scroll', positionPopover, true)
        }
      }, [open])
      const updateField = (event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        const saturation = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
        const brightness = 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
        updateColor({ ...draft, saturation, brightness })
      }
      return h(
        'div',
        { className: 'ds-ts-row' },
        h('div', { className: 'ds-ts-name', id: labelId }, label),
        h('button', {
          className: 'ds-ts-color',
          type: 'button',
          ref: anchorRef,
          'aria-labelledby': labelId,
          'aria-describedby': statusId,
          'aria-haspopup': 'dialog',
          'aria-controls': pickerId,
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => {
            const popover = popoverRef.current
            if (!popover) return
            if (popover.matches(':popover-open')) {
              popover.hidePopover()
              setOpen(false)
              return
            }
            const rgb = parseColor(shownColor) ?? [0, 0, 0]
            setDraft(rgbToHsv(rgb))
            setRgbFields(rgb.map(String))
            popover.showPopover()
            positionPopover()
            setOpen(true)
            fieldRef.current?.focus()
          },
        }, h('span', { className: 'ds-ts-color-preview', style: { backgroundColor: shownColor }, 'aria-hidden': 'true' })),
        h('span', { className: 'ds-ts-color-status', id: statusId },
          isDefault ? defaultNote : color.toUpperCase()),
        h('button', {
          type: 'button',
          className: 'ds-ts-btn',
          'data-variant': 'ghost',
          disabled: isDefault,
          'aria-label': '恢复默认遮罩颜色',
          onClick: () => onChange('auto'),
        }, '恢复默认'),
        h('div', {
          className: 'ds-ts-color-popover',
          id: pickerId,
          popover: 'auto',
          role: 'dialog',
          'aria-label': '调节遮罩颜色',
          ref: popoverRef,
        },
          h('div', {
            className: 'ds-ts-color-field',
            role: 'slider',
            tabIndex: 0,
            ref: fieldRef,
            'aria-label': '颜色饱和度和亮度',
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': Math.round(draft.saturation * 100),
            'aria-valuetext': `饱和度 ${Math.round(draft.saturation * 100)}%，亮度 ${Math.round(draft.brightness * 100)}%`,
            style: { backgroundColor: `hsl(${draft.hue} 100% 50%)` },
            onPointerDown: (event) => {
              if (event.button !== undefined && event.button !== 0) return
              dragging.current = event.pointerId
              event.currentTarget.setPointerCapture?.(event.pointerId)
              updateField(event)
            },
            onPointerMove: (event) => {
              if (dragging.current === event.pointerId) updateField(event)
            },
            onPointerUp: (event) => {
              if (dragging.current === event.pointerId) dragging.current = null
            },
            onPointerCancel: (event) => {
              if (dragging.current === event.pointerId) dragging.current = null
            },
            onKeyDown: (event) => {
              const step = event.shiftKey ? 0.1 : 0.01
              let next = null
              if (event.key === 'ArrowLeft') next = { ...draft, saturation: Math.max(0, draft.saturation - step) }
              if (event.key === 'ArrowRight') next = { ...draft, saturation: Math.min(1, draft.saturation + step) }
              if (event.key === 'ArrowUp') next = { ...draft, brightness: Math.min(1, draft.brightness + step) }
              if (event.key === 'ArrowDown') next = { ...draft, brightness: Math.max(0, draft.brightness - step) }
              if (next !== null) {
                event.preventDefault()
                updateColor(next)
              }
            },
          }, h('span', { className: 'ds-ts-color-cursor', style: {
            left: `${draft.saturation * 100}%`, top: `${(1 - draft.brightness) * 100}%`,
          }, 'aria-hidden': 'true' })),
          h('input', {
            className: 'ds-ts-color-hue', type: 'range', min: 0, max: 360, step: 1,
            value: Math.round(draft.hue), 'aria-label': '色相',
            onChange: (event) => updateColor({ ...draft, hue: Number(event.target.value) }),
          }),
          presets ? h('div', { className: 'ds-ts-color-presets', 'aria-label': '系统浅色与深色预设' },
            ['light', 'dark'].map((theme) => {
              const hex = toHex(presets[theme])
              return h('button', {
                key: theme, type: 'button', className: 'ds-ts-color-preset',
                'data-active': !isDefault && color.toLowerCase() === hex,
                'aria-label': `${theme === 'light' ? '浅色' : '深色'}模式遮罩预设 ${hex}`,
                onClick: () => selectColor(hex),
              }, h('span', { style: { backgroundColor: hex }, 'aria-hidden': 'true' }), theme === 'light' ? '浅色' : '深色')
            })) : null,
          h('div', { className: 'ds-ts-color-rgb' },
            ['R', 'G', 'B'].map((channel, index) => h('label', { key: channel },
              h('input', {
                type: 'text', inputMode: 'numeric', maxLength: 3, value: rgbFields[index],
                'aria-label': `${channel} 通道`,
                onChange: (event) => {
                  const value = event.target.value
                  if (value !== '' && !/^\d{1,3}$/.test(value)) return
                  const next = [...rgbFields]
                  next[index] = value
                  setRgbFields(next)
                  if (next.every((part) => part !== '' && Number(part) <= 255)) selectColor(toHex(next.map(Number)))
                },
                onBlur: () => setRgbFields(hsvToRgb(draft).map(String)),
              }), channel))),
          h('label', { className: 'ds-ts-color-native' },
            h('input', { type: 'color', value: toHex(currentRgb),
              'aria-label': '使用系统取色器选择遮罩颜色',
              onChange: (event) => selectColor(event.target.value),
            }), '系统取色器'),
        ),
      )
    }

    /** 壁纸遮罩颜色默认收起；恢复 auto 后重新使用黑色，强度仍由暗化滑块决定。 */
    function WallpaperDimColor({ color, onChange }) {
      const [open, setOpen] = React.useState(false)
      const contentId = useDomId()
      return h(
        'div',
        { className: 'ds-ts-dim-color' },
        h(
          'button',
          {
            type: 'button',
            className: 'ds-ts-btn ds-ts-dim-toggle',
            'data-variant': 'ghost',
            'aria-expanded': open ? 'true' : 'false',
            'aria-controls': contentId,
            onClick: () => setOpen(!open),
          },
          h('span', { className: 'ds-ts-swatch', style: { backgroundColor: toHex(parseColor(color), '#000000') }, 'aria-hidden': 'true' }),
          '自定义遮罩颜色',
          h('span', { 'aria-hidden': 'true' }, open ? '▴' : '▾'),
        ),
        open
          ? h(
              'div',
              { className: 'ds-ts-dim-panel', id: contentId },
              h(GlassColorRow, {
                label: '遮罩颜色',
                color,
                fallback: '#000000',
                defaultNote: '默认黑色',
                onChange,
              }),
              h('div', { className: 'ds-ts-hint' }, '颜色只改变遮罩色调；遮罩暗化为 0 时不显示遮罩。'),
            )
          : null,
      )
    }

    /**
     * 开关行没有可见文字，名称 id 通过 aria-labelledby 传给 Switch 或原生复选框。
     */
    function SwitchRow({ label, checked, onChange }) {
      const labelId = useDomId()
      const Switch = primitives?.Switch
      return h(
        'div',
        { className: 'ds-ts-row' },
        h('div', { className: 'ds-ts-name', id: labelId }, label),
        typeof Switch === 'function'
          ? h(Switch, { checked, onChange, 'aria-labelledby': labelId })
          : h('input', { type: 'checkbox', checked, onChange: (event) => onChange(event.target.checked), 'aria-labelledby': labelId }),
      )
    }

    /**
     * 下拉行使用原生 select（自带键盘与读屏支持），只需补名称关联。
     */
    function SelectRow({ label, value, options, onChange }) {
      const labelId = useDomId()
      return h(
        'div',
        { className: 'ds-ts-row' },
        h('div', { className: 'ds-ts-name', id: labelId }, label),
        h(
          'select',
          { className: 'ds-ts-select', value, onChange: (event) => onChange(event.target.value), 'aria-labelledby': labelId },
          options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
        ),
      )
    }

    /**
     * 可折叠卡片；按钮用 aria-expanded 与 aria-controls 表达展开状态与受控内容。正文只在
     * 展开时挂载，收起时目标 id 暂时不存在，但控制关系仍然保留。
     */
    function Card({ title, sub, right, children, defaultOpen }) {
      const contentId = useDomId()
      const [open, setOpen] = React.useState(defaultOpen !== false)
      return h(
        'section',
        { className: 'ds-ts-card' },
        h(
          'header',
          null,
          h(
            'div',
            null,
            h('div', { className: 'ds-ts-title' }, title),
            sub ? h('div', { className: 'ds-ts-sub' }, sub) : null,
          ),
          h(
            'div',
            { className: 'ds-ts-foot' },
            right ?? null,
            h(
              'button',
              {
                type: 'button',
                className: 'ds-ts-btn',
                'data-variant': 'ghost',
                'aria-expanded': open ? 'true' : 'false',
                'aria-controls': contentId,
                onClick: () => setOpen(!open),
              },
              open ? '收起' : '展开',
            ),
          ),
        ),
        open ? h('div', { className: 'ds-ts-body', id: contentId }, children) : null,
      )
    }

    /**
     * 候选缩略图。
     *
     * 选图按钮与删除按钮必须是并列的兄弟节点，不能把删除按钮嵌进可点击容器：嵌套会让点
     * ✕ 同时触发选图，阻止冒泡并不可靠。删除语义由 aria-label 表达，不使用原生 title 或
     * 自绘提示气泡。
     */
    function Thumb({ src, name, active, kind, label, onPick, onRemove }) {
      return h(
        'div',
        {
          className: 'ds-ts-thumb',
          'data-active': active === true,
          'data-kind': kind,
        },
        h(
          'button',
          {
            type: 'button',
            className: 'ds-ts-thumb-pick',
            'aria-label': name,
            'aria-pressed': active === true,
            onClick: onPick,
          },
          h('img', { src, loading: 'lazy', alt: '', draggable: 'false' }),
          h('span', { className: 'ds-ts-thumb-name' }, name),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'ds-ts-thumb-del',
            'aria-label': label,
            onClick: onRemove,
          },
          h('span', { className: 'ds-ts-thumb-del-x' }, '✕'),
        ),
      )
    }

    /**
     * 分区自检报告：每个分区一行，展开后逐条列出选择器、命中数与首个命中元素。
     *
     * 条件分区 0 命中显示「正常」并附解释；非法选择器和必需分区失配才用红色故障样式。
     */
    function DiagReport({ items }) {
      const idBase = useDomId()
      const [open, setOpen] = React.useState({})
      const failed = items.filter((item) => !item.ok).length
      const flagged = items.filter((item) => item.invalid > 0).length
      const summary = flagged > 0
        ? '有选择器语法非法，这是真故障 —— 展开标红的那一行看具体哪条。'
        : failed > 0
          ? '有必需分区一条都没命中：DSH 可能升级换了类名，该分区的毛玻璃已失效。'
          : '全部正常。「弹层菜单」显示 0 命中是设计如此，不影响效果。'
      return h(
        'div',
        { className: 'ds-ts-diag' },
        h('div', { className: 'ds-ts-hint' }, summary),
        items.map((item) => {
          const expanded = open[item.region] === true
          const tone = item.invalid > 0 || !item.ok ? 'warn' : item.matched === 0 ? 'soft' : 'ok'
          const status = item.invalid > 0
            ? '选择器非法'
            : item.matched === 0
              ? (item.ok ? '正常' : '未命中')
              : '命中'
          const detailId = `${idBase}-diag-${String(item.region).replace(/[^A-Za-z0-9_-]/g, '-')}`
          return h(
            'div',
            { className: 'ds-ts-diag-row', key: item.region },
            h(
              'button',
              {
                type: 'button',
                className: 'ds-ts-diag-head',
                'aria-expanded': expanded ? 'true' : 'false',
                'aria-controls': detailId,
                onClick: () => setOpen({ ...open, [item.region]: !expanded }),
              },
              h('span', { className: 'ds-ts-diag-name' }, item.zh),
              h('span', { className: 'ds-ts-diag-count' }, `${item.matched} / ${item.total}`),
              h('span', { className: 'ds-ts-diag-status', 'data-tone': tone }, status),
              h('span', { className: 'ds-ts-diag-caret' }, expanded ? '▾' : '▸'),
            ),
            expanded
              ? h(
                  'div',
                  { className: 'ds-ts-diag-body', id: detailId },
                  h(
                    'ul',
                    { className: 'ds-ts-diag-list' },
                    item.hits.map((hit) =>
                      h(
                        'li',
                        { key: hit.selector },
                        h(
                          'code',
                          { className: 'ds-ts-diag-sel', 'data-count': String(hit.count) },
                          hit.selector,
                          '  ×',
                          hit.count,
                        ),
                        hit.count > 0
                          ? h('span', { className: 'ds-ts-diag-meta' }, `首个命中：${hit.sample}`)
                          : hit.count < 0
                            ? h('span', { className: 'ds-ts-diag-meta' }, '非法选择器 —— 这条规则永远不可能生效，需要修改代码。')
                            : null,
                      ),
                    ),
                  ),
                  item.matched === 0 && item.note !== ''
                    ? h('div', { className: 'ds-ts-hint ds-ts-diag-note' }, item.note)
                    : null,
                )
              : null,
          )
        }),
      )
    }


    /**
     * 设置页主面板。
     *
     * 面板正文固定中文，tr 只保留调用点、不做语言分支；需要跟随界面语言的只有设置导航
     * 标签，由 apply 注册的 locale 字典提供。
     */
    function ThemeStudioSection() {
      injectPanelCss()
      const tr = (zh) => zh
      const tabsetId = useDomId()
      const runtime = React.useContext(RUNTIME_CONTEXT)
      const [config, setConfig] = React.useState(() => runtime?.config ?? defaultConfig())
      const [tab, setTab] = React.useState('wallpaper')
      const [folders, setFolders] = React.useState([])
      /**
       * 首次扫描是否完成。
       *
       * 候选为空时恢复原背景的逻辑必须以它为闸门，否则 gallery 初始的 [] 会在页面刚打开、
       * 扫描尚未返回时被误判为空图库。
       */
      const [scanned, setScanned] = React.useState(false)
      const [urlDraft, setUrlDraft] = React.useState('')
      const [folderDraft, setFolderDraft] = React.useState('')
      const [browse, setBrowse] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [uploading, setUploading] = React.useState(false)
      const [gallery, setGallery] = React.useState([])
      /**
       * 候选墙当前渲染窗口，跨渲染保留。
       *
       * 完整结果保存在 gallery，这个 state 只决定一次渲染多少张；重新扫描时重置回首屏大小，
       * 让每次扫描的首屏成本恒定。
       */
      const [candidateWindow, setCandidateWindow] = React.useState(CANDIDATE_WINDOW)
      /**
       * 本次会话里从候选墙移除的文件夹来源图片。
       *
       * 只存在前端内存：登记目录中的原图不能被插件删除，刷新或重新扫描即复原；上传副本与
       * URL 缓存由宿主真正删除。
       */
      const [removed, setRemoved] = React.useState(() => new Set())
      const [diag, setDiag] = React.useState(null)
      /**
       * 重置配置与清理缓存的两步确认状态，避免破坏性操作一点即执行。
       */
      const [resetArmed, setResetArmed] = React.useState(null)
      const [accentDraft, setAccentDraft] = React.useState(toHex(config.accent?.rgb ?? [65, 118, 230]))

      /**
       * 挂载闸门：组件卸载后，异步回调不再更新 React state 或排队写盘。主题运行时本身仍可
       * 继续生效，不受面板是否挂载影响。
       */
      const mounted = React.useRef(true)
      const ifMounted = React.useCallback((fn) => {
        if (mounted.current) fn()
      }, [])
      /**
       * 上传单飞闸门；必须在第一个 await 前同步置位，state 来不及拦截同轮重复选择。
       */
      const uploadInFlight = React.useRef(false)
      /**
       * 防抖窗口的计时器、待提交的合并 patch、写入笔数与最近一次显式成功文案。
       */
      const saveTimer = React.useRef(null)
      const pendingPatch = React.useRef(null)
      const pendingCount = React.useRef(0)
      const pendingOkText = React.useRef(null)

      React.useEffect(() => {
        mounted.current = true
        // DSH 设置页经 portal 挂载；原生捕获在首次指针按下时先于 React 的 range 事件，
        // 避免某条滑块首次调值时才建立预览监听、第二次拖动才看到效果。
        const onPointerDown = (event) => {
          if (event.button !== undefined && event.button !== 0) return
          const slider = event.target?.closest?.('input.ds-ts-slider')
          if (slider !== null && slider !== undefined) beginSliderPreview(slider, event.pointerId)
        }
        document.addEventListener?.('pointerdown', onPointerDown, true)
        return () => {
          document.removeEventListener?.('pointerdown', onPointerDown, true)
          endSliderPreview()
          mounted.current = false
          if (saveTimer.current !== null) {
            clearTimeout(saveTimer.current)
            saveTimer.current = null
          }
          pendingPatch.current = null
          pendingCount.current = 0
          pendingOkText.current = null
        }
      }, [])

      /**
       * 向宿主提交一笔局部配置。
       *
       * 宿主可能回写权威配置（例如清理悬挂的壁纸选择），成功后必须清洗并调用 runtime.setConfig
       * 重新应用，不能只改内存；失败时把宿主错误翻译成状态提示。
       */
      const putConfig = React.useCallback(async (patch, okText) => {
        try {
          const result = await readJsonResponse(await fetch(`${API}/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          }))
          const payload = result.body
          if (payload === null) {
            ifMounted(() => setStatus({ kind: 'err', text: describeHostFailure(result, '保存配置') }))
          } else if (payload.ok === false) {
            ifMounted(() => setStatus({ kind: 'err', text: String(payload.error ?? '保存失败') }))
          } else {
            if (payload.config !== undefined) {
              const next = sanitizeConfig(payload.config)
              if (runtime !== undefined) runtime.setConfig(next)
              ifMounted(() => setConfig(next))
            }
            ifMounted(() => setStatus({ kind: 'ok', text: okText ?? '已保存' }))
          }
        } catch (error) {
          ifMounted(() => setStatus({ kind: 'err', text: `保存失败：${String(error?.message ?? error)}` }))
        }
      }, [ifMounted, runtime])

      /**
       * 350ms 防抖提交。
       *
       * 同一窗口内的多笔局部配置必须用 mergePatch 合并成一笔 PUT，而不是后一笔取消前一笔，
       * 否则同帧写入会静默丢失。只用于写完不立即读宿主的场景；后面紧跟 reloadFolders 的动作
       * 必须先 flushConfig，否则会读到过期数据。
       */
      const persist = React.useCallback((patch, options) => {
        if (!mounted.current) return
        pendingPatch.current = mergePatch(pendingPatch.current, patch)
        pendingCount.current += 1
        if (options?.okText !== undefined) pendingOkText.current = options.okText
        if (saveTimer.current !== null) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => {
          saveTimer.current = null
          const payload = pendingPatch.current
          const count = pendingCount.current
          const okText = pendingOkText.current
          pendingPatch.current = null
          pendingCount.current = 0
          pendingOkText.current = null
          if (!mounted.current || payload === null) return
          if (count > 1 && typeof console !== 'undefined' && typeof console.debug === 'function') {
            console.debug(`[theme-studio] 合并了 ${count} 笔配置写入，作为一笔 PUT 提交`)
          }
          putConfig(payload, okText ?? undefined)
        }, 350)
      }, [putConfig])

      /**
       * 取消防抖并立即提交当前完整配置。
       *
       * 发 runtime.config（权威值）而不是渲染快照：异步动作期间配置可能已被别的路径更新，
       * 过期快照会把刚做的修改覆盖回去；没有待写内容时不发请求。
       */
      const flushConfig = React.useCallback((okText) => {
        if (saveTimer.current !== null) {
          clearTimeout(saveTimer.current)
          saveTimer.current = null
        }
        const wasPending = pendingPatch.current !== null
        pendingPatch.current = null
        pendingCount.current = 0
        pendingOkText.current = null
        if (!wasPending) return Promise.resolve()
        return putConfig(runtime.config, okText)
      }, [putConfig, runtime])

      const partialOf = (path, value) => path.split('.').reduceRight((acc, key) => ({ [key]: acc }), value)

      const patch = React.useCallback(
        (path, value) => {
          const next = runtime.patch(path, value)
          ifMounted(() => setConfig(next))
          persist(partialOf(path, value))
        },
        [ifMounted, persist, runtime],
      )

      /**
       * 重新扫描目录并按宿主结果刷新候选。
       *
       * 扫描期间先关上 scanned 闸门，避免 folders 已更新而 gallery 尚未更新的中间渲染误触发
       * 「候选为空→恢复原背景」。removed 与渲染窗口也在这里复位。需要先落盘的写入由调用方
       * flushConfig。
       */
      const reloadFolders = React.useCallback(async () => {
        try {
          ifMounted(() => setScanned(false))
          const response = await fetch(`${API}/folders`, { cache: 'no-store' })
          const result = await readJsonResponse(response)
          if (result.body === null) {
            ifMounted(() => {
              setScanned(true)
              setStatus({ kind: 'err', text: describeHostFailure(result, '扫描目录') })
            })
            return
          }
          const groups = result.body.groups ?? []
          ifMounted(() => setFolders(groups))

          ifMounted(() => setRemoved(new Set()))
          await runtime.refreshWallpapers()
          ifMounted(() => {
            setGallery(runtime.wallpapers)
            setCandidateWindow(CANDIDATE_WINDOW)
            setScanned(true)
          })
        } catch (error) {
          ifMounted(() => {
            setScanned(true)
            setStatus({ kind: 'err', text: `扫描失败：${String(error?.message ?? error)}` })
          })
        }
      }, [ifMounted, runtime])

      React.useEffect(() => {
        if (runtime === undefined) return undefined
        const off = runtime.subscribe((next) => ifMounted(() => setConfig(next)))
        reloadFolders()
        return off
      }, [ifMounted, reloadFolders, runtime])

      /**
       * 上传副本的路径集合，由宿主 groups 里的 uploads 标记提供。
       *
       * 客户端不复制上传目录布局；该集合只用于给删除按钮选择真实语义，并判断缓存清理后当前
       * 壁纸是否变成悬挂引用。
       */
      const uploadPaths = React.useMemo(() => {
        const set = new Set()
        for (const group of folders) {
          if (group?.uploads !== true) continue
          for (const item of group.items ?? []) set.add(String(item.path))
        }
        return set
      }, [folders])
      const isUploadPath = React.useCallback((value) => uploadPaths.has(value), [uploadPaths])

      const folderGroups = React.useMemo(() => {
        const map = new Map()
        for (const group of folders) {
          if (group !== null && typeof group === 'object' && typeof group.folder === 'string') {
            map.set(group.folder, group)
          }
        }
        return map
      }, [folders])

      const wallpaper = config.wallpaper ?? {}
      const glass = config.glass ?? {}
      const accent = config.accent ?? { enabled: false, rgb: [65, 118, 230] }

      /**
       * 撤掉插件对背景的接管：source/current/fixed 一次复位，但保留总开关、玻璃与主题色。
       * 只在候选确实耗尽或移除最后一个登记目录时调用。
       */
      function restoreOriginalBackground(options) {
        const next = runtime.patch('wallpaper.source', 'none')
        ifMounted(() => setConfig(next))
        const text = options?.okText
          ?? '候选里已经没有图片了，已恢复 DSH 原本的背景（原来的壁纸设置保留在配置里，重新登记目录即可再用）'
        ifMounted(() => setStatus({ kind: 'ok', text }))
        persist({ wallpaper: { source: 'none', current: '', fixed: '' } }, { okText: text })
      }


      /**
       * 应用一张壁纸；空串表示清空。
       *
       * 选中本地或远程图片时同时声明来源（folder/url），source/current/fixed 一次提交，避免只
       * 改路径导致来源仍是 none、背景层不挂载。
       */
      const applyWallpaper = (value) => {
        const target = String(value ?? '')
        if (!mounted.current) return
        const currentWallpaper = runtime?.config?.wallpaper ?? {}
        if (target === '') {
          if (runtime !== undefined) runtime.pendingWallpaper = ''
          patch('wallpaper', { ...currentWallpaper, source: 'none', current: '', fixed: '' })
          return
        }
        if (runtime !== undefined) {
          runtime.pendingWallpaper = target
          runtime.apply(runtime.config).then((result) => {
            if (result?.ok === false) {
              ifMounted(() => {
                setStatus({ kind: 'err', text: `壁纸加载失败：${result.reason}。若图片过大，请换一张或先压缩。` })
              })
            }
          })
        }
        const nextSource = isRemoteUrl(target) ? 'url' : 'folder'
        patch('wallpaper', { ...currentWallpaper, source: nextSource, current: target, fixed: target })
      }

      const reshuffleWallpaper = () => {
        const pick = runtime.pickRandomWallpaper()
        if (pick === '') {
          setStatus({ kind: 'warn', text: '候选池里没有别的图片可换（当前这张之外为空）' })
          return
        }
        applyWallpaper(pick)
      }

      const addFolder = async () => {
        const value = folderDraft.trim()
        if (value.length === 0) return
        const list = [...(wallpaper.folders ?? [])]
        if (!list.includes(value)) list.push(value)
        ifMounted(() => setFolderDraft(''))
        const next = runtime.patch('wallpaper.folders', list)
        ifMounted(() => setConfig(next))
        persist({ wallpaper: { folders: list } })
        await flushConfig()
        await reloadFolders()
      }

      const removeFolder = async (value) => {
        const list = (wallpaper.folders ?? []).filter((item) => item !== value)
        const next = runtime.patch('wallpaper.folders', list)
        ifMounted(() => setConfig(next))
        if (list.length === 0) {
          runtime.patch('wallpaper.source', 'none')
          const text = `已移除最后一个登记目录（${baseName(value)}），并恢复 DSH 原本的背景`
          ifMounted(() => setStatus({ kind: 'ok', text }))
          persist({ wallpaper: { source: 'none', current: '', fixed: '', folders: [] } }, { okText: text })
        } else {
          persist({ wallpaper: { folders: list } })
        }
        await flushConfig()
        await reloadFolders()
      }

      const addUrl = () => {
        const value = urlDraft.trim()
        if (value.length === 0) return
        const list = [...(wallpaper.urls ?? [])]
        if (!list.includes(value)) list.push(value)
        setUrlDraft('')
        patch('wallpaper.urls', list)
      }

      const browseTo = async (target) => {
        try {
          const response = await fetch(`${API}/browse?path=${encodeURIComponent(target ?? '')}`, { cache: 'no-store' })
          const result = await readJsonResponse(response)
          if (result.body === null) {
            ifMounted(() => setStatus({ kind: 'err', text: describeHostFailure(result, '浏览目录') }))
            return
          }
          ifMounted(() => setBrowse(result.body))
          if (result.body.ok === false) {
            ifMounted(() => setStatus({ kind: 'err', text: String(result.body.error) }))
          }
        } catch (error) {
          ifMounted(() => setStatus({ kind: 'err', text: `浏览失败：${String(error?.message ?? error)}` }))
        }
      }

      /**
       * 上传一张图片。
       *
       * 客户端只做预检、单飞与 input.value 复位；真实类型、体积和配额由宿主校验。无论成功失败
       * 都要清空 input，否则再次选择同一个文件不会触发 change。
       */
      const uploadFile = async (file, input) => {
        const resetInput = () => {
          if (input !== null && input !== undefined) input.value = ''
        }
        if (!file) {
          resetInput()
          return
        }
        if (uploadInFlight.current) {
          resetInput()
          ifMounted(() => setStatus({ kind: 'warn', text: '上一张图片还在上传中，请稍候再选' }))
          return
        }
        const problem = precheckUpload(file)
        if (problem !== null) {
          resetInput()
          ifMounted(() => setStatus({ kind: 'err', text: problem }))
          return
        }

        uploadInFlight.current = true
        ifMounted(() => setUploading(true))
        ifMounted(() => setStatus({ kind: 'ok', text: `上传中：${file.name}` }))
        try {
          const result = await readJsonResponse(await fetch(`${API}/upload?name=${encodeURIComponent(file.name)}`, {
            method: 'POST',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file,
          }))
          const payload = result.body
          if (payload === null) {
            ifMounted(() => setStatus({ kind: 'err', text: describeHostFailure(result, '上传') }))
            return
          }
          if (payload.ok === false) {
            ifMounted(() => setStatus({ kind: 'err', text: `上传失败：${String(payload.error ?? '宿主拒绝了这次上传')}` }))
            return
          }
          const doneText = typeof payload.type === 'string' && payload.type !== ''
            ? `上传完成（${payload.type}）`
            : '上传完成'
          ifMounted(() => setStatus({ kind: 'ok', text: doneText }))
          applyWallpaper(payload.path)
          await flushConfig(doneText)
          await reloadFolders()
        } catch (error) {
          ifMounted(() => setStatus({ kind: 'err', text: `上传失败：${String(error?.message ?? error)}` }))
        } finally {
          uploadInFlight.current = false
          ifMounted(() => setUploading(false))
          resetInput()
        }
      }


      /**
       * 当前壁纸等于被删资源时同步清空 fixed/current，避免留下指向不存在文件的悬挂选择。
       */
      const clearIfActive = (value) => {
        if ((runtime?.config?.wallpaper?.fixed ?? '') !== value) return
        const next = runtime.patch('wallpaper.fixed', '')
        ifMounted(() => setConfig(next))
        persist({ wallpaper: { fixed: '', current: '' } })
      }

      /**
       * 候选墙的两级视图：candidates 是过滤 removed 后的完整候选，专门用于总数；visibleCandidates
       * 只截取当前窗口用于渲染。过滤必须先于截窗，否则删一张会少显示一张，「还有多少张未显示」
       * 也会算错。
       */
      const candidates = React.useMemo(
        () => gallery.filter((item) => !removed.has(item)),
        [gallery, removed],
      )
      const visibleCandidates = React.useMemo(
        () => candidates.slice(0, candidateWindow),
        [candidates, candidateWindow],
      )

      /**
       * 图库确实为空时恢复 DSH 原生背景。判据必须用完整 candidates 和 scanned 闸门，不能用
       * visibleCandidates（只代表当前窗口）或未过滤的 gallery（removed 不生效）。
       */
      const nothingToShow = scanned && candidates.length === 0 && wallpaper.source === 'folder'

      React.useEffect(() => {
        if (!nothingToShow) return
        restoreOriginalBackground()
      }, [nothingToShow])

      function baseName(value) {
        return value.split(/[\\/]/).pop()
      }

      const deleteStatus = (label, removedFiles) => {
        const text = removedFiles > 0
          ? `已删除 ${label}（本地文件 ${removedFiles} 个）`
          : `已从候选移除 ${label}`
        ifMounted(() => setStatus({ kind: 'ok', text }))
      }

      const removeFolderCandidate = async (value) => {
        clearIfActive(value)
        ifMounted(() => setRemoved((previous) => new Set(previous).add(value)))
        ifMounted(() => {
          setStatus({
            kind: 'ok',
            text: `这不是插件副本，已从会话视图移除：${baseName(value)}（你的原图未做任何改动；点「重新扫描」或刷新页面即复原）`,
          })
        })
      }

      /**
       * 请求宿主删除上传副本。
       *
       * 403 或 removed:false 表示路径不属于插件副本，返回 false 让调用方降级为仅移出视图；
       * 网络错误、空响应或宿主拒绝执行则表示结果未知，不能再降级，否则会误报文件已经删除。
       */
      const deleteUploadCandidate = async (value) => {
        try {
          const result = await readJsonResponse(await fetch(`${API}/delete-upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: value }),
          }))
          const payload = result.body
          if (result.status === 403) return false
          if (payload === null) {
            ifMounted(() => setStatus({ kind: 'err', text: describeHostFailure(result, '插件副本删除') }))
            return true
          }
          if (payload.ok === false) {
            ifMounted(() => {
              setStatus({ kind: 'err', text: `插件副本删除失败：${String(payload.error ?? '宿主拒绝了删除请求')}` })
            })
            return true
          }
          if (payload?.removed !== true) return false
          clearIfActive(value)
          await reloadFolders()
          deleteStatus(`上传的图：${baseName(value)}`, Number(payload?.removedFiles ?? 0))
          return true
        } catch (error) {
          ifMounted(() => setStatus({ kind: 'err', text: `插件副本删除失败：${String(error?.message ?? error)}` }))
          return true
        }
      }

      /**
       * 删除 URL 的本地缓存副本并从登记列表移除；远端原图不受影响。
       */
      const forgetUrl = async (url) => {
        try {
          const result = await readJsonResponse(await fetch(`${API}/forget-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
          }))
          const payload = result.body
          if (payload === null) {
            ifMounted(() => setStatus({ kind: 'err', text: describeHostFailure(result, '删除缓存') }))
            return
          }
          if (payload.ok === false) {
            ifMounted(() => setStatus({ kind: 'err', text: String(payload.error) }))
            return
          }
          const remaining = payload.urls ?? (runtime?.config?.wallpaper?.urls ?? []).filter((item) => item !== url)
          const next = runtime.patch('wallpaper.urls', remaining)
          ifMounted(() => setConfig(next))
          clearIfActive(url)
          ifMounted(() => {
            setStatus({
              kind: 'ok',
              text: `已删除本地缓存（${payload?.removedCacheFiles ?? 0} 个文件）并从候选移除；远端原图未受影响`,
            })
          })
        } catch (error) {
          ifMounted(() => setStatus({ kind: 'err', text: `删除失败：${String(error?.message ?? error)}` }))
        }
      }

      /**
       * 按资源归属选择删除语义：URL 走 forget-url；其他路径先询问宿主是否为插件上传的副本，
       * 是则真删，否则只从本次会话的候选墙移除。归属判断只在宿主，客户端不猜目录布局。
       */
      const removeCandidate = async (value) => {
        if (/^https?:/i.test(value)) {
          await forgetUrl(value)
          return
        }
        const deleted = await deleteUploadCandidate(value)
        if (!deleted) await removeFolderCandidate(value)
      }

      /**
       * 重置整份配置：调用宿主 /api/reset，并用返回的出厂配置覆盖运行时与面板状态。
       * 与「一键关闭」不同，重置会清空壁纸、玻璃、主题色和登记目录。
       */
      const resetConfig = async () => {
        try {
          const result = await readJsonResponse(await fetch(`${API}/reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ purgeFiles: false }),
          }))
          if (result.body === null || result.body.ok === false) {
            ifMounted(() => setStatus({ kind: 'err', text: describeHostFailure(result, '重置') }))
            return
          }
          const fresh = result.body.config ?? defaultConfig()
          runtime.config = fresh
          runtime.resolved = ''
          ifMounted(() => {
            setConfig(fresh)
            setDiag(null)
            setAccentDraft(toHex(fresh.accent?.rgb ?? [65, 118, 230]))
          })
          runtime.apply(fresh)
          await reloadFolders()
          ifMounted(() => setStatus({ kind: 'ok', text: '已重置全部配置' }))
        } catch (error) {
          ifMounted(() => setStatus({ kind: 'err', text: `重置失败：${String(error?.message ?? error)}` }))
        }
      }

      /**
       * 仅清理插件产生的本地副本（上传副本与远程缓存）；宿主端点本身不改写配置。
       *
       * 客户端会先记下仍指向上传副本的当前壁纸；这些路径在缓存删除后会悬挂，因此单独把壁纸
       * 来源复位。判定必须在 reloadFolders 前完成，否则这些路径已不在上传集合中。
       */
      const purgeCache = async () => {
        try {
          const result = await readJsonResponse(await fetch(`${API}/purge-cache`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          }))
          if (result.body === null || result.body.ok === false) {
            ifMounted(() => setStatus({ kind: 'err', text: describeHostFailure(result, '清理缓存') }))
            return
          }
          const removed = Number(result.body.removedFiles ?? 0)

          const before = runtime.config
          const beforeWallpaper = before?.wallpaper ?? {}
          const dangling = [beforeWallpaper.current, beforeWallpaper.fixed].some(
            (value) => typeof value === 'string' && value !== '' && uploadPaths.has(value),
          )
          if (dangling) {
            const next = runtime.patch('wallpaper', {
              ...beforeWallpaper,
              source: 'none',
              current: '',
              fixed: '',
            })
            ifMounted(() => setConfig(next))
            persist({ wallpaper: { source: 'none', current: '', fixed: '' } })
            await flushConfig()
          }

          await reloadFolders()
          ifMounted(() => setStatus({ kind: 'ok', text: `已清理本地缓存（${removed} 个文件）` }))
        } catch (error) {
          ifMounted(() => setStatus({ kind: 'err', text: `清理缓存失败：${String(error?.message ?? error)}` }))
        }
      }


      const setAccentChannel = (index, value) => {
        const rgb = [...(accent.rgb ?? [65, 118, 230])]
        rgb[index] = value
        const next = runtime.patch('accent.rgb', rgb)
        setConfig(next)
        setAccentDraft(toHex(rgb))
        persist({ accent: { rgb } })
      }

      const applyAccentPreset = (preset) => {
        const next = runtime.patch('accent', { ...accent, enabled: true, rgb: preset.rgb, preset: preset.id })
        setConfig(next)
        setAccentDraft(toHex(preset.rgb))
        persist({ accent: { enabled: true, rgb: preset.rgb, preset: preset.id } })
      }


      /**
       * 四个标签页；导航文案固定中文，不参与 locale 切换。
       */
      const tabs = [
        { id: 'wallpaper', label: tr('壁纸') },
        { id: 'glass', label: tr('毛玻璃') },
        { id: 'accent', label: tr('主题色') },
        { id: 'misc', label: tr('其他') },
      ]

      const tabIdOf = (id) => `${tabsetId}-tab-${id}`
      const tabPanelId = `${tabsetId}-panel`

      /**
       * 标签页正文容器。
       *
       * 四个 tab 共用同一个 tabpanel id：同一时刻只挂载当前页，若按页拆 id，未挂载的
       * aria-controls 会指向不存在的节点。容器用 display: contents，既保留 tabpanel 语义，
       * 又不破坏 .ds-ts-page 的 flex gap 布局。
       */
      const tabPanel = (id, ...content) =>
        h(
          'div',
          {
            className: 'ds-ts-tabpanel',
            role: 'tabpanel',
            id: tabPanelId,
            'aria-labelledby': tabIdOf(id),
          },
          ...content,
        )

      return h(
        'div',
        { className: 'ds-ts-page' },
        h(
          'div',
          null,
          h('h2', null, tr('主题工作室')),
          h(
            'p',
            null,
            tr('壁纸 + 分区独立毛玻璃 + 自定义主题色。所有改动即时生效并保存在 $DSH_HOME/theme-studio/config.json。'),
          ),
        ),
        h(
          'div',
          { className: 'ds-ts-card' },
          h(
            'header',
            null,
            h('div', { className: 'ds-ts-title' }, tr('总开关')),
            typeof primitives?.Switch === 'function'
              ? h(primitives.Switch, {
                  checked: config.enabled !== false,
                  onChange: (value) => patch('enabled', value),
                })
              : h('input', {
                  type: 'checkbox',
                  checked: config.enabled !== false,
                  onChange: (event) => patch('enabled', event.target.checked),
                }),
          ),
        ),
        h(
          'div',
          { className: 'ds-ts-tabs', role: 'tablist' },
          tabs.map((item) =>
            h(
              'button',
              {
                key: item.id,
                type: 'button',
                role: 'tab',
                id: tabIdOf(item.id),
                'aria-selected': tab === item.id,
                'aria-controls': tabPanelId,
                'data-active': tab === item.id,
                onClick: () => setTab(item.id),
              },
              item.label,
            ),
          ),
        ),

        tab === 'wallpaper'
          ? tabPanel(
              'wallpaper',
              runtime?.lastLoadResult?.ok === false
                ? h(
                    'div',
                    { className: 'ds-ts-card' },
                    h(
                      'header',
                      null,
                      h(
                        'div',
                        null,
                        h('div', { className: 'ds-ts-title' }, tr('当前壁纸没能加载')),
                        h('div', { className: 'ds-ts-sub' }, runtime.lastLoadResult.reason ?? tr('未知原因')),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'ds-ts-body' },
                      h(
                        'div',
                        { className: 'ds-ts-err' },
                        `${tr('地址')}：${String(runtime.lastLoadResult.url ?? runtime.resolved).slice(0, 160)}`,
                      ),
                      h(
                        'div',
                        { className: 'ds-ts-hint' },
                        tr('常见原因：图片体积超过 256 MB 上限、文件被移动或删除、路径不在已登记的目录内。换一张图，或先压缩后再试。'),
                      ),
                    ),
                  )
                : null,
              h(
                Card,
                { title: tr('图片来源') },
                h(SelectRow, {
                  label: tr('来源'),
                  value: wallpaper.source ?? 'none',
                  options: [
                    { value: 'none', label: tr('不使用壁纸') },
                    { value: 'folder', label: tr('本地文件夹') },
                    { value: 'url', label: tr('远程 URL') },
                  ],
                  onChange: (value) => {
                    /**
                     * 切换来源时清除不兼容的 current/fixed：本地路径在 url 来源下无法加载，http 链接也不属于
                     * folder 候选池。读取 runtime.config 而非渲染快照，保证拿到最新权威值。
                     */
                    const next = { ...(runtime?.config?.wallpaper ?? {}), source: value }
                    if (value === 'url') {
                      if (next.current !== '' && !isRemoteUrl(next.current)) next.current = ''
                      if (next.fixed !== '' && !isRemoteUrl(next.fixed)) next.fixed = ''
                    } else if (value === 'folder') {
                      if (isRemoteUrl(next.current)) next.current = ''
                      if (isRemoteUrl(next.fixed)) next.fixed = ''
                    }
                    const applied = runtime.patch('wallpaper', next)
                    setConfig(applied)
                    persist({ wallpaper: next })
                  },
                }),
                h(
                  'div',
                  { className: 'ds-ts-path' },
                  h('input', {
                    className: 'ds-ts-text',
                    placeholder: tr('文件夹绝对路径，例如 D:\\壁纸'),
                    value: folderDraft,
                    onChange: (event) => setFolderDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') addFolder()
                    },
                  }),
                  h('button', { type: 'button', className: 'ds-ts-btn', onClick: () => browseTo(folderDraft) }, tr('浏览')),
                  h('button', { type: 'button', className: 'ds-ts-btn', 'data-variant': 'primary', onClick: addFolder }, tr('添加')),
                ),
                browse !== null && browse.ok !== false
                  ? h(
                      'div',
                      null,
                      h('div', { className: 'ds-ts-hint' }, `${tr('当前目录')}：${browse.path}`),
                      h(
                        'div',
                        { className: 'ds-ts-foot' },
                        browse.parent
                          ? h('button', { type: 'button', className: 'ds-ts-btn', onClick: () => browseTo(browse.parent) }, tr('上一级'))
                          : null,
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'ds-ts-btn',
                            'data-variant': 'primary',
                            onClick: () => {
                              setFolderDraft(browse.path)
                              setBrowse(null)
                            },
                          },
                          tr('选这个目录'),
                        ),
                      ),
                      h(
                        'ul',
                        { className: 'ds-ts-list' },
                        (browse.dirs ?? []).slice(0, BROWSE_DIR_LIMIT).map((dir) =>
                          h(
                            'li',
                            { key: dir.path },
                            h('span', { className: 'ds-ts-mono' }, dir.name),
                            h('button', { type: 'button', className: 'ds-ts-btn', 'data-variant': 'ghost', onClick: () => browseTo(dir.path) }, tr('进入')),
                          ),
                        ),
                      ),
                      (browse.dirs ?? []).length >= BROWSE_DIR_LIMIT
                        ? h(
                            'div',
                            { className: 'ds-ts-hint' },
                            `${tr('目录过多，仅显示前')} ${BROWSE_DIR_LIMIT} ${tr('个，可直接在上方输入完整路径')}`,
                          )
                        : null,
                    )
                  : null,
                (wallpaper.folders ?? []).length > 0
                  ? h(
                      'ul',
                      { className: 'ds-ts-list' },
                      (wallpaper.folders ?? []).map((folder) => {
                        const group = folderGroups.get(folder)
                        const scanned = Number.isFinite(group?.scanned)
                          ? group.scanned
                          : (Number.isFinite(group?.count) ? group.count : null)
                        return h(
                          'li',
                          { key: folder },
                          h('span', { className: 'ds-ts-mono' }, folder),
                          scanned === null
                            ? null
                            : h('span', { className: 'ds-ts-hint' }, `${scanned} ${tr('张')}`),
                          group?.exists === false
                            ? h('span', { className: 'ds-ts-warn' }, tr('目录不存在或不可读'))
                            : null,
                          group?.truncated === true
                            ? h(
                                'span',
                                { className: 'ds-ts-warn' },
                                scanned === null
                                  ? tr('扫描达到上限，结果可能不完整')
                                  : `${tr('扫描达到上限，仅显示前')} ${scanned} ${tr('张')}`,
                              )
                            : null,
                          h(
                            'button',
                            { type: 'button', className: 'ds-ts-btn', 'data-variant': 'danger', onClick: () => removeFolder(folder) },
                            tr('移除'),
                          ),
                        )
                      }),
                    )
                  : h('div', { className: 'ds-ts-hint' }, tr('还没有登记文件夹。')),
                h(SwitchRow, {
                  label: tr('扫描子目录'),
                  checked: wallpaper.recursive !== false,
                  onChange: (value) => patch('wallpaper.recursive', value),
                }),
                h(
                  'div',
                  { className: 'ds-ts-path' },
                  h('input', {
                    className: 'ds-ts-text',
                    placeholder: tr('远程图片链接 https://…'),
                    value: urlDraft,
                    onChange: (event) => setUrlDraft(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') addUrl()
                    },
                  }),
                  h('button', { type: 'button', className: 'ds-ts-btn', onClick: addUrl }, tr('添加链接')),
                ),
                (wallpaper.urls ?? []).length > 0
                  ? h(
                      'ul',
                      { className: 'ds-ts-list' },
                      (wallpaper.urls ?? []).map((url) =>
                        h(
                          'li',
                          { key: url },
                          h('span', { className: 'ds-ts-mono' }, url),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'ds-ts-btn',
                              onClick: () => applyWallpaper(url),
                            },
                            tr('使用'),
                          ),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'ds-ts-btn',
                              'data-variant': 'danger',
                              title: tr('删除本地缓存并从候选移除（远端原图不受影响）'),
                              onClick: () => forgetUrl(url),
                            },
                            tr('删除缓存与候选'),
                          ),
                        ),
                      ),
                    )
                  : null,
                h(
                  'div',
                  { className: 'ds-ts-path' },
                  h('input', {
                    className: 'ds-ts-text',
                    type: 'file',
                    accept: 'image/*',
                    disabled: uploading,
                    onChange: (event) => {
                      const input = event.target
                      const file = input?.files?.[0] ?? null
                      return uploadFile(file, input)
                    },
                  }),
                ),
              ),
              h(
                Card,
                {
                  title: tr('壁纸候选'),
                  sub: candidates.length === 0
                    ? `0 ${tr('张')}`
                    : candidates.length === visibleCandidates.length
                      ? `${candidates.length} / ${candidates.length} ${tr('张')}`
                      : `${visibleCandidates.length} / ${candidates.length} ${tr('张')}（还有 ${candidates.length - visibleCandidates.length} 张未显示）`,
                  right: h(
                    'div',
                    { className: 'ds-ts-foot' },
                    h('button', { type: 'button', className: 'ds-ts-btn', onClick: reloadFolders }, tr('重新扫描')),
                  ),
                },
                candidates.length === 0
                  ? h('div', { className: 'ds-ts-hint' }, tr('登记文件夹并扫描后，这里会列出候选图片。'))
                  : [
                      h(
                        'div',
                        { className: 'ds-ts-grid', key: 'candidates' },
                        visibleCandidates.map((item) =>
                          h(Thumb, {
                            key: item,
                            src: `${API}/image?path=${encodeURIComponent(item)}`,
                            name: item.split(/[\\/]/).pop(),
                            active: wallpaper.fixed === item,
                            kind: 'folder',
                            label: isUploadPath(item) ? tr('删除这张上传的图') : tr('从候选墙移除'),
                            onPick: () => applyWallpaper(item),
                            onRemove: () => removeCandidate(item),
                          }),
                        ),
                      ),
                      visibleCandidates.length < candidates.length
                        ? h(
                            'div',
                            { className: 'ds-ts-foot', key: 'more' },
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'ds-ts-btn',
                                'data-variant': 'primary',
                                onClick: () => setCandidateWindow((current) => current + CANDIDATE_WINDOW_STEP),
                              },
                              `${tr('加载更多')}（已显示 ${visibleCandidates.length} / 共 ${candidates.length}）`,
                            ),
                          )
                        : null,
                    ],
              ),
              h(
                Card,
                { title: tr('壁纸表现') },
                h(SliderRow, {
                  label: tr('壁纸模糊'),
                  value: wallpaper.blur ?? 0,
                  min: 0,
                  max: 60,
                  step: 1,
                  unit: 'px',
                  onChange: (value) => patch('wallpaper.blur', value),
                }),
                h(SliderRow, {
                  label: tr('遮罩暗化'),
                  value: wallpaper.dim ?? 0.18,
                  min: 0,
                  max: 0.9,
                  step: 0.01,
                  onChange: (value) => patch('wallpaper.dim', value),
                }),
                h(WallpaperDimColor, {
                  color: wallpaper.dimColor ?? 'auto',
                  onChange: (value) => patch('wallpaper.dimColor', value),
                }),
                h(SliderRow, {
                  label: tr('暗角'),
                  value: wallpaper.vignette ?? 0.25,
                  min: 0,
                  max: 1,
                  step: 0.01,
                  onChange: (value) => patch('wallpaper.vignette', value),
                }),
                h(SliderRow, {
                  label: tr('噪点'),
                  value: wallpaper.noise ?? 0.04,
                  min: 0,
                  max: 0.2,
                  step: 0.005,
                  onChange: (value) => patch('wallpaper.noise', value),
                }),
                h(SliderRow, {
                  label: tr('亮度'),
                  value: wallpaper.brightness ?? 1,
                  min: 0.2,
                  max: 2,
                  step: 0.01,
                  onChange: (value) => patch('wallpaper.brightness', value),
                }),
                h(SliderRow, {
                  label: tr('饱和度'),
                  value: wallpaper.saturation ?? 1,
                  min: 0,
                  max: 2,
                  step: 0.01,
                  onChange: (value) => patch('wallpaper.saturation', value),
                }),
                h(SelectRow, {
                  label: tr('适配'),
                  value: wallpaper.fit ?? 'cover',
                  options: [
                    { value: 'cover', label: tr('裁切铺满') },
                    { value: 'contain', label: tr('完整显示') },
                    { value: 'repeat', label: tr('平铺') },
                    { value: 'center', label: tr('原始尺寸居中') },
                  ],
                  onChange: (value) => patch('wallpaper.fit', value),
                }),
                h(SelectRow, {
                  label: tr('对齐'),
                  value: wallpaper.position ?? 'center',
                  options: [
                    { value: 'center', label: tr('居中') },
                    { value: 'top', label: tr('顶部') },
                    { value: 'bottom', label: tr('底部') },
                    { value: 'left', label: tr('左侧') },
                    { value: 'right', label: tr('右侧') },
                  ],
                  onChange: (value) => patch('wallpaper.position', value),
                }),
                h(
                  'div',
                  { className: 'ds-ts-foot' },
                  h('button', {
                    type: 'button',
                    className: 'ds-ts-btn',
                    onClick: reshuffleWallpaper,
                  }, tr('换一张')),
                  h('button', {
                    type: 'button',
                    className: 'ds-ts-btn',
                    'data-variant': 'ghost',
                    onClick: () => applyWallpaper(''),
                  }, tr('清空当前壁纸')),
                ),
              ),
            )
          : null,

        tab === 'glass'
          ? tabPanel(
              'glass',
              h(
                Card,
                { title: tr('公共质感') },
                h(SliderRow, {
                  label: tr('描边强度'),
                  value: glass.border ?? 0.6,
                  min: 0,
                  max: 1,
                  step: 0.01,
                  onChange: (value) => patch('glass.border', value),
                }),
                h(SliderRow, {
                  label: tr('顶部高光'),
                  value: glass.highlight ?? 0.5,
                  min: 0,
                  max: 1,
                  step: 0.01,
                  onChange: (value) => patch('glass.highlight', value),
                }),
                h(
                  'div',
                  { className: 'ds-ts-hint' },
                  tr('不透明度 100% = 完全不透明（毛玻璃消失）；越往左壁纸越明显。'),
                ),
              ),
              ...REGIONS.map((region) => {
                const value = glass[region.key] ?? {}
                const darkTheme = document.documentElement.hasAttribute?.('data-ds-dark-theme') ||
                  document.body.hasAttribute?.('data-ds-dark-theme')
                const fallback = toHex(GLASS_COLORS[region.key][darkTheme ? 'dark' : 'light'])
                return h(
                  Card,
                  {
                    key: region.key,
                    title: tr(region.zh),
                    sub: region.hint,
                    right:
                      typeof primitives?.Switch === 'function'
                        ? h(primitives.Switch, {
                            checked: value.enabled !== false,
                            onChange: (next) => patch(`glass.${region.key}.enabled`, next),
                          })
                        : null,
                  },
                  h(SliderRow, {
                    label: tr('不透明度'),
                    value: value.opacity ?? 0.6,
                    min: 0.05,
                    max: 1,
                    step: 0.01,
                    onChange: (next) => patch(`glass.${region.key}.opacity`, next),
                  }),
                  h(GlassColorRow, {
                    label: tr('遮罩颜色'),
                    color: value.color ?? 'auto',
                    fallback,
                    presets: GLASS_COLORS[region.key],
                    defaultNote: region.key === 'bars'
                       ? '默认（侧栏、顶栏各用 DSH 原生色）'
                       : region.key === 'menu'
                         ? '默认（沿用 DSH 原生半透明色，色块仅显示 RGB）'
                         : region.key === 'assistant'
                           ? '默认（取 DSH 页面底色；原生 AI 回复没有气泡）'
                           : '默认（跟随 DSH 明暗主题）',
                    onChange: (next) => patch(`glass.${region.key}.color`, next),
                  }),
                  h(SliderRow, {
                    label: tr('模糊'),
                    value: value.blur ?? 18,
                    min: 0,
                    max: MAX_BLUR,
                    step: 1,
                    unit: 'px',
                    onChange: (next) => patch(`glass.${region.key}.blur`, next),
                  }),
                )
              }),
            )
          : null,

        tab === 'accent'
          ? tabPanel(
              'accent',
              h(
                Card,
                { title: tr('主题色') },
                h(SwitchRow, {
                  label: tr('启用主题色'),
                  checked: accent.enabled === true,
                  onChange: (value) => patch('accent.enabled', value),
                }),
                h(
                  'div',
                  { className: 'ds-ts-chips' },
                  ACCENT_PRESETS.map((preset) =>
                    h(
                      'button',
                      {
                        key: preset.id,
                        type: 'button',
                        className: 'ds-ts-chip',
                        'data-active': accent.preset === preset.id,
                        onClick: () => applyAccentPreset(preset),
                      },
                      h('span', { className: 'ds-ts-swatch', style: { background: toHex(preset.rgb) } }),
                      tr(preset.zh),
                    ),
                  ),
                ),
                ...[0, 1, 2].map((index) =>
                  h(SliderRow, {
                    key: index,
                    label: ['R 红', 'G 绿', 'B 蓝'][index],
                    value: (accent.rgb ?? [65, 118, 230])[index],
                    min: 0,
                    max: 255,
                    step: 1,
                    onChange: (value) => setAccentChannel(index, value),
                  }),
                ),
                h(
                  'div',
                  { className: 'ds-ts-row' },
                  h('div', { className: 'ds-ts-name' }, tr('色值')),
                  h('input', {
                    className: 'ds-ts-text',
                    value: accentDraft,
                    onChange: (event) => {
                      setAccentDraft(event.target.value)
                      const parsed = parseColor(event.target.value)
                      if (parsed !== null) {
                        const next = runtime.patch('accent.rgb', parsed)
                        setConfig(next)
                        persist({ accent: { rgb: parsed } })
                      }
                    },
                  }),
                  h('div', {
                    className: 'ds-ts-swatch',
                    style: { background: toHex(accent.rgb ?? [65, 118, 230]), width: 22, height: 22 },
                  }),
                ),
                h(
                  'div',
                  { className: 'ds-ts-hint' },
                  tr('主题色会作用于发送按钮、开关、选中态、链接与焦点环，并按明暗自动派生深浅梯度。'),
                ),
              ),
            )
          : null,

        tab === 'misc'
          ? tabPanel(
              'misc',
              h(
                Card,
                { title: tr('分区命中自检'), sub: tr('确认毛玻璃到底作用到了哪些元素'), defaultOpen: false },
                h(
                  'div',
                  { className: 'ds-ts-foot' },
                  h('button', {
                    type: 'button',
                    className: 'ds-ts-btn',
                    'data-variant': 'primary',
                    onClick: () => setDiag(diagnose()),
                  }, tr('运行自检')),
                  h('div', { className: 'ds-ts-hint' }, tr('DSH 升级后 CSS 类名可能变化，这里能立刻看出哪个分区失效。')),
                ),
                diag === null
                  ? null
                  : h(DiagReport, { items: diag }),
              ),
              h(
                Card,
                { title: tr('维护') },
                h(
                  'div',
                  { className: 'ds-ts-foot' },
                  h('button', {
                    type: 'button',
                    className: 'ds-ts-btn',
                    onClick: async () => {
                      await reloadFolders()
                      setStatus({ kind: 'ok', text: tr('已重新扫描') })
                    },
                  }, tr('重新扫描目录')),
                  h('button', {
                    type: 'button',
                    className: 'ds-ts-btn',
                    onClick: reshuffleWallpaper,
                  }, tr('重选随机壁纸')),
                  h('button', {
                    type: 'button',
                    className: 'ds-ts-btn',
                    'data-variant': 'danger',
                    onClick: () => {
                      const next = runtime.patch('enabled', false)
                      setConfig(next)
                      persist({ enabled: false })
                      setStatus({ kind: 'warn', text: tr('已关闭，界面已复原') })
                    },
                  }, tr('一键关闭并复原')),
                ),
                h(
                  'div',
                  { className: 'ds-ts-hint' },
                  tr('配置位置：$DSH_HOME/theme-studio/config.json；上传的图片在 $DSH_HOME/theme-studio/wallpapers/。'),
                ),
              ),
              h(
                Card,
                { title: tr('重置'), sub: tr('把本插件造成的所有效果退回出厂'), defaultOpen: false },
                resetArmed === null
                  ? h(
                      'div',
                      { className: 'ds-ts-foot' },
                      h('button', {
                        type: 'button',
                        className: 'ds-ts-btn',
                        onClick: () => setResetArmed('config'),
                      }, tr('重置配置')),
                      h('button', {
                        type: 'button',
                        className: 'ds-ts-btn',
                        onClick: () => setResetArmed('cache'),
                      }, tr('清理本地缓存')),
                    )
                  : h(
                      'div',
                      { className: 'ds-ts-foot' },
                      h(
                        'span',
                        { className: 'ds-ts-warn' },
                        resetArmed === 'cache'
                          ? tr('确认清理本地缓存？')
                          : tr('确认重置全部配置？此操作无法撤销'),
                      ),
                      h('button', {
                        type: 'button',
                        className: 'ds-ts-btn',
                        'data-variant': 'danger',
                        onClick: async () => {
                          const mode = resetArmed
                          setResetArmed(null)
                          if (mode === 'cache') await purgeCache()
                          else await resetConfig()
                        },
                      }, tr('确认')),
                      h('button', {
                        type: 'button',
                        className: 'ds-ts-btn',
                        'data-variant': 'ghost',
                        onClick: () => setResetArmed(null),
                      }, tr('取消')),
                    ),
              ),
            )
          : null,

        /**
         * 异步结果状态区：错误用 alert/assertive 立即播报，普通提示用 status/polite 排队；
         * aria-atomic 让读屏整条读出。颜色仍由 className 决定。
         */
        status !== null
          ? h(
              'div',
              {
                className: status.kind === 'err' ? 'ds-ts-err' : status.kind === 'warn' ? 'ds-ts-warn' : 'ds-ts-ok',
                role: status.kind === 'err' ? 'alert' : 'status',
                'aria-live': status.kind === 'err' ? 'assertive' : 'polite',
                'aria-atomic': 'true',
              },
              status.text,
            )
          : null,
      )
    }

    /**
     * 主题运行时通过 context 进入设置面板，避免扩展 slot 的 props 契约。
     */
    const RUNTIME_CONTEXT = React.createContext(undefined)


    /**
     * 插件需要的能力：设置页 slot 与 locale 字典。
     */
    const inject = ['slots', 'locale']

    /**
     * 客户端插件入口。
     *
     * 注册 locale 字典与 settings.section，构造全局 ThemeRuntime，并先用本地缓存渲染首帧，
     * 再异步拉取宿主配置。导航标签是唯一需要跟随界面语言的文案，label 通过 locale.bind 读取；
     * 最小测试桩没有 bind 时退回中文，面板正文本身不经过 locale。
     *
     * MutationObserver 只在 body 的深色标记或 class 变化时重新应用，避免无关 DOM 变动触发整份
     * CSS 重写；ctx.effect 返回的清理函数负责断开监听并销毁运行时。
     */
    function apply(ctx) {
      const runtime = new ThemeRuntime()

      const nav = { zh: '主题工作室', en: 'Theme Studio' }
      ctx.effect(() => ctx.locale.register(SETTINGS_NS, {
        zh: { nav: nav.zh },
        en: { nav: nav.en },
      }), 'dsh-theme-studio: settings dictionary')

      const t = typeof ctx.locale.bind === 'function'
        ? ctx.locale.bind(SETTINGS_NS)
        : (key) => (key === 'nav' ? nav.zh : key)

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'theme-studio',
            order: 40,
            label: () => t('nav'),
            locale: SETTINGS_NS,
            inject: () => ({}),
          },
          (props) => h(RUNTIME_CONTEXT.Provider, { value: runtime }, h(ThemeStudioSection, props)),
        ),
      )

      runtime.load().then(() => {
      })

      clearLegacyCachedConfig()

      const cachedConfig = readCachedConfig()
      if (cachedConfig !== null) runtime.apply(cachedConfig)

      runtime.subscribe((config) => writeCachedConfig(config))

      let lastDark = document.body?.hasAttribute?.('data-ds-dark-theme') === true
      let lastClass = document.body?.className ?? ''
      const observer = new MutationObserver(() => {
        const dark = document.body?.hasAttribute?.('data-ds-dark-theme') === true
        const className = document.body?.className ?? ''
        if (dark === lastDark && className === lastClass) return
        lastDark = dark
        lastClass = className
        runtime.apply(runtime.config)
      })
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class'] })
      if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class'] })

      ctx.effect(() => () => {
        observer.disconnect()
        runtime.destroy()
      }, 'dsh-theme-studio: teardown')
    }

    /**
     * 对外导出：apply/inject 供 DSH 加载；其余纯函数与组件供契约、迁移和冒烟测试直接调用，
     * 避免测试只能靠字符串匹配源码。
     */
    exports.name = 'dsh-theme-studio'
    exports.inject = inject
    exports.apply = apply
    exports.ThemeRuntime = ThemeRuntime
    exports.buildCss = buildCss
    exports.defaultConfig = defaultConfig
    exports.sanitizeConfig = sanitizeConfig
    exports.mergePatch = mergePatch
    exports.REGIONS = REGIONS
    exports.ACCENT_PRESETS = ACCENT_PRESETS
    exports.REGION_SELECTORS = REGION_SELECTORS
    exports.diagnose = diagnose
    exports.toCssUrl = toCssUrl
    exports.cleanCssUrl = cleanCssUrl
    exports.readJsonResponse = readJsonResponse
    exports.describeHostFailure = describeHostFailure
    exports.DiagReport = DiagReport
    exports.Thumb = Thumb

    return module.exports
  },
})
