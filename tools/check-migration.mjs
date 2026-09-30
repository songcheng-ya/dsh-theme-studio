/**
 * 配置迁移校验：确认「出厂带效果」时代的旧配置会被一次性重置为中立值，
 * 同时**不动用户真正的选择**（主题色、登记的目录、当前壁纸、适配方式、描边高光）。
 *
 * 用法：node tools/check-migration.mjs
 *
 * 三类「没人读的配置」都要被清掉，判定方式各不相同：
 *   1. 废弃**分区**（`sidebar` 0.1.9、`topbar` 0.1.12）—— 整个键删掉；
 *   2. 废弃**参数**（`glass.*.saturation` 0.1.11）—— 分区留着，字段删掉；
 *   3. 废弃**顶层键**（`perf` 0.1.11）—— 直接删掉。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const host = await import(`file://${path.join(HERE, '..', 'lib', 'index.js').replace(/\\/g, '/')}`)

const check = (label, ok, detail) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) process.exitCode = 1
}

/** 当前仍然存在的分区（`chat` 0.1.13 / `panel` 0.1.14 删；
 *  `sidebar` + `topbar` 0.1.15 合并重写为 `bars`）。 */
const REGIONS = ['bars', 'input', 'bubble', 'menu']
/** 已经整体删除的分区：旧配置里会留着，必须被剔除。 */
const RETIRED_REGIONS = ['sidebar', 'topbar', 'chat', 'panel']
/** 用来做「用户自己调过的活分区」样本，避开任何废弃键。 */
const SAMPLE = 'input'

/** 一份「旧版本」配置：出厂默认带效果的那一版，外加用户自己做过的一些选择。 */
const legacy = {
  enabled: true,
  scope: 'root',
  accent: { enabled: true, rgb: [232, 106, 148], preset: 'sakura' },
  wallpaper: {
    source: 'folder',
    folders: ['D:\\壁纸库'],
    current: 'D:\\壁纸库\\夜色.jpg',
    fixed: 'D:\\壁纸库\\夜色.jpg',
    fit: 'contain',
    position: 'top',
    blur: 0,
    brightness: 1,
    saturation: 1,
    dim: 0.18,
    vignette: 0.25,
    noise: 0.04,
  },
  glass: {
    // 四个已知废弃分区：老配置里一定会有它们，必须被剔除（下面单独断言）。
    sidebar: { enabled: true, opacity: 0.55, blur: 18, saturation: 1.3 },
    topbar: { enabled: true, opacity: 0.55, blur: 18, saturation: 1.3 },
    chat: { enabled: true, opacity: 0.5, blur: 16, saturation: 1.25 },
    panel: { enabled: true, opacity: 0.62, blur: 22, saturation: 1.3 },
    input: { enabled: true, opacity: 0.58, blur: 20, saturation: 1.35 },
    bubble: { enabled: true, opacity: 0.6, blur: 14, saturation: 1.2 },
    panel: { enabled: true, opacity: 0.62, blur: 22, saturation: 1.3 },
    menu: { enabled: true, opacity: 0.68, blur: 24, saturation: 1.35 },
    border: 0.4,
    highlight: 0.7,
  },
  perf: 'low',
}

const fresh = host.defaultConfig()
const migrated = host.migrateConfig(legacy)

check(`版本升级到 ${fresh.version}`, migrated.version === fresh.version, String(migrated.version))

for (const key of REGIONS) {
  const region = migrated.glass[key]
  check(
    `分区 ${key} 重置为中立（opacity=1, blur=0）`,
    region.opacity === 1 && region.blur === 0 && !('saturation' in region),
    JSON.stringify(region),
  )
}

check(
  '壁纸效果项全部归零（dim / vignette / noise）',
  migrated.wallpaper.dim === 0 && migrated.wallpaper.vignette === 0 && migrated.wallpaper.noise === 0,
  `dim=${migrated.wallpaper.dim} vignette=${migrated.wallpaper.vignette} noise=${migrated.wallpaper.noise}`,
)

/* 用户真正的选择必须原样保留 */
check('保留主题色与开关', migrated.accent.enabled === true && JSON.stringify(migrated.accent.rgb) === '[232,106,148]', JSON.stringify(migrated.accent))
check('保留登记的壁纸目录', JSON.stringify(migrated.wallpaper.folders) === JSON.stringify(['D:\\壁纸库']), JSON.stringify(migrated.wallpaper.folders))
check('保留当前壁纸', migrated.wallpaper.fixed === 'D:\\壁纸库\\夜色.jpg', String(migrated.wallpaper.fixed))
check('保留适配方式与对齐', migrated.wallpaper.fit === 'contain' && migrated.wallpaper.position === 'top', `${migrated.wallpaper.fit}/${migrated.wallpaper.position}`)
check('保留描边与高光', migrated.glass.border === 0.4 && migrated.glass.highlight === 0.7, `border=${migrated.glass.border} highlight=${migrated.glass.highlight}`)

