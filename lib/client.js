/**
 * dsh-theme-studio —— 浏览器（客户端）半侧。
 *
 * 交付形态：一个「惰性 CJS」bundle。文件末尾的 `window.__ModuleLoader__.load({...})`
 * 只注册工厂，模块体的副作用（注入 <style>、建背景层）都在工厂闭包里，
 * 由 client-modules 在首次物化时执行 —— 这是 DSH 客户端插件的既定契约。
 *
 * 本文件刻意不引入任何构建步骤：React 用 `React.createElement`（别名 h）直接写，
 * 样式用自己的前缀 `ds-ts-`，只借用 DSH 的 `--dsw-*` 设计令牌，因此升级不易碎。
 *
 * 三个能力：
 *   1. ThemeRuntime：把一份配置编译成 CSS 变量 + 玻璃规则，注入并实时更新；
 *   2. 背景层：一个 position:fixed 的图层承载壁纸/遮罩/噪点/暗角；
 *   3. 设置页面板：注册进 `settings.section`，控制上面两者并通过宿主 API 持久化。
 *
 * @module dsh-theme-studio/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-theme-studio',
  factory: (require) => {
    // 强制严格模式：模块加载器可能以非严格模式执行 bundle，那样「给未声明的变量赋值」
    // 会静默创建一个全局变量而不是报错（曾把 `const applyWallpaper = …` 写成裸赋值，
    // 结果只在真正渲染面板时才炸，静态检查与工厂物化都发现不了）。
    // 加上这一行，同类手误会在加载期就抛 ReferenceError。
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /* ═══════════════════════════════════════════════════════════════════
     * 常量与数据模型
     * ═══════════════════════════════════════════════════════════════════ */

    const API = '/theme-studio/api'
    const ROOT_ATTR = 'data-dsh-theme-studio'
    const STYLE_ID = 'dsh-theme-studio/theme.css'
    const BG_ID = 'dsh-theme-studio-bg'
    const CACHE_KEY = 'dsh-theme-studio:config'
    const SETTINGS_NS = 'theme-studio'

    /**
     * 分区定义：每个分区有独立的毛玻璃参数。
     *
     * ⚠️ **四个旧分区已经删除**，它们不在这里，`REGION_SELECTORS` 与
     * `defaultConfig().glass` 里也没有对应键 —— 旧配置里的残键由宿主的
     * `dropRetiredKeys()` 在读盘/写盘两条路径上剔除：
     *
     *   - `sidebar`（0.1.9 删）：两种层级方案都出现「模糊断层」，用户要求先彻底删掉再重做。
     *   - `topbar`（0.1.12 删）：用户要求「模糊等代码全部删除」。
     *   - `chat`（0.1.13 删）：用户要求「删除对话区这个位置的效果和设置对应的选项」。
     *     它的两条选择器 `.pI_x6G_centerCol` 与 `.wSkVaW_root` **都是顶边栏的祖先**，
     *     所以调低「对话区」的模糊会把顶边栏一起糊掉。
     *   - `panel`（0.1.14 删）：用户要求「删除掉设置界面可以调的透明和模糊效果」。
     *
     * ✅ `sidebar` 与 `topbar` 已在 **0.1.15 以 `bars`（边栏）合并重写**：
     * 两者合成一个分区、共用一份设置（开关 / 不透明度 / 模糊），设置页里叫「边栏」。
     * 实现方式与前三版都不同 —— **膜与模糊放在元素的 `::before` 上**，
     * 详见 `buildBarsCss()` 的注释（那里写了为什么只有这样才不会重演前三次的故障）。
     * 注意旧键 `sidebar` / `topbar` **仍然留在宿主的 RETIRED_REGIONS 里**：
     * 新分区是全新的键 `bars`，旧键不该复活。
     *
     * 重做某个分区时请把对应的 `key` 加回本表、`REGION_SELECTORS` 与 `defaultConfig().glass`。
     */
    const REGIONS = [
      { key: 'bars', zh: '边栏', en: 'Bars', hint: '侧边栏与顶边栏，共用一份参数' },
      { key: 'input', zh: '输入框', en: 'Composer', hint: '底部输入卡片' },
      {
        key: 'bubble',
        zh: '气泡',
        en: 'Bubbles',
        hint: '你的消息气泡与附件卡',
        // 同 `menu`：目标元素只在整个应用的**某种状态**下才存在，0 命中不代表选择器过期。
        // 判据见 diagnose()。实测：`.Sixlwa_bubble` 只在会话里有**用户消息**时才渲染
        // （探针真的发了一条消息才命中，见 tools/probe-diag-report.mjs 的「判定 0」）。
        required: false,
        note: '气泡只在当前会话里有你的消息时才存在（附件卡同理，要带附件）—— 0 命中通常只说明这个会话还没有你的消息，发一条就会出现。',
      },
      {
        key: 'menu',
        zh: '弹层菜单',
        en: 'Popovers',
        hint: '下拉菜单、悬浮提示、Toast',
        // 「主要路径不靠元素规则」的分区：0 命中是**正常**状态，不是故障。
        // 详见下面 REGION_SELECTORS.menu 的说明，以及 diagnose() 里的判据。
        required: false,
        // 只在这类分区「0 命中」时补一行灰字解释，避免把正常状态显示成红色的「未命中」。
        note: '本区主要靠令牌覆盖生效，元素规则只是条件 —— 那几条只在对应浮层真正弹出时才存在，0 命中属正常。',
      },
    ]

    /** 主题色预设：名字 + RGB。 */
    const ACCENT_PRESETS = [
      { id: 'deepseek', zh: 'DeepSeek 蓝', en: 'DeepSeek', rgb: [65, 118, 230] },
      { id: 'ocean', zh: '远洋青', en: 'Ocean', rgb: [20, 150, 160] },
      { id: 'violet', zh: '星云紫', en: 'Violet', rgb: [124, 92, 232] },
      { id: 'sakura', zh: '樱花粉', en: 'Sakura', rgb: [232, 106, 148] },
      { id: 'amber', zh: '琥珀金', en: 'Amber', rgb: [214, 138, 32] },
      { id: 'forest', zh: '松林绿', en: 'Forest', rgb: [46, 160, 96] },
      { id: 'crimson', zh: '朱砂红', en: 'Crimson', rgb: [214, 62, 62] },
      { id: 'graphite', zh: '石墨灰', en: 'Graphite', rgb: [120, 126, 138] },
    ]

    /**
     * 模糊半径上限（px）。所有分区共用，不再有「画质档位」那一层。
     * 100px 远超任何实际可用的磨砂强度，留这么大的余量是为了「拉到最大」时
     * 不会被一个看不见的档位悄悄截断 —— 之前上限 40px 就是这个毛病。
     */
    const MAX_BLUR = 100

    /** 默认配置：必须与宿主 lib/index.js 的 defaultConfig() 保持一致。 */
    function defaultConfig() {
      return {
        version: 2,
        enabled: true,
        scope: 'root',
        accent: { enabled: false, rgb: [65, 118, 230], preset: 'deepseek' },
        // 出厂不改动壁纸：所有效果项都是中立值。
        wallpaper: {
          source: 'none',
          folders: [],
          urls: [],
          // ⚠️ 没有 `hidden`（0.2.0 删除）。原先是「被移出候选」的本地图片名单，
          // 用户不要「恢复已移除」这个功能，而名单没有出口就是静默黑洞，因此整套拆掉。
          // 现在文件夹来源的 ✕ 只作用于当前会话的候选墙（前端 state），宿主侧
          // `RETIRED_WALLPAPER_KEYS` 会在读盘时把这个键从老配置里物理删除。
          current: '',
          fixed: '',
          recursive: true,
          fit: 'cover',
          position: 'center',
          blur: 0,
          brightness: 1,
          saturation: 1,
          dim: 0,
          vignette: 0,
          noise: 0,
          rotate: 'session',
        },
        // 出厂不做毛玻璃：不透明度 1（完全不透明）+ 模糊 0。用户拉「不透明度」才开始透。
        glass: {
          // `sidebar` / `topbar`（0.1.15 合并重写为 `bars`）、`chat`（0.1.13 删）、
          // `panel`（0.1.14 删）都不在这里；旧配置里残留的同名键会在宿主
          // readConfig()/writeConfig() 里被剔除。
          // 每个分区的 `saturation` 参数已移除（0.1.11）——只剩「开关 / 不透明度 / 模糊」三项。
          bars: { enabled: true, opacity: 1, blur: 0 },
          input: { enabled: true, opacity: 1, blur: 0 },
          bubble: { enabled: true, opacity: 1, blur: 0 },
          menu: { enabled: true, opacity: 1, blur: 0 },
          border: 0.6,
          highlight: 0.5,
        },
      }
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 小工具
     * ═══════════════════════════════════════════════════════════════════ */

    /**
     * 深合并：数组与标量整体覆盖，对象递归合并。
     * @param base - 默认值。
     * @param patch - 已存值。
     * @returns 合并结果。
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

    /** 限定范围内的数字。 */
    const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value)))

    /** 把 rgb 数组变成 `r g b` 片段（给 rgb() / 现代语法复用）。 */
    const rgbPair = (rgb) => `${Math.round(rgb[0])} ${Math.round(rgb[1])} ${Math.round(rgb[2])}`

    /** 把 rgb 数组变成 `#rrggbb`。 */
    const toHex = (rgb) =>
      `#${rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`

    /**
     * 解析 `#rgb` / `#rrggbb` / `rgb(r,g,b)`。
     * @param text - 输入文本。
     * @returns rgb 数组，或 null。
     */
    function parseColor(text) {
      const value = String(text ?? '').trim()
      const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)
      if (hex !== null) {
        let body = hex[1]
        if (body.length === 3) body = body.split('').map((c) => c + c).join('')
        return [0, 2, 4].map((i) => parseInt(body.slice(i, i + 2), 16))
      }
      const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(value)
      if (rgb !== null) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
      return null
    }

    /** 混色：t=0 取 a，t=1 取 b。 */
    const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)

    /** 主题色的浅色态派生：向白混合。 */
    const tint = (rgb, t) => mix(rgb, [255, 255, 255], t)
    /** 主题色的深色态派生：向黑混合。 */
    const shade = (rgb, t) => mix(rgb, [0, 0, 0], t)

    /** 稳健取值：路径不存在时返回兜底。 */
    function get(object, path, fallback) {
      let cursor = object
      for (const key of path.split('.')) {
        if (cursor === null || cursor === undefined || typeof cursor !== 'object') return fallback
        cursor = cursor[key]
      }
      return cursor === undefined ? fallback : cursor
    }

    /** 写值（不可变）：返回新对象。 */
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

    /* ═══════════════════════════════════════════════════════════════════
     * 主题样式：配置 → CSS
     * ═══════════════════════════════════════════════════════════════════ */

    /**
     * 每个分区的选择器。变量覆盖是主路径（不依赖 DOM 结构），
     * `backdrop-filter` 是辅路径（需要具体元素）。
     *
     * 类名是从 DSH 的客户端 bundle 里逐个反查出来的。实测 DSH 同时存在三种命名：
     *   1. `<hash>_<局部名>`            —— CSS Modules 默认，如 `wSkVaW_header`、`VOzbGW_panel`
     *   2. `_<局部名>_<hash>_<行号>`     —— Web 外壳的 Vite 构建，如 `_dialog_w1urq_22`、`_menu_17p4l_444`
     *   3. `_<hash>_<局部名>`            —— 如 `_root_1nxmc_1`、`_7KE1Ra_root`
     * 第 2 种的类名中间确实夹着下划线，所以 `[class*="_dialog_"]` 这类属性兜底是**有效**的
     * （已在 `dsh-web-frontend/dist/assets/index-*.css` 里逐个核对到实体类名）。
     *
     * ⚠️ 反面教材（0.1.9 已删）：本表原来还写着
     * `[class*="_header_"][class*="_wSkVaW_"]` 与 `[class*="_card_"][class*="_uV2eYG_"]`。
     * 它们要求**同一个元素**身上既有含 `_header_` 的类、又有含 `_wSkVaW_` 的类 ——
     * 而 `_wSkVaW_` / `_uV2eYG_` 在全量 DSH 资源里出现 **0 次**（`wSkVaW` 只以
     * `wSkVaW_header` 这种 hash 在前的形式存在）。一个模块的哈希只可能以它被构建时
     * 的那一种约定出现，所以这种兜底**永远不可能命中**，是纯粹的误导。不要再写回来。
     *
     * 全部失配时只是「该分区没有毛玻璃」，绝不会报错或破版。
     * 面板里的「分区命中自检」会实时报告命中情况。
     */
    const REGION_SELECTORS = {
      // `chat`（`.pI_x6G_centerCol` + `.wSkVaW_root`）与
      // `panel`（`.VOzbGW_panel` + `.VOzbGW_mask` + 三条外壳兜底）已从本表移除 ——
      // 原因见上面 REGIONS 的说明。重做时把对应行加回来即可。
      //
      // ⚠️ `bars` 这两条**不走 regionRule**（那个函数是「一条规则打一个元素」），
      // 它们由 `buildBarsCss()` 特殊处理：底色与模糊都落在 `::before` 上。
      // 列在这里是为了让面板的「分区命中自检」仍然能报告命中数。
      bars: ['.hHd-Xa_root', '.wSkVaW_header'],
      input: ['.uV2eYG_card'],
      bubble: ['.Sixlwa_bubble', '.Sixlwa_fileCard'],
      // 弹层菜单覆盖十来个包，统一走 --dsw-specific-menu / --dsw-alias-bg-layer-3 两个令牌；
      // 元素级这里只处理「不消费令牌」或「需要真正模糊」的几个。
      // 五个硬编码类名逐个在对应包的 client.js 里核对过（chat / conversation / commands /
      // cordis / subagent，各出现 2 次）；它们只在对应组件真正渲染时才命中，
      // 例如「模式选择」「指令面板」弹出的浮层用的是 `_list_1nxmc_8`、`_portal_1nxmc_44`，
      // 这几条一个都不匹配 —— 那种浮层靠令牌覆盖生效，不靠元素规则。
      //
      // ⚠️ 因此本区在设置面板里**必须标成 `required: false`**（见 REGIONS）。
      // 这五条全部是条件渲染的浮层（chat 的统计弹层、conversation 的用量圆环弹窗、
      // commands 的指令面板、cordis 面板、subagent 菜单），在设置弹窗里跑自检时
      // 它们一个都不在 DOM 里，0 命中是**必然**。早先面板把它按「未命中」标红，
      // 看上去像坏了 —— 那是误报。
      menu: ['.bRhRbq_panel', '.JObwrW_panel', '.mufS8W_card', '.Nqubda_panel', '.ZKlsPq_menu', '[class*="_menu_"]'],
      // 顺带一提：`panel` 当年那三条外壳兜底（`[class*="_dialog_"]` 等）本身是**有效**的
      // （外壳 CSS 里确实有 `_dialog_w1urq_22` / `_float_17p4l_306` / `_mask_w1urq_14`），
      // 它们只是随分区一起删掉了。将来若重做，别把它们当成「死选择器」删漏。
    }

    /**
     * 背景层样式。图层挂在 <html> 下、z-index 为负，因此必须让 html/body 自身透明，
     * 同时保证 #root 形成自己的层叠上下文把内容压在上面。
     * 变量由 BackgroundLayer.apply() 写在 #dsh-theme-studio-bg 上。
     *
     * ⚠️ 这里的 **`z-index: -2` 不能改回 `-1`**：0.1.15 起「边栏」的膜与模糊放在
     * `.hHd-Xa_root::before` / `.wSkVaW_header::before` 上，那两个伪元素是 `z-index: -1`。
     * 它们和本图层同在**根层叠上下文的负层**里，只能靠 z-index 分先后 ——
     * 壁纸层必须是 `-2`（更负 → 先画 → 在下面），否则壁纸会盖住侧栏与顶边栏的磨砂。
     * 之所以不能让伪元素留在元素自己的层叠上下文里，见 `buildBarsCss()` 的说明。
     */
    const BACKGROUND_CSS = `
html[${ROOT_ATTR}], html[${ROOT_ATTR}] body { background: transparent !important; }
html[${ROOT_ATTR}] #${BG_ID} { position: fixed; inset: 0; z-index: -2; pointer-events: none; overflow: hidden; contain: strict; }
html[${ROOT_ATTR}] #${BG_ID} > div { position: absolute; inset: 0; }
html[${ROOT_ATTR}] #${BG_ID} .ds-ts-bg-base { background: var(--ds-ts-bg-basecolor, #fff); }
html[${ROOT_ATTR}] #${BG_ID} .ds-ts-bg-image {
  background-image: var(--ds-ts-bg-url, none);
  background-size: var(--ds-ts-bg-size, cover);
  background-position: var(--ds-ts-bg-position, center);
  background-repeat: var(--ds-ts-bg-repeat, no-repeat);
  filter: blur(var(--ds-ts-bg-blur, 0px)) brightness(var(--ds-ts-bg-brightness, 1)) saturate(var(--ds-ts-bg-saturate, 1));
  /* blur 会把边缘糊出一圈透明，放大 3% 让糊边落在视口外 */
  transform: scale(1.03);
}
html[${ROOT_ATTR}]:has(body[data-ds-dark-theme]) #${BG_ID} .ds-ts-bg-base { background: #0f1115; }html[${ROOT_ATTR}] #${BG_ID} .ds-ts-bg-dim { background: rgb(0 0 0 / var(--ds-ts-bg-dim, 0)); }
html[${ROOT_ATTR}]:has(body[data-ds-dark-theme]) #${BG_ID} .ds-ts-bg-dim { background: rgb(0 0 0 / calc(var(--ds-ts-bg-dim, 0) * .7)); }
html[${ROOT_ATTR}] #${BG_ID} .ds-ts-bg-vignette { background: radial-gradient(120% 90% at 50% 40%, transparent 45%, rgb(0 0 0 / var(--ds-ts-bg-vignette, 0)) 100%); }
html[${ROOT_ATTR}] #${BG_ID} .ds-ts-bg-noise { background-image: var(--ds-ts-bg-noise, none); background-repeat: repeat; opacity: .9; mix-blend-mode: overlay; }
`

    /**
     * 「边栏」分区的 CSS：**侧边栏与顶边栏共用一套做法**（同一个分区、同一份设置）。
     *
     * ── 为什么是 `::before`，而不是元素自身 ──────────────────────────────
     *
     * 这个分区是第四次重写，前三次的故障都出在「膜和模糊放在哪一层」上：
     *
     *   1. **放在子元素上** → 子元素采到的 backdrop 是父级已经铺好的那层平膜，
     *      模糊一层平膜等于没模糊。观感就是「只有控件自己有边界，控件之外是平的」。
     *      结论：**膜与模糊必须在同一个元素上**。
     *   2. **放在元素自身上**（0.1.7）→ 那个元素成了 `position: fixed` 后代的包含块，
     *      而设置弹窗 `.VOzbGW_overlay` 就渲染在侧栏子树内部
     *      （`.hHd-Xa_root` → `.hHd-Xa_footArea` → `.hHd-Xa_settingsArea`）。
     *      结果弹窗被锁进侧栏的 280×807，只能靠一条 `:has(.VOzbGW_overlay)` 让位
     *      规则打补丁 —— 那条补丁本身又带来了新的观感问题。
     *   3. **`::before`** → 它同样承载「膜 + 模糊」（满足第 1 条），
     *      但**伪元素不可能是任何元素的祖先**，所以它带 `backdrop-filter` 时
     *      *永远*不会给设置弹窗制造包含块（绕开第 2 条）。
     *      两边的要求同时满足，**不需要任何让位规则**。
     *
     * ── 为什么还要把两处底色剥掉 ────────────────────────────────────────
     *
     * 伪元素模糊的是「它背后已经画好的东西」。实测（见 `tools/scout-bars.mjs`）：
     * `.hHd-Xa_root` 与 `.pI_x6G_sidebarCol` **两层都是实色 `#f9fafb`**
     * （都来自 `--dsw-specific-sidebar-fill`）。不剥掉的话，伪元素背后是一片平色，
     * 模糊它等于没模糊 —— 又会退化成第 1 条那个故障。
     * 顶边栏那侧本来就是透明的（`.wSkVaW_header` 与 `.wSkVaW_root` 都无底色），
     * 所以只有侧栏需要额外剥一层。
     *
     * ── 为什么只加 `position: relative`、**故意不加 `z-index`** ──────────
     *
     * `position: relative` 是必需的：伪元素要一个定位祖先，`inset: 0` 才能铺满本元素。
     *
     * 但 `z-index` **一个都不能加**。这里踩过一次真实故障：最初写的是
     * `position: relative; z-index: 0`，本意是「让伪元素的 `z-index: -1` 落在本元素内部」。
     * 可是 `z-index: 0` 会**创建层叠上下文**，而设置弹窗 `.VOzbGW_overlay`
     * （`position: fixed; z-index: 1000`）就在这个元素内部 —— 那个 1000 于是变成
     * 「相对于侧栏」的 1000，被关在里面。而 `.wSkVaW_root`（中心列的外壳）是
     * `position: relative; z-index: auto`，按 CSS 2.1 附录 E 它按 `z-index: 0` 参与绘制、
     * 且 DOM 顺序排在 `.hHd-Xa_root` 之后 —— 结果**整块设置弹窗被对话界面盖住**
     * （用户截图报障，`tools/probe-bars.mjs` 的 `elementFromPoint` 断言复现）。
     *
     * 去掉 `z-index` 之后，本元素**不是**层叠上下文，于是：
     *   · 伪元素的 `z-index: -1` 逃到**根**层叠上下文的负层，仍然排在所有常规流内容之下；
     *   · 弹窗的 `z-index: 1000` 也参与根上下文，与没装插件时完全一样。
     * 这是「既要伪元素排在内容之下、又不许把弹窗关起来」的唯一解。
     *
     * 代价：伪元素与**壁纸图层**现在同在根上下文的负层，只能靠 z-index 分先后 ——
     * 壁纸层改用 `z-index: -2`（见 `BACKGROUND_CSS`），伪元素是 `-1`，所以伪元素永远在上。
     * 全站没有别的负 z-index 元素（`tools/probe-bars.mjs` 每次都会数一遍）。
     *
     * @param glass - 生效配置里的 `glass` 节。
     * @returns CSS 行数组；分区关闭时返回空数组。
     */
    function buildBarsCss(glass) {
      const lines = []
      if (get(glass, 'bars.enabled', true) === false) return lines
      const opacity = clamp(get(glass, 'bars.opacity', 0.62), 0, 1)
      const blur = clamp(get(glass, 'bars.blur', 18), 0, MAX_BLUR)

      const selectors = REGION_SELECTORS.bars
      const scoped = selectors.map((selector) => `html[${ROOT_ATTR}] ${selector}`)
      const pseudo = selectors.map((selector) => `html[${ROOT_ATTR}] ${selector}::before`)

      // ① 只给一个定位祖先 + 把元素自身的实色底色让给伪元素。
      //    ⚠️ 这里**绝不能出现 z-index** —— 见上面的说明。
      lines.push(`${scoped.join(',\n')} {`)
      lines.push('  position: relative;')
      lines.push('  background: transparent !important;')
      lines.push('}')

      // ② 侧栏那侧的实色有**三个来源**，要一起处理（顶边栏那侧本来就是透明的，不需要）：
      //
      //    · .pI_x6G_sidebarCol —— 侧栏列的外层，`background: var(--dsw-specific-sidebar-fill)`
      //    · .hHd-Xa_root       —— 侧栏根，同一个 token
      //    · .bhn1Oq_fade       —— **会话列表底部的 24px 渐隐遮罩**，规则是
      //        `background: linear-gradient(to bottom, transparent, var(--dsw-specific-sidebar-fill))`
      //
      // 前两个各自加 `background: transparent` 就够了，但渐隐遮罩不行 ——
      // 它不是「一层底」，而是画在列表底部的一条**不透明渐变色带**。
      // 侧栏原本是不透明的，这条带子与背景同色、看不出来；一旦壁纸透出来，
      // 它就成了一条白带（用户截图报障）。
      //
      // 所以这里把**源头**掐掉：在 .hHd-Xa_root 上把这个 token 覆盖成透明。
      // 自定义属性会继承，于是 .hHd-Xa_root 自己与它内部的 .bhn1Oq_fade 一起变透明。
      //
      // ⚠️ 作用域**必须限定在 .hHd-Xa_root**，不能全局覆盖：会话区里还有一个
      // `Y0dWHa_split { background: var(--dsw-specific-sidebar-fill) }`（trajectory 的标签），
      // 那是对话内容的一部分，不该被「边栏」分区影响。
      // ⚠️ 而且 .pI_x6G_sidebarCol 是 .hHd-Xa_root 的**父级**，继承不到覆盖后的值，
      // 所以它仍然需要自己那条规则。
      if (selectors.includes('.hHd-Xa_root')) {
        lines.push(`html[${ROOT_ATTR}] .hHd-Xa_root { --dsw-specific-sidebar-fill: transparent !important; }`)
        lines.push(`html[${ROOT_ATTR}] .pI_x6G_sidebarCol { background: transparent !important; }`)
      }

      // ③ 膜 + 模糊，都在这一个伪元素上。
      lines.push(`${pseudo.join(',\n')} {`)
      lines.push("  content: '';")
      lines.push('  position: absolute;')
      lines.push('  inset: 0;')
      lines.push('  z-index: -1;')
      lines.push('  pointer-events: none;')
      lines.push('  border-radius: inherit;')
      lines.push('  background-color: var(--ds-ts-bars);')
      // 不透明度 100% 时膜本身就不透明，模糊毫无视觉效果，省掉 GPU 开销（与其它分区一致）。
      if (opacity < 0.995 && blur > 0) {
        lines.push(`  backdrop-filter: blur(${blur}px);`)
        lines.push(`  -webkit-backdrop-filter: blur(${blur}px);`)
      }
      lines.push('}')
      return lines
    }

    /**
     * 把配置编译成完整样式表。
     * @param config - 生效配置。
     * @returns CSS 文本。
     */
    function buildCss(config) {
      const glass = config.glass ?? {}
      const accent = config.accent ?? {}

      const lines = []

      /* ── 变量层：让壁纸透出来 ─────────────────────────────── */
      const alphaOf = (key, fallback) => clamp(get(glass, `${key}.opacity`, fallback), 0, 1)
      const on = (key) => get(glass, `${key}.enabled`, true) !== false

      // `--ds-ts-bars` 只在分区开着时才输出：其它分区的变量始终存在，是因为总有
      // 一条 token 覆盖在消费它；而 bars 的变量**只**被那个 ::before 消费，
      // 分区关掉时留着它就是一条没人读的死变量。
      const barsOn = on('bars')
      const barsA = barsOn ? alphaOf('bars', 0.62) : 1
      const inputA = on('input') ? alphaOf('input', 0.58) : 1
      const bubbleA = on('bubble') ? alphaOf('bubble', 0.6) : 1
      const menuA = on('menu') ? alphaOf('menu', 0.68) : 1

      lines.push(`html[${ROOT_ATTR}] {`)
      lines.push('  --ds-ts-frame: transparent;')
      if (barsOn) lines.push(`  --ds-ts-bars: rgb(255 255 255 / ${barsA.toFixed(3)});`)
      lines.push(`  --ds-ts-input: rgb(255 255 255 / ${inputA.toFixed(3)});`)
      lines.push(`  --ds-ts-bubble: rgb(219 234 254 / ${bubbleA.toFixed(3)});`)
      lines.push(`  --ds-ts-menu: rgb(255 255 255 / ${menuA.toFixed(3)});`)
      lines.push('}')
      lines.push(`html[${ROOT_ATTR}][data-ds-dark-theme], html[${ROOT_ATTR}]:has(body[data-ds-dark-theme]) {`)
      lines.push('  --ds-ts-frame: transparent;')
      if (barsOn) lines.push(`  --ds-ts-bars: rgb(21 21 23 / ${barsA.toFixed(3)});`)
      lines.push(`  --ds-ts-input: rgb(21 21 23 / ${inputA.toFixed(3)});`)
      lines.push(`  --ds-ts-bubble: rgb(35 38 46 / ${bubbleA.toFixed(3)});`)
      lines.push(`  --ds-ts-menu: rgb(24 24 27 / ${menuA.toFixed(3)});`)
      lines.push('}')

      /* ── token 覆盖：只覆盖「表面」令牌，不碰文字与代码块令牌 ── */
      lines.push(`html[${ROOT_ATTR}] body {`)
      lines.push('  --dsw-alias-bg-base: var(--ds-ts-frame) !important;')
      lines.push('  --dsw-alias-bg-layer-2: var(--ds-ts-menu) !important;')
      lines.push('  --dsw-alias-bg-layer-3: var(--ds-ts-menu) !important;')
      lines.push('  --dsw-specific-input-major: var(--ds-ts-input) !important;')
      lines.push('  --dsw-specific-tip: var(--ds-ts-menu) !important;')
      lines.push('  --dsw-specific-selector: var(--ds-ts-menu) !important;')
      lines.push('  --dsw-specific-menu: var(--ds-ts-menu) !important;')
      lines.push('  --dsw-elevation-soft: var(--ds-ts-edge) !important;')
      lines.push('  --dsw-elevation-panel: var(--ds-ts-edge) !important;')
      lines.push('  --dsw-elevation-prominent: var(--ds-ts-edge) !important;')
      lines.push('  --dsw-elevation-stroke-color: var(--ds-ts-edge-color) !important;')
      // 0.1.14 删掉了三条与「设置界面」分区绑定的 token 覆盖：
      //   --dsw-alias-bg-layer-1 / --dsw-alias-bg-overlay（原本接 --ds-ts-panel）
      //   --dsw-mask-blur（原本接 panel.blur，用来接管设置遮罩自身的模糊）
      // 现在它们都回到 DSH 的原生值。设置弹窗的面板底色走 --dsw-alias-bg-layer-2，
      // 那一条仍然由「弹层菜单」分区控制 —— 也就是说调「弹层菜单」的不透明度、
      // 设置弹窗会跟着变，这是 DSH 原生的令牌用法，不是插件把它们绑在一起的。
      lines.push('}')
      lines.push(`html[${ROOT_ATTR}] body { --dsw-specific-bubble: var(--ds-ts-bubble) !important; }`)

      /* ── 玻璃描边与高光 ─────────────────────────────────── */
      const borderA = clamp(get(glass, 'border', 0.6), 0, 1)
      const highA = clamp(get(glass, 'highlight', 0.5), 0, 1)
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

      /* ── 主题色：只染品牌相关令牌，代码块/正文着色不动 ────── */
      if (accent.enabled) {
        const rgb = accent.rgb ?? [65, 118, 230]
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

      /* ── 玻璃：作用到具体元素 ─────────────────────────────── */
      const backdrop = (key, fallbackOpacity, fallbackBlur) => {
        if (!on(key)) return null
        const opacity = clamp(get(glass, `${key}.opacity`, fallbackOpacity), 0, 1)
        if (opacity >= 0.995) return null // 不透明时 backdrop-filter 毫无意义，省掉 GPU 开销
        const blur = clamp(get(glass, `${key}.blur`, fallbackBlur), 0, MAX_BLUR)
        return `backdrop-filter: blur(${blur}px); -webkit-backdrop-filter: blur(${blur}px);`
      }

      const regionRule = (key, selectors, vars, fallbackOpacity, fallbackBlur) => {
        const filter = backdrop(key, fallbackOpacity, fallbackBlur)
        if (filter === null) return
        // 选择器一律前缀开启属性：既提高特异性压过触发器的样式，也保证关掉插件后
        // 这些规则整体失效（否则 backdrop-filter 会残留下来）。
        const list = selectors.map((selector) => `html[${ROOT_ATTR}] ${selector}`).join(',\n')
        lines.push(`${list} {`)
        for (const [prop, value] of Object.entries(vars)) lines.push(`  ${prop}: ${value};`)
        lines.push(`  ${filter}`)
        lines.push('}')
      }

      // 外壳本身必须透明，否则下面所有玻璃都看不到壁纸。
      lines.push(`html[${ROOT_ATTR}] .pI_x6G_frame { background: transparent !important; }`)

      // ── 边栏（侧边栏 + 顶边栏）：唯一一个「膜 + 模糊」不落在元素自身上的分区 ──
      //
      // 它由 `buildBarsCss()` 单独生成，原因与做法都写在那个函数的注释里。
      // 一句话：底色与模糊都放在元素的 `::before` 上，因为伪元素不可能是任何元素的
      // 祖先，所以它带 `backdrop-filter` 时永远不会给设置弹窗制造包含块。
      lines.push(...buildBarsCss(glass))

      regionRule('input', REGION_SELECTORS.input, {
        background: 'var(--ds-ts-input)',
        'box-shadow': 'var(--ds-ts-inset), var(--ds-ts-edge)',
      }, 0.58, 20)

      regionRule('bubble', REGION_SELECTORS.bubble, {
        background: 'var(--ds-ts-bubble)',
      }, 0.6, 14)

      regionRule('menu', REGION_SELECTORS.menu, {
        'background-color': 'var(--ds-ts-menu)',
      }, 0.68, 24)

      /* ── 背景层自身的样式（承载壁纸/遮罩/暗角/噪点） ─────────── */
      const frameActive = config.enabled !== false && (config.wallpaper?.source ?? 'none') !== 'none'
      lines.push(BACKGROUND_CSS)
      // 透明外壳 + 壁纸在背后时，给文字加一层极轻的描边，抵消背景干扰；
      // 不启用壁纸时完全不输出，避免无谓地改变原有排版观感。
      if (frameActive) {
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
     * 把样式写进文档。用带 data-plugin 的 <style>，让 DSH 的 HMR 能识别归属。
     * @param css - 样式文本。
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

    /* ═══════════════════════════════════════════════════════════════════
     * 背景层
     * ═══════════════════════════════════════════════════════════════════ */

    /**
     * 生成一层极轻噪点（内联 SVG turbulence），避免大片纯色壁纸出现色带。
     * @param strength - 0..0.2
     * @returns background-image 值。
     */
    function noiseLayer(strength) {
      if (strength <= 0.001) return 'none'
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160">` +
        `<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch"/>` +
        `<feColorMatrix type="saturate" values="0"/></filter>` +
        `<rect width="160" height="160" filter="url(%23n)" opacity="${strength.toFixed(3)}"/></svg>`
      return `url("data:image/svg+xml;utf8,${svg.replace(/#/g, '%23').replace(/"/g, "'")}")`
    }

    /**
     * 读一个响应体为 JSON，**并且容忍它根本不是 JSON**。
     *
     * 为什么不能直接 `response.json()`：宿主半侧的改动（比如新增 `/api/reset` 路由）
     * 只有**重启 `dsh web`** 才会生效，而浏览器半侧改完刷新页面就生效 ——
     * 于是「新前端 + 旧宿主」是很容易出现的一种组合：前端去请求一个宿主还不认识的
     * 路径，拿到的是**没有 body 的 404**，`response.json()` 直接抛
     * `Failed to execute 'json' on 'Response': Unexpected end of JSON input`。
     * 那句话对用户毫无意义，也完全没提「你可能需要重启」。
     *
     * 所以这里统一读文本再尝试解析：解析失败就返回 `{ status, body: null, raw }`，
     * 由调用方给出「HTTP 状态 + 是不是该重启」这种可操作的提示。
     * @param response - fetch 的响应。
     * @returns `{ status, body, raw }`；`body` 为 null 表示响应体不是 JSON。
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
     * 把一次失败的宿主请求翻译成**能照着做**的一句话。
     *
     * 特别注意 404 + 空响应体：那不是「插件坏了」，而是宿主进程还是旧的。
     * @param result - `readJsonResponse` 的返回值。
     * @param what - 动作名，用于拼提示。
     * @returns 提示文案。
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
     * 解析一个候选壁纸为可用的 CSS url()。
     * 本地路径走宿主 /api/image，远程走宿主 /api/proxy（同源，绕开 CORS）。
     * @param source - 'folder' | 'url' | 'upload' | 'none'
     * @param value - 路径或 URL。
     * @returns CSS url() 字符串。
     */
    function toCssUrl(source, value) {
      if (!value) return 'none'
      if (/^(https?:|data:|blob:|\/)/i.test(value)) {
        if (value.startsWith('/theme-studio/')) return `url("${value}")`
        if (/^https?:/i.test(value)) return `url("${API}/proxy?url=${encodeURIComponent(value)}")`
        return `url("${value}")`
      }
      return `url("${API}/image?path=${encodeURIComponent(value)}")`
    }

    /**
     * 从 `url("…")` 里剥出裸地址，用于预加载探测与错误提示。
     * @param cssUrl - toCssUrl 的产物。
     * @returns 裸地址。
     */
    function cleanCssUrl(cssUrl) {
      if (typeof cssUrl !== 'string') return ''
      if (cssUrl.startsWith('url("')) return cssUrl.slice(5, -2)
      if (cssUrl.startsWith('url(')) return cssUrl.slice(4, -1)
      return cssUrl
    }

    /**
     * 背景层：所有壁纸相关的视觉都在这一个 fixed 图层里，不污染 DSH 自己的 DOM。
     */
    class BackgroundLayer {
      constructor() {
        this.element = null
        this.imageEl = null
      }

      /** 确保 DOM 存在（挂在 <html> 上，避开任何可能的 stacking context）。 */
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

      /** 移除图层（关闭插件或卸载时调用）。 */
      destroy() {
        this.element?.remove()
        this.element = null
        this.imageEl = null
      }

      /**
       * 应用一份壁纸配置。
       * @param config - 生效配置。
       * @param resolved - 当前实际使用的壁纸值（已由调用方选好）。
       * @returns 预加载结果；加载失败时 `{ ok: false, reason }`，供面板提示。
       */
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
        const position = wp.position ?? 'center'
        const size = fit === 'repeat' ? 'auto' : fit === 'center' ? 'auto' : fit
        element.style.setProperty('--ds-ts-bg-url', toCssUrl(wp.source, resolved))
        element.style.setProperty('--ds-ts-bg-size', size)
        element.style.setProperty('--ds-ts-bg-repeat', fit === 'repeat' ? 'repeat' : 'no-repeat')
        element.style.setProperty('--ds-ts-bg-position', position)
        element.style.setProperty('--ds-ts-bg-blur', `${clamp(wp.blur, 0, 60)}px`)
        element.style.setProperty('--ds-ts-bg-brightness', String(clamp(wp.brightness, 0.2, 2)))
        element.style.setProperty('--ds-ts-bg-saturate', String(clamp(wp.saturation, 0, 2)))
        element.style.setProperty('--ds-ts-bg-dim', String(clamp(wp.dim, 0, 0.9)))
        element.style.setProperty('--ds-ts-bg-vignette', String(clamp(wp.vignette, 0, 1)))
        element.style.setProperty('--ds-ts-bg-noise', noiseLayer(clamp(wp.noise, 0, 0.2)))
        element.removeAttribute('data-bg-error')
        element.removeAttribute('data-bg-error-url')
        element.setAttribute('data-bg-loading', '')
        // 预加载探测：CSS 背景加载失败是完全静默的（用户只看到灰底，会以为插件坏了）。
        // 这里主动加载一次并把结果回报给面板，把「失败」变成一句能读懂的话。
        const url = cleanCssUrl(toCssUrl(wp.source, resolved))
        return new Promise((resolve) => {
          const probe = new Image()
          probe.onload = () => {
            element.removeAttribute('data-bg-loading')
            resolve({ ok: true, width: probe.naturalWidth, height: probe.naturalHeight })
          }
          probe.onerror = () => {
            element.removeAttribute('data-bg-loading')
            element.setAttribute('data-bg-error', '')
            element.setAttribute('data-bg-error-url', url)
            resolve({ ok: false, reason: '图片无法加载', url })
          }
          probe.src = url
        })
      }
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 主题运行时：配置 → 文档
     * ═══════════════════════════════════════════════════════════════════ */

    class ThemeRuntime {
      constructor() {
        this.config = defaultConfig()
        this.background = new BackgroundLayer()
        this.wallpapers = []
        this.resolved = ''
        /**
         * 「本次显式选中」的壁纸，一次性覆盖。
         *
         * 为什么需要它：`resolved` 必须能**跟着配置变**（否则清空 `wallpaper.fixed`
         * 之后背景不会撤，见 apply() 的注释），但点缩略图那一刻配置还没写完，
         * 得先有个地方把用户的选择塞进去。用完即弃。
         */
        this.pendingWallpaper = ''
        /** 最近一次壁纸加载结果：{ ok, reason?, url? }。 */
        this.lastLoadResult = null
        this.listeners = new Set()
      }

      /** 订阅配置变化。 */
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      }

      /** 通知订阅者。 */
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
       * 拉取宿主配置与壁纸候选。
       * @returns 生效配置。
       */
      async load() {
        try {
          const response = await fetch(`${API}/config`, { cache: 'no-store' })
          const payload = (await readJsonResponse(response)).body
          if (payload?.config) this.config = merge(defaultConfig(), payload.config)
        } catch (error) {
          console.warn('[theme-studio] 读取配置失败，使用默认值', error)
        }
        await this.refreshWallpapers()
        this.resolved = this.pickWallpaper()
        this.apply(this.config)
        this.emit()
        return this.config
      }

      /** 重新扫描已登记目录里的图片。 */
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
       * 选出本次实际使用的壁纸。
       * @returns 壁纸值（路径或 URL）。
       */
      pickWallpaper() {
        const wp = this.config.wallpaper ?? {}
        if (wp.source === 'none') return ''
        if (wp.fixed) return wp.fixed
        if (wp.current) return wp.current
        const pool = wp.source === 'url' ? (wp.urls ?? []) : this.wallpapers
        if (pool.length === 0) return ''
        return pool[Math.floor(Math.random() * pool.length)]
      }

      /**
       * 切换一张壁纸（轮换用）。
       * @returns 新壁纸值。
       */
      rotateWallpaper() {
        const wp = this.config.wallpaper ?? {}
        const pool = wp.source === 'url' ? (wp.urls ?? []) : this.wallpapers
        if (pool.length <= 1) return this.resolved
        let next = this.resolved
        let guard = 0
        while (next === this.resolved && guard < 24) {
          next = pool[Math.floor(Math.random() * pool.length)]
          guard += 1
        }
        this.resolved = next
        return next
      }

      /**
       * 应用一份配置（局部更新也走这里）。
       * @param config - 生效配置。
       */
      apply(config) {
        this.config = config
        const enabled = config.enabled !== false
        const root = document.documentElement
        if (!enabled) {
          // 关闭时不留下任何痕迹：属性、样式、背景层全部撤除。
          root.removeAttribute(ROOT_ATTR)
          document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`)?.remove()
          this.background.destroy()
          this.lastLoad = Promise.resolve({ ok: true, skipped: true })
          return this.lastLoad
        }
        root.setAttribute(ROOT_ATTR, '')
        injectStyle(buildCss(config))
        /* ⚠️ 这里**每次都要重算**，绝不能写成 `this.resolved = this.resolved || this.pickWallpaper()`。
         *
         * 那个写法是「一旦有值就永不再算」，于是出现这样一个真实故障（用户报障）：
         * 把候选图全删掉、`wallpaper.fixed/current` 也清空了 —— 配置明明已经没有壁纸，
         * `resolved` 却还死死记着上一张，背景层照旧铺着，**「删掉壁纸」这个动作看起来毫无效果**。
         * 而且重启 `dsh web` 也修不回来：进程内第一次选中的那张会被重新算出来，
         * 只要渲染过的偏好没变就一直卡在那张图上。
         *
         * 现在：`resolved` 每次都从配置重算；只有「刚点了某张图」这一次由
         * `pendingWallpaper` 顶一下（那一瞬间配置还没写完）。 */
        if (this.pendingWallpaper !== '') {
          this.resolved = this.pendingWallpaper
          this.pendingWallpaper = ''
        } else {
          this.resolved = this.pickWallpaper()
        }
        // 记住这次壁纸的加载结果：面板据此提示「这张图为什么没生效」。
        this.lastLoad = this.background.apply(config, this.resolved).then((result) => {
          this.lastLoadResult = result
          this.emit()
          return result
        })
        return this.lastLoad
      }

      /**
       * 局部更新配置并立即生效。
       * @param path - 形如 'glass.input.blur'。
       * @param value - 新值。
       * @returns 更新后的配置。
       */
      patch(path, value) {
        const next = setIn(this.config, path, value)
        this.apply(next)
        this.emit()
        return next
      }

      /** 关闭并复原：撤掉属性、样式与背景层。 */
      destroy() {
        document.documentElement.removeAttribute(ROOT_ATTR)
        document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`)?.remove()
        this.background.destroy()
      }
    }

    /** 元素的可读短名：`div.bRhRbq_panel.xxx`，最多两个类名。 */
    function labelOf(element) {
      const classes = String(element.className ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join('.')
      const tag = element.tagName?.toLowerCase() ?? '?'
      return classes === '' ? tag : `${tag}.${classes}`
    }

    /**
     * 选择器自检：把每个分区的候选选择器拿到真实 DOM 上跑一遍，
     * 报告命中数量与首个命中元素。DSH 升级换掉 CSS Module hash 后，
     * 这一项能立刻告诉你哪个分区失效了，而不是「毛玻璃莫名其妙不生效」。
     *
     * ⚠️ 「0 命中」有两种完全不同的含义，报告里必须区分，否则就是误报：
     *
     *   - **必需**（`REGIONS[].required !== false`，目前是 `bars` / `input`）：
     *     目标元素**始终存在**（只要应用外壳渲染出来了，侧栏/顶边栏/输入卡片就在），
     *     所以 0 命中只可能是选择器过期 → 报「未命中」，标红。
     *
     *   - **条件**（`required === false`，目前是 `bubble` / `menu`）：
     *     目标元素只在整个应用的**某种状态**下才渲染，0 命中是那个状态的必然结果 ——
     *       * `bubble`：只在当前会话有**用户消息**（或附件）时才存在；
     *       * `menu`：五个浮层各自要打开对应弹层才进 DOM，且本区主路径是令牌覆盖。
     *     这两处报「正常」，由面板用中性色显示，**不标红**，并附一行解释。
     *
     * 也就是说：只有 `bars` / `input` 报「未命中」才需要去查选择器。
     *
     * 代价要说清楚：条件分区**真的**换了类名时，这里不会自己招错（它会显示
     * 「正常·0 命中」）。所以选择器的有效性靠 `tools/probe-diag-report.mjs`
     * 的正向证据守着 —— 它真的发一条消息，确认 `.Sixlwa_bubble` 出现。
     *
     * @returns 每个分区的命中报告。
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
            count = -1 // 非法选择器
          }
          hits.push({ selector, count, sample })
        }
        const matched = hits.filter((hit) => hit.count > 0).length
        const invalid = hits.filter((hit) => hit.count < 0).length
        // 必需 = 目标元素**始终存在**（0 命中只可能是选择器过期）；
        // false 表示目标只在某种状态下渲染，0 命中是那个状态的必然结果。
        const required = region.required !== false
        // 只有「必需分区一条都没命中」或「选择器本身非法」才算故障；
        // 条件分区 0 命中是正常状态（见上面的说明）。
        const ok = !required || matched > 0
        report.push({ region: region.key, zh: region.zh, note: region.note ?? '', required, hits, matched, total: hits.length, invalid, ok })
      }
      return report
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 面板样式（自带前缀，不依赖任何内部类名）
     * ═══════════════════════════════════════════════════════════════════ */

    const PANEL_CSS = `
.ds-ts-page { display: flex; flex-direction: column; gap: 18px; max-width: 860px; padding: 4px 2px 40px; }
.ds-ts-page h2 { font-size: 15px; font-weight: 600; margin: 0; color: var(--dsw-alias-label-primary); }
.ds-ts-page p { margin: 0; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary); }
.ds-ts-card { border: .5px solid var(--dsw-alias-border-l2); border-radius: 14px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.ds-ts-card > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; }
.ds-ts-card > header .ds-ts-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.ds-ts-card > header .ds-ts-sub { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.ds-ts-body { padding: 0 16px 16px; display: flex; flex-direction: column; gap: 14px; }
.ds-ts-row { display: flex; align-items: center; gap: 12px; min-height: 28px; }
.ds-ts-row .ds-ts-name { flex: none; width: 128px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.ds-ts-row .ds-ts-val { flex: none; width: 74px; font-size: 12px; text-align: right; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary); }
.ds-ts-slider { flex: 1; appearance: none; -webkit-appearance: none; height: 4px; border-radius: 999px; background: var(--dsw-alias-border-l3); outline: none; cursor: pointer; }
.ds-ts-slider::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: var(--ds-ts-accent, var(--dsw-alias-brand-primary-new-colorprimary-new-color)); border: 2px solid var(--dsw-alias-bg-layer-2); box-shadow: 0 1px 3px rgb(0 0 0 / .25); }
.ds-ts-slider::-moz-range-thumb { width: 14px; height: 14px; border: 2px solid var(--dsw-alias-bg-layer-2); border-radius: 50%; background: var(--ds-ts-accent, #4176e6); }
.ds-ts-text, .ds-ts-select, .ds-ts-num { box-sizing: border-box; padding: 6px 10px; font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); border: .5px solid var(--dsw-alias-border-l2); border-radius: 8px; outline: none; }
.ds-ts-text:focus, .ds-ts-select:focus, .ds-ts-num:focus { border-color: var(--dsw-alias-brand-primary-new-colorprimary-new-color); }
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

    /** 注入面板样式（只注一次）。 */
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

    /* ═══════════════════════════════════════════════════════════════════
     * 面板控件
     * ═══════════════════════════════════════════════════════════════════ */

    /** 一行：名称 + 滑块 + 数值。 */
    function SliderRow({ label, value, min, max, step, unit, onChange }) {
      return h(
        'div',
        { className: 'ds-ts-row' },
        h('div', { className: 'ds-ts-name' }, label),
        h('input', {
          className: 'ds-ts-slider',
          type: 'range',
          min,
          max,
          step,
          value,
          onChange: (event) => onChange(Number(event.target.value)),
        }),
        h('div', { className: 'ds-ts-val' }, `${typeof value === 'number' ? Math.round(value * 100) / 100 : value}${unit ?? ''}`),
      )
    }

    /** 一行：名称 + 开关。 */
    function SwitchRow({ label, checked, onChange }) {
      const Switch = primitives?.Switch
      return h(
        'div',
        { className: 'ds-ts-row' },
        h('div', { className: 'ds-ts-name' }, label),
        typeof Switch === 'function'
          ? h(Switch, { checked, onChange })
          : h('input', { type: 'checkbox', checked, onChange: (event) => onChange(event.target.checked) }),
      )
    }

    /** 一行：名称 + 下拉。 */
    function SelectRow({ label, value, options, onChange }) {
      return h(
        'div',
        { className: 'ds-ts-row' },
        h('div', { className: 'ds-ts-name' }, label),
        h(
          'select',
          { className: 'ds-ts-select', value, onChange: (event) => onChange(event.target.value) },
          options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
        ),
      )
    }

    /** 折叠卡片。 */
    function Card({ title, sub, right, children, defaultOpen }) {
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
              { type: 'button', className: 'ds-ts-btn', 'data-variant': 'ghost', onClick: () => setOpen(!open) },
              open ? '收起' : '展开',
            ),
          ),
        ),
        open ? h('div', { className: 'ds-ts-body' }, children) : null,
      )
    }

    /**
     * 一张候选壁纸缩略图：点击图片/文件名即应用为壁纸，悬停时右上角浮出 ✕ 删除。
     *
     * 结构上刻意把两者做成**并列的兄弟**，而不是把 ✕ 嵌进可点击容器里：
     * 嵌套时点 ✕ 会连带触发外层容器的 onClick，于是「删掉的同时又被应用为壁纸」——
     * 实测就是这样（删了但壁纸还是换成了它）。靠 stopPropagation 拦不可靠，
     * 改成兄弟节点后从结构上就不可能互相触发，也不再需要事件拦截。
     *
     * 删除语义按来源区分：
     *   - 文件夹来源：只把这张图从候选墙移出，**磁盘上的原文件不动**；
     *   - URL 来源：同时删掉宿主的本地缓存副本（下次访问会重新下载），
     *     以及从链接列表里移除，**远端原图同样不动**。
     *
     * @param props - src/name/active/kind/label/onPick/onRemove。
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
            // 刻意不用 title：那会弹出浏览器原生提示（内容是完整文件路径）。
            'aria-label': name,
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
            // 不用 title，也不放自绘气泡：用户明确要求悬停 ✕ 时不要任何文字。
            // 语义留给 aria-label，读屏仍可识别。
            'aria-label': label,
            onClick: onRemove,
          },
          h('span', { className: 'ds-ts-thumb-del-x' }, '✕'),
        ),
      )
    }

    /**
     * 自检报告。
     *
     * 呈现方式：**每个分区一行、点这一行才展开该分区的选择器明细**。
     * 早先是「一行一个分区 + 所有选择器拼成一条省略号截断的长串」，两个毛病：
     *   1. 长串必然被 `.ds-ts-mono` 的 `nowrap` + `ellipsis` 吃掉，看不全；
     *   2. 「条件分区 0 命中」被标成红色的「未命中」，把正常状态报成故障。
     * 现在：明细里每条选择器独占一行且可换行；条件分区用中性色 + 一行解释。
     * @param props - items: diagnose() 的返回值。
     */
    function DiagReport({ items }) {
      const [open, setOpen] = React.useState({})
      const failed = items.filter((item) => !item.ok).length
      const flagged = items.filter((item) => item.invalid > 0).length
      // 文案直接写中文：本组件在模块作用域，取不到 ThemeStudioSection 内部的 tr，
      // 而那个 tr 本来就只是 `(zh) => zh` 直通（中文是唯一真源）。
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
          // 条件分区没命中不标红：它的毛玻璃走令牌覆盖，元素规则只是条件。
          const tone = item.invalid > 0 || !item.ok ? 'warn' : item.matched === 0 ? 'soft' : 'ok'
          const status = item.invalid > 0
            ? '选择器非法'
            : item.matched === 0
              ? (item.ok ? '正常' : '未命中')
              : '命中'
          return h(
            'div',
            { className: 'ds-ts-diag-row', key: item.region },
            h(
              'button',
              {
                type: 'button',
                className: 'ds-ts-diag-head',
                'aria-expanded': expanded ? 'true' : 'false',
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
                  { className: 'ds-ts-diag-body' },
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

    /* ═══════════════════════════════════════════════════════════════════
     * 设置页面板
     * ═══════════════════════════════════════════════════════════════════ */

    /**
     * 设置页主面板。
     * @param props - slot 组合后的属性（t 为翻译函数）。
     */
    function ThemeStudioSection({ t }) {
      injectPanelCss()
      /**
       * 面板文案的中文是唯一真源：DSH 目前是中文界面，之前用 `tr(zh, en)`
       * 依据「有没有 t 函数」选分支，结果所有控件都显示了英文，这条弯路去掉。
       * 只有设置导航标签需要跟随界面语言，那里单独用 t('nav')。
       */
      const tr = (zh) => zh
      const runtime = React.useContext(RUNTIME_CONTEXT)
      const [config, setConfig] = React.useState(() => runtime?.config ?? defaultConfig())
      const [tab, setTab] = React.useState('wallpaper')
      const [folders, setFolders] = React.useState([])
      /**
       * 「已经成功扫描过一次」的闸门。**这个不能省。**
       *
       * 「候选空了就复原背景」那个 effect 靠 `gallery.length === 0` 判空，
       * 而 `gallery` 的初始值就是 `[]`、首次扫描回来之前也一直是 `[]` —— 没有这道闸门，
       * 背景会在**页面刚打开、还没扫完盘**的那一瞬间就被撤掉。
       * 实测就是这么坏的：探针里背景层在「选中壁纸」这一步就已经没了。
       */
      const [scanned, setScanned] = React.useState(false)
      const [urlDraft, setUrlDraft] = React.useState('')
      const [folderDraft, setFolderDraft] = React.useState('')
      const [browse, setBrowse] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [gallery, setGallery] = React.useState([])
      /**
       * 本次会话里从候选墙拿掉的**文件夹来源**图片（绝对路径集合）。
       *
       * ⚠️ 这是**纯前端、不落盘、刷新即复原**的。0.2.0 删掉了原来的
       * `wallpaper.hidden` 持久名单：用户不要「恢复已移除」，而名单没有出口
       * 就变成静默黑洞（图在磁盘上、路径在配置里、界面永远看不到）。
       * 用户的意图是「这些是我自己的壁纸库，不许动磁盘上的原图」，所以
       * 文件夹来源的 ✕ 只作用于当前视图；真要删文件请去资源管理器里删。
       * 上传来源与 URL 来源不一样 —— 那些是插件自己产生的副本/缓存，真删。
       */
      const [removed, setRemoved] = React.useState(() => new Set())
      const [diag, setDiag] = React.useState(null)
      /**
       * 「重置配置」的两步确认状态：null | 'config' | 'purge'。
       *
       * 重置是**破坏性**的（登记目录、主题色、玻璃参数全部清空，而且无法撤销），
       * 所以不做成「一点就执行」。用面板内的两步确认而不是 `window.confirm`：
       * 原生弹窗在这个设置页里样式割裂，而且阻塞主线程。
       */
      const [resetArmed, setResetArmed] = React.useState(null)
      const [accentDraft, setAccentDraft] = React.useState(toHex(config.accent?.rgb ?? [65, 118, 230]))

      const saveTimer = React.useRef(null)
      /** 已经排队、还没发出去的那笔写入；只给 persist 的哨兵用（见那里的注释）。 */
      const pendingPatch = React.useRef(null)
      const latest = React.useRef(config)
      latest.current = config

      /**
       * 真的把一笔局部配置发给宿主。
       *
       * ⚠️ 服务端**可能回写配置**（例如删掉候选后把悬空的 `wallpaper.fixed` 清空），
       * 所以写完之后要把服务端的权威结果拉回来覆盖本地，否则两边会不一致。
       * @param patch - 局部配置。
       * @param okText - 保存成功时的提示文案；缺省「已保存」。
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
            setStatus({ kind: 'err', text: describeHostFailure(result, '保存配置') })
          } else if (payload.ok === false) {
            setStatus({ kind: 'err', text: String(payload.error ?? '保存失败') })
          } else {
            if (payload.config !== undefined) {
              runtime.config = payload.config
              setConfig(payload.config)
            }
            /* 默认「已保存」。但有些动作自己已经给了一句更有信息量的提示
             * （例如「已恢复 DSH 原本的背景」），保存成功的这句就会把它盖掉 ——
             * 用户看到的是一句毫无解释的「已保存」。所以允许指认。 */
            setStatus({ kind: 'ok', text: okText ?? '已保存' })
          }
        } catch (error) {
          setStatus({ kind: 'err', text: `保存失败：${String(error?.message ?? error)}` })
        }
      }, [runtime])

      /**
       * 防抖提交一份局部配置（350ms）。
       *
       * ⚠️ 只用于「写完不需要立刻读宿主」的场景。如果下一步是 `reloadFolders()`
       * 这类**立刻去读宿主**的动作，必须改用 `flushConfig()` —— 否则读的时候
       * 这笔写入还在定时器里没发出去，宿主返回的还是旧数据。
       * （用户报障「移除目录之后候选墙还留着那个目录的图」就是这个时序造成的：
       * `reloadFolders()` 抢在写入之前跑了。）
       */
      const persist = React.useCallback((patch, options) => {
        /* 哨兵：上一次排队的写入还没发出去就被这一次取消了 —— 那一笔**会丢**。
         *
         * 这个错误模式在本项目里犯过两次，两次都是安静的功能失效：
         *   · 0.2.1：`applyWallpaper` 三次 `patch()`，只有最后一次发出去，
         *     `source`/`current` 被吞，选图一刷新就没了；
         *   · 0.2.2：`removeFolder` 的「移除目录」被「复原背景」那一笔吞掉，
         *     用户看到的是「打开就强制加载 Pictures，而且无法移除」。
         * 两次的修法都是「合并成一次提交」。这条日志让第三次一出现就能看见。 */
        if (saveTimer.current !== null && pendingPatch.current !== null) {
          console.warn(
            '[theme-studio] 同一帧内有两笔配置写入，前一笔已被取消（会丢）：',
            JSON.stringify(pendingPatch.current), '→', JSON.stringify(patch),
          )
        }
        pendingPatch.current = patch
        if (saveTimer.current !== null) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => {
          saveTimer.current = null
          pendingPatch.current = null
          putConfig(patch, options?.okText)
        }, 350)
      }, [putConfig])

      /**
       * 立刻把配置写下去（取消防抖），并等它写完。
       *
       * 存在两个理由：
       *   1. **时序**：`reloadFolders()` / 重新扫盘这类动作紧跟着读宿主，
       *      必须等写入真的落地（否则读到旧数据，界面短暂不一致）；
       *   2. **不丢**：比「排队一笔、再排队另一笔」安全 —— 后一笔会取消前一笔。
       *
       * 发的是 `latest.current`（**整份**配置，含刚 `patch` 进去的改动）。
       * 这也是刻意的：一笔带全量，就不存在「哪一笔被谁取消」的问题了。
       * @param okText - 保存成功时的提示文案。
       * @returns 写入完成的 Promise。
       */
      const flushConfig = React.useCallback((okText) => {
        if (saveTimer.current !== null) {
          clearTimeout(saveTimer.current)
          saveTimer.current = null
        }
        const wasPending = pendingPatch.current !== null
        pendingPatch.current = null
        // 没有任何待写内容时不要白发一次请求。
        if (!wasPending) return Promise.resolve()
        /* ⚠️ 发的是 `runtime.config`，**不是** `latest.current`。
         *
         * `latest` 是在渲染期赋值的 ref，而 `runtime.patch()` 里的 `emit()` →
         * `setConfig()` 是异步的：那一刻**渲染还没发生**，ref 里还是改动前的旧快照。
         * 用它当载荷等于「把旧配置写回宿主」，正好抵消掉刚做的修改 ——
         * 实测现象：`removeFolder` 明明把目录删了，PUT 出去的却还是两个目录，
         * 界面上那行也纹丝不动（用户报的「无法移除」就是同一个东西在作怪）。
         * `runtime.config` 是 `patch()` 同步更新的权威值，永远是最新的。 */
        return putConfig(runtime.config, okText)
      }, [putConfig, runtime])

      /**
       * 由形如 'glass.input.blur' 的路径生成局部配置对象，供宿主合并。
       * @param path - 点分路径。
       * @param value - 值。
       * @returns 嵌套的局部对象。
       */
      const partialOf = (path, value) => path.split('.').reduceRight((acc, key) => ({ [key]: acc }), value)

      /** 改一个字段：立即生效 + 落盘。 */
      const patch = React.useCallback(
        (path, value) => {
          const next = runtime.patch(path, value)
          setConfig(next)
          persist(partialOf(path, value))
        },
        [persist, runtime],
      )

      /**
       * 重新扫描目录。
       *
       * 顺序很重要：宿主扫出来什么就是什么（0.2.0 起不再有 hidden 过滤），
       * 所以必须在拿到响应之后再用它刷新 runtime 的候选池 —— `refreshWallpapers()`
       * 内部会重新请求 /api/folders，如果先刷新再 setState，两边就会不同步。
       *
       * ⚠️ 关闸/开闸这两句不能省：`setFolders` 会先落地，而 `gallery` 要等
       * `await refreshWallpapers()` 之后才 set —— 中间那一次渲染里
       * `folders.length > 0` 与 `gallery.length === 0` **同时成立**，
       * 足以让「候选空了就复原背景」误触发（第二版就是这么坏的：背景在页面刚打开时被撤掉）。
       * 所以刷新期间显式 `setScanned(false)`，扫完再开。
       */
      const reloadFolders = React.useCallback(async () => {
        try {
          setScanned(false)
          const response = await fetch(`${API}/folders`, { cache: 'no-store' })
          const result = await readJsonResponse(response)
          if (result.body === null) {
            setScanned(true)
            setStatus({ kind: 'err', text: describeHostFailure(result, '扫描目录') })
            return
          }
          const groups = result.body.groups ?? []
          setFolders(groups)

          /* 「重新扫描」的语义就是**从头看一遍磁盘**，所以本次会话里被 ✕ 掉的
           * 文件夹来源候选一并复位 —— 否则按钮点下去候选数纹丝不动，看起来像坏了
           * （第一版就是这样：removed 集合没清，探针实测「重新扫描后它回来了=false」）。 */
          setRemoved(new Set())
          await runtime.refreshWallpapers()
          setGallery(runtime.wallpapers.slice(0, 400))
          setScanned(true)
        } catch (error) {
          // 扫描失败也要放行闸门，否则「候选空」那句话永远说不出口。
          setScanned(true)
          setStatus({ kind: 'err', text: `扫描失败：${String(error?.message ?? error)}` })
        }
      }, [runtime])

      React.useEffect(() => {
        if (runtime === undefined) return undefined
        const off = runtime.subscribe((next) => setConfig(next))
        reloadFolders()
        return off
      }, [reloadFolders, runtime])

      /**
       * 「上传来源」的那些候选路径。
       *
       * 宿主在 `groups[]` 里给上传目录那一组打了 `uploads: true`（它才知道自己的上传目录在哪），
       * 这里只是把它读出来 —— 客户端**不复制**那个目录的布局知识。
       * 用途只有两个：区分 aria-label 的语义、以及决定 ✕ 是否走真删。
       * @type {Set<string>}
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

      /* 这三个常量要**尽早**取出来：下面好几个 useEffect / 回调都用它们。
       * 之前它们定义在 reloadFolders 之后，新增的「候选空了就复原背景」那个 effect
       * 引用 `wallpaper` 时就会撞上 TDZ（`const` 提升但不初始化）。 */
      const wallpaper = config.wallpaper ?? {}
      const glass = config.glass ?? {}
      const accent = config.accent ?? { enabled: false, rgb: [65, 118, 230] }

      /**
       * 恢复 DSH 原本的背景（用户报障后新增）：把壁纸接管整个撤掉。
       *
       * 现象：候选图删光之后，背景仍然是之前选中的那张。「删掉候选」与「撤掉背景层」
       * 原本是两件互不相干的事 —— 前者只动候选列表，`wallpaper.source` 还是 `'folder'`、
       * `fixed` 还指着那张（已被删掉的）图，于是背景层继续按它铺。
       *
       * 完整复位，而不是只清 `fixed`：
       *   - `source: 'none'` —— 插件不再接管背景，DSH 原生背景回来；
       *   - `current` / `fixed` 清空 —— 不留悬空路径；
       *   - `enabled` **不动** —— 主题工作室的总开关是用户的选择，不该被这件事改掉；
       *   - 玻璃与主题色也**不动** —— 它们不依赖壁纸。
       *
       * ⚠️ 写成**函数声明**（不是 `const` 箭头函数）是刻意的：它要能被下面的
       * `removeFolder`（删掉最后一个登记目录时）直接调用，而那个动作定义在前面。
       *
       * 注意它**不负责**写 `wallpaper.folders`：「移除最后一个目录」那次调用里，
       * 目录清空与背景复位必须**一次提交**，那一笔由 `removeFolder` 自己发
       * （见那里的注释：分两次 `persist` 会互相取消，用户报障「无法移除」就是这么来的）。
       * @param options - `{ okText }`：提示文案。
       */
      function restoreOriginalBackground(options) {
        const next = runtime.patch('wallpaper.source', 'none')
        setConfig(next)
        const text = options?.okText
          ?? '候选里已经没有图片了，已恢复 DSH 原本的背景（原来的壁纸设置保留在配置里，重新登记目录即可再用）'
        setStatus({ kind: 'ok', text })
        // 把同一句话交给保存回执，否则它会被一句「已保存」盖掉。
        persist({ wallpaper: { source: 'none', current: '', fixed: '' } }, { okText: text })
      }

      /* ── 壁纸相关的动作 ── */

      const applyWallpaper = (value) => {
        if (runtime !== undefined) {
          // 只顶这一次：apply() 会取走它并清空，之后以配置里的 fixed 为准。
          runtime.pendingWallpaper = value
          runtime.apply(latest.current).then((result) => {
            if (result?.ok === false) {
              setStatus({ kind: 'err', text: `壁纸加载失败：${result.reason}。若图片过大，请换一张或先压缩。` })
            }
          })
        }
        /* 选一张图同时也**声明了来源**：远程链接 → `url`，本地路径 → `folder`。
         * 不能只改 current/fixed —— 候选被删空之后 `source` 会停在 `none`，
         * 那时再点图就只改了 current/fixed，背景层根本不会挂载，看起来像「点了没反应」。
         *
         * ⚠️ 这三项必须**一次提交**，不能写成三次 `patch()`。
         * 每次 `patch()` 都走同一个防抖定时器（新的一次会 `clearTimeout` 掉前一次），
         * 于是只有最后一次会被发出去 —— 实测日志里只出现了
         * `{"wallpaper":{"fixed":"…"}}`，`source` 与 `current` 全被吞掉，
         * 界面上看起来「选好了」，一刷新就回到 `none`。 */
        const nextSource = /^https?:/i.test(value) ? 'url' : 'folder'
        patch('wallpaper', { ...(latest.current.wallpaper ?? {}), source: nextSource, current: value, fixed: value })
      }

      const addFolder = async () => {
        const value = folderDraft.trim()
        if (value.length === 0) return
        const list = [...(wallpaper.folders ?? [])]
        if (!list.includes(value)) list.push(value)
        setFolderDraft('')
        const next = runtime.patch('wallpaper.folders', list)
        setConfig(next)
        persist({ wallpaper: { folders: list } })
        // 顺序同 removeFolder：先让写入落地，再扫盘，否则扫到的是宿主的旧状态。
        await flushConfig()
        await reloadFolders()
      }

      const removeFolder = async (value) => {
        const list = (wallpaper.folders ?? []).filter((item) => item !== value)
        const next = runtime.patch('wallpaper.folders', list)
        setConfig(next)
        /* 删掉**最后一个**登记目录时，「移除目录」与「复原背景」必须**一次提交**。
         *
         * 用户报障：「打开后会强制加载 C:\Users\<用户名>\Pictures，并且无法移除」——
         * 根因就是这两笔写入了两次 `persist`，而 `persist` 带防抖、第二次调用会
         * 取消第一次，于是**移除目录那一笔被吞掉**：界面上没了，宿主还留着，
         * 刷新就回来。（与 0.2.1 修的 `applyWallpaper` 是同一个错误模式。） */
        if (list.length === 0) {
          runtime.patch('wallpaper.source', 'none')
          const text = `已移除最后一个登记目录（${baseName(value)}），并恢复 DSH 原本的背景`
          setStatus({ kind: 'ok', text })
          persist({ wallpaper: { source: 'none', current: '', fixed: '', folders: [] } }, { okText: text })
        } else {
          persist({ wallpaper: { folders: list } })
        }
        /* ⚠️ 顺序：先把写入**真正发出去**，再重新扫盘。
         * 写成「排队写入 → 立刻 reloadFolders()」会读到宿主的旧数据，
         * 界面上那个目录的图还留着（探针实测：移除后候选仍是 2 张而不是 1 张）。 */
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
            setStatus({ kind: 'err', text: describeHostFailure(result, '浏览目录') })
            return
          }
          setBrowse(result.body)
          if (result.body.ok === false) setStatus({ kind: 'err', text: String(result.body.error) })
        } catch (error) {
          setStatus({ kind: 'err', text: `浏览失败：${String(error?.message ?? error)}` })
        }
      }

      const uploadFile = async (file) => {
        if (!file) return
        setStatus({ kind: 'ok', text: `上传中：${file.name}` })
        try {
          const result = await readJsonResponse(await fetch(`${API}/upload?name=${encodeURIComponent(file.name)}`, {
            method: 'POST',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file,
          }))
          const payload = result.body
          if (payload === null) {
            setStatus({ kind: 'err', text: describeHostFailure(result, '上传') })
            return
          }
          if (payload.ok === false) {
            setStatus({ kind: 'err', text: String(payload.error) })
            return
          }
          // 上传后的图片落在 $DSH_HOME/theme-studio/wallpapers，以本地路径形式使用。
          setStatus({ kind: 'ok', text: '上传完成' })
          applyWallpaper(payload.path)
          // 同上：applyWallpaper 的写入要先落地，再扫盘（它会看到新上传的那张）。
          await flushConfig()
          await reloadFolders()
        } catch (error) {
          setStatus({ kind: 'err', text: `上传失败：${String(error?.message ?? error)}` })
        }
      }

      /* ── 从候选墙删除 ──
       *
       * ⚠️ 0.2.0 重写。原先「文件夹来源」是写进 `wallpaper.hidden` 名单（不删文件、
       * 可以一键恢复）。用户明确不要那个恢复功能，而名单一旦没有恢复入口就是**静默黑洞**：
       * 图片在磁盘上、路径在配置里、界面永远看不到，重新扫描也救不回来。整套机制已拆掉。
       *
       * 现在按**谁的文件**分三种语义：
       *   1. 文件夹来源 —— 用户自己的图库，**磁盘上的原文件绝对不动**。
       *      ✕ 只把它从**当前这次会话**的候选墙拿掉（前端 state，不落盘）；刷新页面即复原。
       *   2. 上传来源 —— 插件自己复制到 `wallpapers/` 的副本，**真删**（删掉磁盘上那个文件）。
       *   3. URL 来源 —— 删掉 `url-cache/` 里的本地副本 + 从 `urls` 列表移除；远端原图不动。
       *
       * 也就是说「真正删除」落在 2 与 3：会动配置文件与本地缓存；
       * 而 1 之所以不落盘，是因为那是**你的文件**，不是插件的缓存。
       * ────────────────────────────────────────────────────────────── */

      /** 当前壁纸就是被删的那张时，顺手清空选择，避免指向一个不在候选里的值。 */
      const clearIfActive = (value) => {
        if ((latest.current.wallpaper?.fixed ?? '') !== value) return
        const next = runtime.patch('wallpaper.fixed', '')
        setConfig(next)
        persist({ wallpaper: { fixed: '', current: '' } })
      }

      /**
       * 已经没有任何可选壁纸了 → 恢复 DSH 的原背景（用户报障后新增）。
       *
       * 判据是 `visibleCandidates`（候选墙**当前真正显示**的东西），不是 `gallery`：
       * 后者是扫描结果原样，点 ✕ 只把路径记进 `removed`，过滤发生在渲染时 ——
       * 拿它判空永远不会成立（实测埋点：删掉两张后 `gallery=2, removed.size=2`）。
       *
       * `scanned` 闸门不能省：`gallery` 的初始值是 `[]`，页面刚打开、首次扫描还没回来时
       * 它也判空，会把用户刚设好的背景在开屏瞬间撤掉。
       *
       * ⚠️ **不要**再加「还有登记目录」这类条件。第一版加了 `folders.length > 0`，
       * 结果「删掉最后一条登记目录」这条路径（`removeFolder`）永远进不来 ——
       * 目录一删就变成 0，条件当场失效，背景层一直挂着。那条路径现在由
       * `removeFolder` 自己显式调 `restoreOriginalBackground()`。
       */
      const visibleCandidates = React.useMemo(
        () => gallery.filter((item) => !removed.has(item)),
        [gallery, removed],
      )

      const nothingToShow = scanned && visibleCandidates.length === 0 && wallpaper.source === 'folder'

      React.useEffect(() => {
        if (!nothingToShow) return
        restoreOriginalBackground()
        /* ⚠️ 依赖里必须是 `nothingToShow` 这个**布尔判据本身**，不能写成长度之类的派生量。
         * 写成 `gallery.length` 那版实测一次都没进过 —— React 只在**依赖值变化**时才跑 effect。 */
      }, [nothingToShow])

      /** 文件名（给提示文案用）。 */
      const baseName = (value) => value.split(/[\\/]/).pop()

      /** 一批资源的删除结果汇总成一句提示。 */
      const deleteStatus = (label, removedFiles) => {
        const text = removedFiles > 0
          ? `已删除 ${label}（本地文件 ${removedFiles} 个）`
          : `已从候选移除 ${label}`
        setStatus({ kind: 'ok', text })
      }

      /** ① 文件夹来源：只从当前会话的候选墙拿掉，绝不碰磁盘上的原图。 */
      const removeFolderCandidate = async (value) => {
        clearIfActive(value)
        setRemoved((previous) => new Set(previous).add(value))
        // 提示里必须说清两条出路：这是一种「视图层」的移除，不是删除。
        setStatus({ kind: 'ok', text: `已从候选移除：${baseName(value)}（你的原图未做任何改动；点「重新扫描」或刷新页面即复原）` })
      }

      /**
       * 删掉插件自己复制到 `wallpapers/` 的那份副本（真删）。
       *
       * ⚠️ 归属判定在**宿主**，这里不猜目录名 —— 客户端去判断「这是不是上传目录」
       * 等于把宿主的内部布局复制一份到前端，改一处就会错一处（第一版就写成了
       * 手拼 `theme-studio\wallpapers` 字符串，既丑又脆）。宿主返回
       * `removed: false` 就表示「这不是插件产生的副本」，交给调用方按用户文件处理。
       * @param value - 候选的绝对路径。
       * @returns 宿主是否真的删掉了文件。
       */
      const deleteUploadCandidate = async (value) => {
        try {
          const result = await readJsonResponse(await fetch(`${API}/delete-upload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: value }),
          }))
          const payload = result.body
          /* 403 = 不在上传目录里（用户自己的文件），不是错误，交给调用方降级处理。
           * ⚠️ 这一条必须在 payload 判空**之前**：宿主不认这个端点时（旧宿主）
           * 响应体是空的，`payload === null` 会先命中，于是「降级删除」被误判成故障。 */
          if (result.status === 403) return false
          if (payload === null) {
            setStatus({ kind: 'err', text: describeHostFailure(result, '删除') })
            return true
          }
          if (payload.ok === false) {
            setStatus({ kind: 'err', text: String(payload.error) })
            return true
          }
          if (payload?.removed !== true) return false
          clearIfActive(value)
          await reloadFolders()
          deleteStatus(`上传的图：${baseName(value)}`, Number(payload?.removedFiles ?? 0))
          return true
        } catch (error) {
          setStatus({ kind: 'err', text: `删除失败：${String(error?.message ?? error)}` })
          return true
        }
      }

      /** ③ URL 来源：删掉 url-cache 里的本地副本，并从链接列表移除。 */
      const forgetUrl = async (url) => {
        try {
          const result = await readJsonResponse(await fetch(`${API}/forget-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
          }))
          const payload = result.body
          if (payload === null) {
            setStatus({ kind: 'err', text: describeHostFailure(result, '删除缓存') })
            return
          }
          if (payload.ok === false) {
            setStatus({ kind: 'err', text: String(payload.error) })
            return
          }
          const remaining = payload.urls ?? (latest.current.wallpaper?.urls ?? []).filter((item) => item !== url)
          const next = runtime.patch('wallpaper.urls', remaining)
          setConfig(next)
          clearIfActive(url)
          setStatus({
            kind: 'ok',
            text: `已删除本地缓存（${payload?.removedCacheFiles ?? 0} 个文件）并从候选移除；远端原图未受影响`,
          })
        } catch (error) {
          setStatus({ kind: 'err', text: `删除失败：${String(error?.message ?? error)}` })
        }
      }

      /**
       * 候选墙上的 ✕ 总入口。
       *
       * 只区分一件事：**是不是远程 URL**。URL 走 `/api/forget-url`（删 url-cache 副本）；
       * 其余一律先问宿主 `/api/delete-upload`「这是不是插件自己上传的副本」——
       * 是就真删文件，不是（403 / removed:false）就退化成「只从本次会话的候选墙移除」。
       * 归属判定留在宿主，客户端不复制它的目录知识。
       * @param value - 候选的绝对路径或 URL。
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
       * 重置整份配置：把插件造成的所有效果退回出厂。
       *
       * 与「一键关闭并复原」的区别：
       *   · 关闭：只把 `enabled` 置 false，效果撤了但配置原样留着，再打开全回来；
       *   · 重置：调宿主 `/api/reset`，**整份配置退回 defaultConfig()** ——
       *     壁纸、玻璃、主题色、登记目录全部清空，等于从没配置过。
       *
       * 重置后必须**用宿主返回的那份出厂配置**覆盖运行时与本地缓存，
       * 否则界面上还留着旧值、`localStorage` 里也还是旧的（刷新会闪一下旧主题）。
       */
      const resetConfig = async () => {
        try {
          /* ⚠️ 不能直接 `response.json()`：宿主半侧的路由**只在启动时注册**，
           * 「新前端 + 旧宿主」时会打到不存在的路径、拿到空响应体，
           * `response.json()` 于是抛出
           * `Failed to execute 'json' on 'Response': Unexpected end of JSON input`。
           * 用 readJsonResponse 统一兜住（全文件 8 处 fetch 都走它）。 */
          const result = await readJsonResponse(await fetch(`${API}/reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ purgeFiles: false }),
          }))
          if (result.body === null || result.body.ok === false) {
            setStatus({ kind: 'err', text: describeHostFailure(result, '重置') })
            return
          }
          const fresh = result.body.config ?? defaultConfig()
          runtime.config = fresh
          runtime.resolved = ''
          setConfig(fresh)
          setDiag(null)
          setAccentDraft(toHex(fresh.accent?.rgb ?? [65, 118, 230]))
          // 立刻把出厂配置应用上去：撤掉背景层、清掉玻璃与主题色。
          runtime.apply(fresh)
          await reloadFolders()
          setStatus({ kind: 'ok', text: '已重置全部配置' })
        } catch (error) {
          setStatus({ kind: 'err', text: `重置失败：${String(error?.message ?? error)}` })
        }
      }

      /**
       * **仅**清理本地缓存：删掉插件自己产生的两种副本，不动配置。
       *
       *   · `$DSH_HOME/theme-studio/wallpapers/` —— 上传时插件复制进来的副本；
       *   · `url-cache/` —— 远程图的本地缓存。
       *
       * 两者都只是副本：上传的原图在用户自己选的位置，远程原图在对端服务器上，
       * 用户登记目录里的图片**从来不在清理范围内**。所以这个动作是安全的，
       * 不需要做成危险操作。
       *
       * 复用宿主的 `/api/reset`（`purgeFiles: true` 会顺带把配置也写回出厂）——
       * 但**这里要的是「只清缓存」**，所以清完之后必须把当前配置**原样写回去**，
       * 否则用户点一下「清理本地缓存」会意外丢掉全部设置。这一条是刻意的，
       * 别图省事直接调那个端点就完事。
       */
      const purgeCache = async () => {
        try {
          const before = runtime.config
          const result = await readJsonResponse(await fetch(`${API}/reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ purgeFiles: true }),
          }))
          if (result.body === null || result.body.ok === false) {
            setStatus({ kind: 'err', text: describeHostFailure(result, '清理缓存') })
            return
          }
          const removed = Number(result.body.removedFiles ?? 0)
          /* 把配置写回去。注意要**等它落地**再扫盘：上传副本已被删掉，
           * 重新扫描后候选墙里那些副本才会消失 —— 顺序反了会先扫到旧列表。 */
          await putConfig(before)
          await reloadFolders()
          setStatus({ kind: 'ok', text: `已清理本地缓存（${removed} 个文件）` })
        } catch (error) {
          setStatus({ kind: 'err', text: `清理缓存失败：${String(error?.message ?? error)}` })
        }
      }

      /* ── 主题色动作 ── */

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

      /* ── 渲染 ── */

      const tabs = [
        { id: 'wallpaper', label: tr('壁纸') },
        { id: 'glass', label: tr('毛玻璃') },
        { id: 'accent', label: tr('主题色') },
        { id: 'misc', label: tr('其他') },
      ]

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
          { className: 'ds-ts-tabs' },
          tabs.map((item) =>
            h(
              'button',
              { key: item.id, type: 'button', 'data-active': tab === item.id, onClick: () => setTab(item.id) },
              item.label,
            ),
          ),
        ),

        /* ── 壁纸 ── */
        tab === 'wallpaper'
          ? h(
              React.Fragment,
              null,
              // 壁纸加载失败是静默的：不提示的话用户只会看到灰底，以为插件坏了。
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
                    const next = runtime.patch('wallpaper.source', value)
                    setConfig(next)
                    persist({ wallpaper: { source: value } })
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
                        (browse.dirs ?? []).slice(0, 60).map((dir) =>
                          h(
                            'li',
                            { key: dir.path },
                            h('span', { className: 'ds-ts-mono' }, dir.name),
                            h('button', { type: 'button', className: 'ds-ts-btn', 'data-variant': 'ghost', onClick: () => browseTo(dir.path) }, tr('进入')),
                          ),
                        ),
                      ),
                    )
                  : null,
                (wallpaper.folders ?? []).length > 0
                  ? h(
                      'ul',
                      { className: 'ds-ts-list' },
                      (wallpaper.folders ?? []).map((folder) =>
                        h(
                          'li',
                          { key: folder },
                          h('span', { className: 'ds-ts-mono' }, folder),
                          h(
                            'button',
                            { type: 'button', className: 'ds-ts-btn', 'data-variant': 'danger', onClick: () => removeFolder(folder) },
                            tr('移除'),
                          ),
                        ),
                      ),
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
                              // 与候选墙上的 ✕ 走同一条路径：删缓存 + 移出列表。
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
                    onChange: (event) => uploadFile(event.target.files?.[0]),
                  }),
                ),
              ),
              h(
                Card,
                {
                  title: tr('壁纸候选'),
                  // 0.2.0 起没有「已移除 N 张 / 恢复已移除」这一层：宿主不再过滤候选，
                  // 这里显示的就是扫描结果原样。文件夹来源的 ✕ 只影响本次会话视图，
                  // 所以数字必须报**可见数**，否则删掉图之后数字纹丝不动，看起来像坏了。
                  sub: `${visibleCandidates.length} ${tr('张')}`,
                  right: h(
                    'div',
                    { className: 'ds-ts-foot' },
                    h('button', { type: 'button', className: 'ds-ts-btn', onClick: reloadFolders }, tr('重新扫描')),
                  ),
                },
                visibleCandidates.length === 0
                  ? h('div', { className: 'ds-ts-hint' }, tr('登记文件夹并扫描后，这里会列出候选图片。'))
                  : h(
                      'div',
                      { className: 'ds-ts-grid' },
                      visibleCandidates.map((item) =>
                        h(Thumb, {
                          key: item,
                          src: `${API}/image?path=${encodeURIComponent(item)}`,
                          name: item.split(/[\\/]/).pop(),
                          active: wallpaper.fixed === item,
                          kind: 'folder',
                          /* aria-label 按**来源**给出真实语义（悬停不显示任何文字）：
                           * 上传的是插件自己的副本（真删），登记目录里的是用户的原图（只移出视图）。 */
                          label: isUploadPath(item) ? tr('删除这张上传的图') : tr('从候选墙移除'),
                          onPick: () => applyWallpaper(item),
                          onRemove: () => removeCandidate(item),
                        }),
                        ),
                    ),
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
                    onClick: () => {
                      const next = runtime.rotateWallpaper()
                      applyWallpaper(next)
                    },
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

        /* ── 毛玻璃 ── */
        tab === 'glass'
          ? h(
              React.Fragment,
              null,
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
                return h(
                  Card,
                  {
                    key: region.key,
                    title: tr(region.zh, region.en),
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

        /* ── 主题色 ── */
        tab === 'accent'
          ? h(
              React.Fragment,
              null,
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
                      tr(preset.zh, preset.en),
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

        /* ── 其他 ── */
        tab === 'misc'
          ? h(
              React.Fragment,
              null,
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
                    onClick: () => {
                      runtime.resolved = runtime.pickWallpaper()
                      runtime.apply(latest.current)
                    },
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

        status !== null
          ? h('div', { className: status.kind === 'err' ? 'ds-ts-err' : status.kind === 'warn' ? 'ds-ts-warn' : 'ds-ts-ok' }, status.text)
          : null,
      )
    }

    /** 运行时在面板里靠 context 传递，避免污染 slot 的 props 契约。 */
    const RUNTIME_CONTEXT = React.createContext(undefined)

    /* ═══════════════════════════════════════════════════════════════════
     * 插件入口
     * ═══════════════════════════════════════════════════════════════════ */

    /** 需要的能力：设置页 slot、翻译。 */
    const inject = ['slots', 'locale']

    /**
     * 客户端插件主体。
     * @param ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      const runtime = new ThemeRuntime()

      ctx.effect(() => ctx.locale.register(SETTINGS_NS, {
        zh: { nav: '主题工作室' },
        en: { nav: 'Theme Studio' },
      }), 'dsh-theme-studio: settings dictionary')

      // 注册设置页的一个顶级分区。
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'theme-studio',
            order: 40,
            label: () => '主题工作室',
            locale: SETTINGS_NS,
            inject: () => ({}),
          },
          (props) => h(RUNTIME_CONTEXT.Provider, { value: runtime }, h(ThemeStudioSection, props)),
        ),
      )

      // 启动即生效：配置来自宿主，先渲染再等网络，避免白屏期间没有主题。
      runtime.load().then(() => {
        // 非 loopback（远程访问）时宿主配置可能不可达，保持默认值即可。
      })

      // 本地缓存：让刷新后的首帧立刻带上主题，减少闪烁；随后被宿主配置覆盖。
      try {
        const cached = window.localStorage.getItem(CACHE_KEY)
        if (cached !== null) {
          const parsed = JSON.parse(cached)
          runtime.apply(merge(defaultConfig(), parsed))
        }
      } catch {
        /* 缓存不可用时忽略 */
      }
      runtime.subscribe((config) => {
        try {
          window.localStorage.setItem(CACHE_KEY, JSON.stringify(config))
        } catch {
          /* 隐私模式下写入可能失败 */
        }
      })

      // 深色态切换由 CSS 的 :has(body[data-ds-dark-theme]) 负责配色，
      // 这里只在主题属性真正变化时重算一次变量，避免无谓的样式重写。
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

    exports.name = 'dsh-theme-studio'
    exports.inject = inject
    exports.apply = apply
    exports.ThemeRuntime = ThemeRuntime
    exports.buildCss = buildCss
    exports.defaultConfig = defaultConfig
    exports.REGIONS = REGIONS
    exports.REGION_SELECTORS = REGION_SELECTORS
    exports.diagnose = diagnose
    /* 导出这两个响应处理 helper 供单测：本条是用户报障的回归点 ——
     * 「新前端 + 旧宿主」时会拿到**空响应体**，直接 `response.json()` 会抛出
     * `Failed to execute 'json' on 'Response': Unexpected end of JSON input`。
     * 断言它们能把这种情况翻译成「要重启 dsh web」。 */
    exports.readJsonResponse = readJsonResponse
    exports.describeHostFailure = describeHostFailure
    // 导出自检报告组件：给冒烟测试直接渲染，验证「长选择器不再被省略号截断」
    // 与「条件分区 0 命中不标红」这两点（前者是一次真实故障的回归点）。
    exports.DiagReport = DiagReport
    // 导出缩略图组件：给冒烟测试直接调用，验证「选图」与「删除」是并列兄弟、
    // 点 ✕ 不会连带应用壁纸（这是一次真实事故的回归点）。
    exports.Thumb = Thumb

    return module.exports
  },
})
