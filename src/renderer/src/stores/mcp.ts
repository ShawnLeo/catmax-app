/**
 * Unified MCP Server Center 的渲染层状态。
 *
 * 与 skills store 同样的原则：snapshot 整份来自 main 扫盘，不在本地做乐观更新。
 *
 * ⚠️ 这里拿到的 `location.config` 里的 headers / env **已经是掩码**（main 侧脱敏，
 * 见 mcp-secrets.ts）。任何"复制配置""导出"之类的功能都不能拿 store 里的值去用——
 * 它不是真配置。要真配置只能让 main 自己重读文件。
 */
import type { BackendId } from '@shared/constants'
import type { McpActionResult } from '@shared/ipc/mcp'
import type { McpEntry, McpSnapshot } from '@shared/mcp/types'
import { hasCrossBackendDrift } from '@shared/mcp/view'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { useWorkspaceStore } from './workspace'

function emptySnapshot(): McpSnapshot {
  return { entries: [], issues: [] }
}

export const useMcpStore = defineStore('mcp', () => {
  const snapshot = ref<McpSnapshot>(emptySnapshot())
  const loading = ref(false)

  const entries = computed(() => snapshot.value.entries)
  const issues = computed(() => snapshot.value.issues)

  const globalServers = computed(() => entries.value.filter((e) => e.scope === 'global'))
  const projectServers = computed(() => entries.value.filter((e) => e.scope === 'project'))

  /**
   * 只有一个后端看得见的——同步功能（Phase 4）的目标。
   *
   * 排除 managed：企业下发的 server catmax 一处也改不动，把它列进"可同步"
   * 只会让用户点一个必定失败的按钮。
   */
  const singleBackendServers = computed(() =>
    entries.value.filter((e) => e.visibleTo.length === 1 && !e.managed),
  )

  /**
   * 「配置在、但不生效」的条目。
   *
   * 这是本功能最该显眼的一类：needs-trust / needs-approval 的 server 在列表里
   * 看得见，用户很容易以为它已经在用了。单独聚一个 computed 出来，方便顶部
   * 直接摆一条提示，而不是让用户自己在长列表里找徽章。
   */
  const ineffectiveServers = computed(() =>
    entries.value.filter((e) => e.locations.some((l) => l.ineffective !== null)),
  )

  /**
   * 两端配置已经漂移的条目。
   *
   * 与 ineffective / 明文凭据并列成第三条顶部提示：MCP 没有软链可依，两端是各自
   * 独立的副本，**漂移一定会发生**（用户在一边 `claude mcp add` 升级了包版本，
   * 另一边还是旧的）。而漂移的表现是"同一个工具在两个后端里行为不一样"——
   * 这是用户最不会想到去 MCP 列表里找原因的一类问题，所以要主动顶上来。
   */
  const driftedServers = computed(() => entries.value.filter(hasCrossBackendDrift))

  /** 配置里含明文密钥的——用于提示用户改用环境变量引用。 */
  const serversWithInlineSecret = computed(() =>
    entries.value.filter((e) => e.locations.some((l) => l.hasInlineSecret)),
  )

  function scopeArgs(): { workspaceId?: string } {
    const id = useWorkspaceStore().currentWorkspace?.id
    return id ? { workspaceId: id } : {}
  }

  let lastScanAt = 0

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const next = await window.api.mcp.list(scopeArgs())
      // 把上一次探到的运行时状态搬过来。扫盘返回的 runtime 恒为空，直接覆盖的话
      // 用户切一下窗口（focus 会自动重扫）刚探到的状态就全没了，而重探要十几秒。
      // 代价是状态会变旧——所以 runtimeProbedAt 要显示出来，让用户自己判断。
      const previous = new Map(snapshot.value.entries.map((e) => [e.id, e.runtime]))
      for (const entry of next.entries) {
        const carried = previous.get(entry.id)
        if (carried) entry.runtime = carried
      }
      snapshot.value = next
    } finally {
      loading.value = false
      lastScanAt = Date.now()
    }
  }

  /**
   * MCP 配置是磁盘上的文件，catmax 之外的东西随时会改它（`claude mcp add`、
   * `codex` 自己、用户手编）。而两个后端**都没有**可靠的配置变更通知——codex 的
   * `mcpServerStatusUpdated` 只报运行时状态，不报配置文件变更。所以只能在
   * "用户可能刚在外面改完"的时机重扫，窗口重新聚焦就是这个时机。
   *
   * 引用计数的理由与 skills store 相同：设置页和 popover 会同时在场。
   */
  let focusRefCount = 0
  let detachFocus: (() => void) | null = null

  function onWindowFocus(): void {
    // 1 秒内不重复扫：focus 和 visibilitychange 在切回应用时会一起触发。
    if (loading.value || Date.now() - lastScanAt < 1000) return
    void refresh()
  }

  function retainFocusRefresh(): () => void {
    focusRefCount += 1
    if (focusRefCount === 1) {
      window.addEventListener('focus', onWindowFocus)
      document.addEventListener('visibilitychange', onWindowFocus)
      detachFocus = () => {
        window.removeEventListener('focus', onWindowFocus)
        document.removeEventListener('visibilitychange', onWindowFocus)
      }
    }
    let released = false
    return () => {
      // 幂等：组件卸载路径可能不止一条，多调一次不该把计数扣穿。
      if (released) return
      released = true
      focusRefCount -= 1
      if (focusRefCount === 0) {
        detachFocus?.()
        detachFocus = null
      }
    }
  }

  async function reveal(entry: McpEntry): Promise<void> {
    await window.api.mcp.reveal({ id: entry.id, ...scopeArgs() })
  }

  /** 正在写盘的 entry id。开关要写两个后端的配置文件，不是瞬时操作。 */
  const busyIds = ref(new Set<string>())
  /** 最近一次操作的提示（失败原因 / 有损警告），显示完由用户关掉。 */
  const notice = ref<{ kind: 'error' | 'warning'; lines: string[] } | null>(null)

  function applyResult(result: McpActionResult): void {
    // 整份 snapshot 由 main 回来，不做乐观更新：开关的真实结果取决于两端配置文件
    // 写没写成，本地猜一个只会在失败时显示成"已关闭"。
    snapshot.value = result.snapshot
    lastScanAt = Date.now()
    if (!result.ok) notice.value = { kind: 'error', lines: [result.message ?? '操作失败'] }
    else if (result.warnings?.length) notice.value = { kind: 'warning', lines: result.warnings }
    else notice.value = null
  }

  async function setEnabled(entry: McpEntry, enabled: boolean): Promise<void> {
    if (busyIds.value.has(entry.id)) return
    busyIds.value = new Set(busyIds.value).add(entry.id)
    try {
      applyResult(await window.api.mcp.setEnabled({ id: entry.id, enabled, ...scopeArgs() }))
    } finally {
      const next = new Set(busyIds.value)
      next.delete(entry.id)
      busyIds.value = next
    }
  }

  async function trustProject(folderPath: string): Promise<void> {
    applyResult(await window.api.mcp.trustProject({ folderPath, ...scopeArgs() }))
  }

  /**
   * 待确认的有损同步。main 在 `confirmLossy` 之前会带着 warnings 且 `ok=false` 返回，
   * UI 拿它弹确认，用户点了「仍然继续」再原样重发一次带 confirmLossy 的请求。
   *
   * 之所以由 main 决定该不该拦而不是 renderer 自己判：判据是字段级的转换损失
   * （见 describeLoss），那需要**未脱敏**的配置——renderer 手上只有掩码。
   */
  const pendingLossySync = ref<{
    entry: McpEntry
    target: BackendId
    mode: 'inject' | 'write'
    warnings: string[]
  } | null>(null)

  async function runSync(
    entry: McpEntry,
    target: BackendId,
    mode: 'inject' | 'write',
    confirmLossy: boolean,
  ): Promise<void> {
    if (busyIds.value.has(entry.id)) return
    busyIds.value = new Set(busyIds.value).add(entry.id)
    try {
      const result = await window.api.mcp.sync({
        id: entry.id,
        targetBackend: target,
        mode,
        confirmLossy,
        ...scopeArgs(),
      })
      // 明确的 code，不再从"没有 message"反推语义。
      if (result.code === 'needs-confirmation') {
        pendingLossySync.value = { entry, target, mode, warnings: result.warnings ?? [] }
        snapshot.value = result.snapshot
        return
      }
      pendingLossySync.value = null
      applyResult(result)
    } finally {
      const next = new Set(busyIds.value)
      next.delete(entry.id)
      busyIds.value = next
    }
  }

  async function sync(entry: McpEntry, target: BackendId, confirmLossy = false): Promise<void> {
    await runSync(entry, target, 'inject', confirmLossy)
  }

  async function confirmPendingSync(): Promise<void> {
    const pending = pendingLossySync.value
    if (!pending) return
    pendingLossySync.value = null
    // 用原来的 mode 重发——注入和写入的确认文案一样，但做的事完全不同，
    // 确认后掉到另一条路上就是最糟糕的那种界面撒谎。
    await runSync(pending.entry, pending.target, pending.mode, true)
  }

  /**
   * 写入目标后端的用户配置文件。
   *
   * 与 sync('inject') 共用同一个 IPC，只是 mode 不同——两者的前置校验（已可见？
   * 有损？）完全一样，分成两个方法只会让那套校验有两份。
   */
  async function write(entry: McpEntry, target: BackendId, confirmLossy = false): Promise<void> {
    await runSync(entry, target, 'write', confirmLossy)
  }

  async function remove(entry: McpEntry): Promise<void> {
    if (busyIds.value.has(entry.id)) return
    busyIds.value = new Set(busyIds.value).add(entry.id)
    try {
      applyResult(await window.api.mcp.remove({ id: entry.id, ...scopeArgs() }))
    } finally {
      const next = new Set(busyIds.value)
      next.delete(entry.id)
      busyIds.value = next
    }
  }

  async function unsync(entry: McpEntry, target: BackendId): Promise<void> {
    if (busyIds.value.has(entry.id)) return
    busyIds.value = new Set(busyIds.value).add(entry.id)
    try {
      applyResult(
        await window.api.mcp.unsync({ id: entry.id, targetBackend: target, ...scopeArgs() }),
      )
    } finally {
      const next = new Set(busyIds.value)
      next.delete(entry.id)
      busyIds.value = next
    }
  }

  /**
   * 拉运行时状态。**只在用户明确点了按钮时调**——见 mcp.refreshRuntime 的契约注释，
   * claude 那一侧要冷启握手再轮询十几秒。所以它有独立的 loading 标志，不复用
   * `loading`：那个是给毫秒级的扫盘用的，共用会让「重新扫描」按钮也一起灰十几秒。
   */
  const runtimeLoading = ref(false)
  /** 上次成功探测的时刻；0 = 从没探过。没探过时 UI 显示「未探测」而不是「未连接」。 */
  const runtimeProbedAt = ref(0)

  async function refreshRuntime(): Promise<void> {
    if (runtimeLoading.value) return
    runtimeLoading.value = true
    try {
      snapshot.value = await window.api.mcp.refreshRuntime(scopeArgs())
      runtimeProbedAt.value = Date.now()
    } finally {
      runtimeLoading.value = false
      lastScanAt = Date.now()
    }
  }

  return {
    snapshot,
    entries,
    issues,
    globalServers,
    projectServers,
    singleBackendServers,
    ineffectiveServers,
    driftedServers,
    serversWithInlineSecret,
    loading,
    runtimeLoading,
    runtimeProbedAt,
    busyIds,
    notice,
    refresh,
    refreshRuntime,
    retainFocusRefresh,
    reveal,
    setEnabled,
    trustProject,
    pendingLossySync,
    sync,
    confirmPendingSync,
    unsync,
    write,
    remove,
  }
})