/* 幂等：已经迁过的配置不应被再次改写（否则用户每次重启都被清空） */
check('迁移是幂等的', host.migrateConfig(migrated) === migrated)

/* 用户自己调过的中立值不应被「反向」改动 */
const customized = { ...fresh, glass: { ...fresh.glass, [SAMPLE]: { enabled: true, opacity: 0.35, blur: 24 } } }
check('新版本配置不再被迁移', host.migrateConfig(customized) === customized)

/* ── 废弃分区剔除（0.1.9 删 sidebar / 0.1.12 删 topbar） ───────────────
 *
 * 深合并只增键不删键，所以老配置里的 `glass.sidebar` / `glass.topbar` / `glass.chat`
 * 会一直活着。readConfig() 与 writeConfig() 都会调 dropRetiredKeys()，这里直接测这个函数。 */
for (const key of RETIRED_REGIONS) {
  check(`出厂默认 glass 里没有 ${key} 键`, !(key in fresh.glass), Object.keys(fresh.glass).join(','))
  check(`迁移后的旧配置里 ${key} 分区被剔除`, !(key in migrated.glass), Object.keys(migrated.glass).join(','))
}
check(
  '剔除只删废弃键，不碰其他分区与描边高光',
  migrated.glass.input !== undefined && migrated.glass.menu !== undefined &&
    migrated.glass.border === 0.4 && migrated.glass.highlight === 0.7,
  Object.keys(migrated.glass).join(','),
)
/* 关键场景：已经迁到当前版本、但文件里仍留着废弃键的配置（不会再走迁移分支）。 */
const currentWithStale = {
  version: fresh.version,
  glass: {
    ...fresh.glass,
    ...Object.fromEntries(RETIRED_REGIONS.map((key) => [key, { enabled: true, opacity: 0.4, blur: 30 }])),
  },
}
check('当前版本配置不会被迁移改写', host.migrateConfig(currentWithStale) === currentWithStale)
check('hasRetiredKeys 能识别出残留的废弃分区', host.hasRetiredKeys(currentWithStale) === true)
host.dropRetiredKeys(currentWithStale)
check(
  '但读盘时废弃分区照样被剔除',
  RETIRED_REGIONS.every((key) => !(key in currentWithStale.glass)),
  Object.keys(currentWithStale.glass).join(','),
)
/* 幂等 + 容错：没有该键、或结构异常时不得抛错。 */
let dropSafe = true
try {
  host.dropRetiredKeys({ glass: { topbar: {} } })
  host.dropRetiredKeys({})
  host.dropRetiredKeys(null)
  host.dropRetiredKeys({ glass: null })
} catch (error) {
  dropSafe = false
  console.log(`  → ${error.message}`)
}
check('dropRetiredKeys 对缺失/异常结构容错', dropSafe)

/* ── 0.1.11：去掉「每分区饱和度」与「画质档位 perf」 ─────────────────
 *
 * 这两个是**参数**级的废弃，不是分区级的：分区还在，只是字段没了。
 * 同样靠 dropRetiredKeys 清理。 */
check(
  '出厂默认每个分区都只剩 enabled/opacity/blur',
  REGIONS.every((key) => Object.keys(fresh.glass[key]).sort().join(',') === 'blur,enabled,opacity'),
  REGIONS.map((key) => `${key}:${Object.keys(fresh.glass[key]).join('/')}`).join('  '),
)
check(
  '出厂默认不再有 perf 键',
  !('perf' in fresh),
  Object.keys(fresh).join(','),
)
check(
  '迁移后的旧配置里 saturation 被逐个剔除',
  REGIONS.every((key) => !('saturation' in migrated.glass[key])),
  REGIONS.map((key) => `${key}:${JSON.stringify(migrated.glass[key])}`).join('  '),
)
check('迁移后的旧配置里 perf 被剔除', !('perf' in migrated), Object.keys(migrated).join(','))

/* ── 0.2.0：删掉 `wallpaper.hidden`（「已移除候选」名单）────────────────
 *
 * 与上面两批不同的地方：这是**壁纸节**里的键，而且用户选了「被它挡住过的图
 * 全部恢复」，所以除了「键要被物理删除」，还要确认「默认配置里也不再有它」。 */
check('出厂默认的 wallpaper 里没有 hidden 键',
  !('hidden' in fresh.wallpaper), Object.keys(fresh.wallpaper).join(','))
check('迁移后的旧配置里 hidden 被剔除',
  !('hidden' in (migrated.wallpaper ?? {})), Object.keys(migrated.wallpaper ?? {}).join(','))
const currentWithHidden = {
  version: fresh.version,
  wallpaper: { ...fresh.wallpaper, hidden: ['D:\\壁纸库\\a.jpg', 'D:\\壁纸库\\b.png'], folders: ['D:\\壁纸库'] },
}
check('hasRetiredKeys 能识别出残留的 wallpaper.hidden',
  host.hasRetiredKeys(currentWithHidden) === true, Object.keys(currentWithHidden.wallpaper).join(','))
