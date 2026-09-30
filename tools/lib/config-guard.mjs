/**
 * 会改用户配置的运行时探针，共用这套「安全地动配置」的护栏。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 「跑完会还原」这句话被证明是不够的。本仓库的探针在这上面栽过**三次**，
 * 三次都是同一个病根：**把还原当成保证，而不是去断言它**。
 *
 *   1. `probe-background-restore` 第一版：备份在写操作**之后**才取，
 *      于是快照里存的是被自己污染过的状态，「还原」把临时目录写了回去，
 *      用户登记的 `Pictures` 从配置里消失（`probe-bg-latency` 的 B 场景第二次又犯）。
 *   2. 同一族探针用 `put({ wallpaper: { folders: [] } })` 之类**只带局部字段**的补丁
 *      去「清场」，深合并只会覆盖它提到的键 —— 看似无害，但配合下一轮「取快照」
 *      就把用户数据一步步洗掉了。
 *   3. 探针**中途崩溃**（本轮就发生过：模板字符串里的反引号把脚本炸了）时，
 *      根本没有机会跑收尾，临时目录就留在配置里了。
 *
 * ── 这套护栏做什么 ──────────────────────────────────────────────────
 *   · `snapshot()` 在任何写操作之前取，且**只取一次**，存在模块级；
 *   · `assertSane()` 在开始前做体检：如果上一次跑崩了、把**临时目录**留在了
 *     `wallpaper.folders` 里，就当场喊停并告诉人怎么修 —— 绝不「就着脏配置继续跑」；
 *   · `restore()` 把配置恢复成快照（不是合并），并**断言** `wallpaper` 逐字段相等；
 *   · `run()` 用 `try/finally` 保证**崩溃也会还原**（这是 3 号事故的直接对策）。
 *
 * 用法见 `probe-bg-latency.mjs`。
 */

import os from 'node:os'
import path from 'node:path'

const TEMP_PREFIXES = ['dsh-bg-latency-', 'dsh-bg-probe-', 'dsh-diag-', 'dsh-candidate-', 'dsh-hmr-', 'dsh-theme-studio-probe-']

/** 看起来像「探针自己造的临时目录」吗。 */
export function looksTemporary(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  const base = path.basename(value.replace(/[\\/]+$/, ''))
  if (TEMP_PREFIXES.some((prefix) => base.startsWith(prefix))) return true
  // 兜底：位于系统临时目录之下
  const temp = path.resolve(os.tmpdir()).toLowerCase()
  return path.resolve(value).toLowerCase().startsWith(temp)
}

/**
 * 配置托管：取快照、体检、还原、断言。
 * @param options - `{ api, json }`：`api` 是 `/theme-studio/api` 前缀，`json` 是探针自己的请求小工具。
 * @returns 托管对象。
 */
export function configGuard({ api, json }) {
  const put = (patch) => json(`${api}/config`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  })
  const read = async () => (await json(`${api}/config`)).body?.config ?? null

  let snapshot = null

  return {
    /**
     * 取初始快照。**必须在任何写操作之前调用**，且整个进程只调一次。
     * @returns 初始配置。
     */
    async snapshot() {
      if (snapshot !== null) return snapshot
      snapshot = await read()
      if (snapshot === null) throw new Error('拿不到初始配置 —— 拒绝在没有备份的情况下改动用户配置')
      return snapshot
    },

    /** 当前初始快照（可能为 null，表示还没取）。 */
    get current() {
      return snapshot
    },

    /**
     * 体检：拒绝「就着脏配置继续跑」。
     *
     * 触发条件是「登记目录里出现了临时目录」—— 那说明上一次探针跑崩了、没还原干净。
     * 这时候继续跑只会把脏状态一层层叠上去（本项目真的发生过）。
     * @returns 体检结论 `{ ok, reason }`。
     */
    assertSane() {
      const folders = snapshot?.wallpaper?.folders ?? []
      const dirty = folders.filter(looksTemporary)
      if (dirty.length === 0) return { ok: true }
      return {
        ok: false,
        reason:
          `配置里有探针遗留的临时目录：${JSON.stringify(dirty)}\n` +
          '  上一次探针大概是在写回之前崩掉了。请先把 wallpaper.folders 修回你真正的目录，再跑本探针。',
      }
    },

    /**
     * 还原成初始快照，并断言 `wallpaper` 逐字段相等。
     *
     * ⚠️ 不要在这里做任何「聪明」的合并（比如顺手把临时目录并进去或挑出来）——
     * 那正是前几次越滚越坏的原因。快照里有什么就是什么。
     * @returns `{ ok, detail }`。
     */
    async restore() {
      if (snapshot === null) return { ok: false, detail: '没有快照，无法还原' }
      await put({
        enabled: snapshot.enabled,
        glass: snapshot.glass,
        wallpaper: snapshot.wallpaper,
        accent: snapshot.accent,
      }).catch(() => {})
      const after = await read()
      const same = JSON.stringify(after?.wallpaper) === JSON.stringify(snapshot.wallpaper)
      const vacuous = (snapshot.wallpaper?.folders ?? []).length === 0
      return {
        ok: same,
        vacuous,
        detail: same
          ? `folders=${JSON.stringify(after?.wallpaper?.folders)}${vacuous ? '（⚠️ 快照本身就是空的，校验不具鉴别力）' : ''}`
          : `${JSON.stringify(snapshot.wallpaper)} → ${JSON.stringify(after?.wallpaper)}`,
      }
    },

    /**
     * 包住整个探针主体：无论正常结束还是抛异常，**一定会还原**。
     *
     * 3 号事故（探针崩在写回之前）就是靠这个兜住的。
     * @param body - 探针主体，`async () => { … }`。
     * @returns 主体的返回值。
     */
    async run(body) {
      try {
        return await body()
      } finally {
        const result = await this.restore()
        console.log(`\n配置还原：${result.ok ? 'OK' : '★失败★'} — ${result.detail}`)
        if (!result.ok) process.exitCode = 1
      }
    },
  }
}