host.dropRetiredKeys(currentWithHidden)
check('读盘清理：hidden 被删除，wallpaper 其余值原样保留',
  !('hidden' in currentWithHidden.wallpaper) &&
    currentWithHidden.wallpaper.folders.length === 1 &&
    currentWithHidden.wallpaper.fit === fresh.wallpaper.fit,
  JSON.stringify(currentWithHidden.wallpaper))
check('wallpaper 缺失或异常结构时不抛错',
  (() => {
    try {
      host.dropRetiredKeys({ wallpaper: null })
      host.dropRetiredKeys({ wallpaper: 'oops' })
      host.dropRetiredKeys({})
      return true
    } catch {
      return false
    }
  })())

/* 当前版本 + 残留参数键：不会再走迁移，但读盘时照样清掉。 */
const currentWithParams = {
  version: fresh.version,
  perf: 'high',
  glass: {
    ...fresh.glass,
    [SAMPLE]: { enabled: true, opacity: 0.4, blur: 30, saturation: 2.2 },
    border: 0.33,
  },
}
check('当前版本配置（带残留参数）不会被迁移改写', host.migrateConfig(currentWithParams) === currentWithParams)
check('hasRetiredKeys 能识别出残留的参数键', host.hasRetiredKeys(currentWithParams) === true)
host.dropRetiredKeys(currentWithParams)
check(
  '读盘清理：saturation 与 perf 都被删除，其余值原样保留',
  !('perf' in currentWithParams) &&
    !('saturation' in currentWithParams.glass[SAMPLE]) &&
    currentWithParams.glass[SAMPLE].opacity === 0.4 &&
    currentWithParams.glass[SAMPLE].blur === 30 &&
    currentWithParams.glass.border === 0.33,
  JSON.stringify(currentWithParams),
)
check(
  'hasRetiredKeys 对干净配置返回 false',
  host.hasRetiredKeys(host.dropRetiredKeys({
    version: fresh.version,
    glass: { ...fresh.glass },
  })) === false,
)
check(
  'hasRetiredKeys 对缺失/异常结构容错',
  (() => {
    try {
      return host.hasRetiredKeys(null) === false &&
        host.hasRetiredKeys({}) === false &&
        host.hasRetiredKeys({ glass: null }) === false &&
        host.hasRetiredKeys({ glass: { border: 0.5 } }) === false
    } catch {
      return false
    }
  })(),
)

/* ── 写路径也必须清理（真实踩过的坑） ───────────────────────────────
 *
 * `deepMerge` 只增键不删键，所以只要**一次** PUT 里带了废弃键，它就会进入
 * configCache 并落盘；之后每次读盘都从缓存返回，readConfig() 里那次清理
 * 再也碰不到它 —— 现象是「配置文件里的 saturation / perf 删不掉，重启才好」。
 * 这个 bug 是被 probe-glass-params.mjs 抓到的：探针把 saturation 写进去之后，
 * 后续连恢复配置都带着它。mergeConfig 就是为此存在的。 */
const polluted = host.mergeConfig(fresh, {
  perf: 'high',
  glass: { [SAMPLE]: { opacity: 0.42, blur: 33, saturation: 2.9 }, topbar: { opacity: 0.5 } },
})
check(
  'mergeConfig（写路径）不会让废弃键进入结果',
  !('perf' in polluted) && !('saturation' in polluted.glass[SAMPLE]) && !('topbar' in polluted.glass) &&
    polluted.glass[SAMPLE].opacity === 0.42 && polluted.glass[SAMPLE].blur === 33,
  JSON.stringify(polluted.glass[SAMPLE]),
)
check(
  'mergeConfig 不会修改传入的 base（就地污染会顺着缓存扩散）',
  !('saturation' in fresh.glass[SAMPLE]) && !('perf' in fresh),
  JSON.stringify(fresh.glass[SAMPLE]),
)
/* 再模拟「缓存已经被污染」的最坏情况：base 自己就带废弃键。 */
const dirtyBase = {
  version: fresh.version,
  perf: 'low',
  glass: { ...fresh.glass, topbar: { enabled: true, opacity: 0.3, blur: 12 }, [SAMPLE]: { enabled: true, opacity: 0.3, blur: 12, saturation: 1.9 } },
}
const rescued = host.mergeConfig(dirtyBase, { glass: { bubble: { opacity: 0.7 }, chat: { opacity: 0.9 } } })
check(
  '即使 base 已被污染，mergeConfig 也会把它洗干净',
  !('perf' in rescued) && !('topbar' in rescued.glass) && !('saturation' in rescued.glass[SAMPLE]) &&
    !('chat' in rescued.glass) &&
    rescued.glass[SAMPLE].opacity === 0.3 && rescued.glass.bubble.opacity === 0.7,
  JSON.stringify(rescued.glass),
)

console.log(process.exitCode === 1 ? '\nMIGRATION FAILED' : '\nMIGRATION OK')
