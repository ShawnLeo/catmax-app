/**
 * Unified Skill Center 的渲染层状态。
 *
 * 所有会改盘的调用都直接把 main 回来的 snapshot 整份换上，不做本地乐观更新——
 * 建软链、迁移、删除都可能部分成功（`~/.agents` 是 root 所有时就会 EACCES），
 * 本地猜一个结果会让界面显示的和磁盘上的不一致，而这正是这个功能要解决的问题。
 */
import type { SkillEntry, SkillsSnapshot } from '@shared/skills/types'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { useWorkspaceStore } from './workspace'

const EMPTY: SkillsSnapshot = {
  entries: [],
  issues: [],
  unifiedRoot: { path: '', exists: false, writable: false },
}

export const useSkillsStore = defineStore('skills', () => {
  const snapshot = ref<SkillsSnapshot>(EMPTY)
  const loading = ref(false)
  /** 最近一次操作的提示（成功时为 null）。 */
  const lastMessage = ref<string | null>(null)
  /** 正在执行操作的技能 id——行内按钮据此禁用，防止连点。 */
  const busyId = ref<string | null>(null)

  const entries = computed(() => snapshot.value.entries)
  const globalSkills = computed(() => entries.value.filter((e) => e.scope === 'global'))
  const projectSkills = computed(() => entries.value.filter((e) => e.scope === 'project'))
  /** 新建会话页那个数字：当前项目**已启用**的技能数。 */
  const enabledProjectCount = computed(() => projectSkills.value.filter((e) => e.enabled).length)
  /** 新建会话页的“系统技能”对应设置页的全局技能，包含同步/镜像后的全局条目。 */
  const systemSkills = computed(() => globalSkills.value)
  const systemSkillCount = computed(() => systemSkills.value.length)
  const projectSkillCount = computed(() => projectSkills.value.length)
  /** 在统一目录里、但另一个后端还看不到的——需要「修复可见性」。 */
  const needsMirror = computed(() =>
    entries.value.filter((e) => e.unified && e.visibleTo.length < 2),
  )

  function scopeArgs(): { workspaceId?: string } {
    const id = useWorkspaceStore().currentWorkspace?.id
    return id ? { workspaceId: id } : {}
  }

  /** 上次扫盘完成的时刻，给聚焦重扫做节流用。 */
  let lastScanAt = 0

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      snapshot.value = await window.api.skills.list(scopeArgs())
    } finally {
      loading.value = false
      lastScanAt = Date.now()
    }
  }

  /**
   * 技能是磁盘上的文件，catmax 之外的任何东西都可能改它（安装器、编辑器、终端里的
   * codex），所以只能在"用户可能刚在外面改完"的时机重扫。窗口重新聚焦就是这个时机。
   *
   * 引用计数而不是各组件各挂一个 listener：设置页的技能区和新建会话页的 popover
   * 会同时在场，各挂一个就等于每次聚焦扫两遍盘。
   */
  let focusRefCount = 0
  let detachFocus: (() => void) | null = null

  function onWindowFocus(): void {
    // 1 秒内不重复扫：focus 和 visibilitychange 在同一次切回应用时会一起触发。
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

  /**
   * 后端推来的 `skills/changed`。
   *
   * 只订阅一次（store 是单例，生命周期等于应用），不提供退订——没有"不想再听技能
   * 变更"的场景。⚠️ 这条通道**不可靠**，只能当补充：实测 codex 0.145 既不 watch
   * 文件系统，`skills/config/write` 之后也不推，唯一确认会推的时机是
   * `skills/extraRoots/set`。真正兜底的是上面那个聚焦重扫和 popover 打开时的重扫。
   */
  let subscribed = false
  function subscribeToBackendChanges(): void {
    if (subscribed) return
    subscribed = true
    window.api.skills.onChanged(() => void refresh())
  }

  /*
   * 返回类型写成 `ReturnType<typeof window.api.skills.mirror>` 而不是直接写
   * `Promise<SkillActionResult>`：typed IPC 的 requestMain 是
   * `Promise<ReturnType<H[K]>>`，而 handler 本身已经返回 Promise，所以 api 上的
   * 类型是**双层 Promise**（await 会自动摊平，运行时无差别）。照抄 api 的类型
   * 就不必在这里复述这个细节，将来 typed.ts 改了也不用跟着改。
   */
  async function run(
    id: string,
    action: (args: {
      id: string
      workspaceId?: string
    }) => ReturnType<typeof window.api.skills.mirror>,
  ): Promise<boolean> {
    busyId.value = id
    lastMessage.value = null
    try {
      const result = await action({ id, ...scopeArgs() })
      snapshot.value = result.snapshot
      lastMessage.value = result.message ?? null
      return result.ok
    } finally {
      busyId.value = null
    }
  }

  async function setEnabled(entry: SkillEntry, enabled: boolean): Promise<boolean> {
    return run(entry.id, (args) => window.api.skills.setEnabled({ ...args, enabled }))
  }

  const mirror = (entry: SkillEntry): Promise<boolean> =>
    run(entry.id, (args) => window.api.skills.mirror(args))
  const migrate = (entry: SkillEntry): Promise<boolean> =>
    run(entry.id, (args) => window.api.skills.migrate(args))
  const remove = (entry: SkillEntry): Promise<boolean> =>
    run(entry.id, (args) => window.api.skills.remove(args))

  async function reveal(entry: SkillEntry): Promise<void> {
    await window.api.skills.reveal({ id: entry.id, ...scopeArgs() })
  }

  async function openInEditor(entry: SkillEntry): Promise<void> {
    const result = await window.api.skills.openInEditor({ id: entry.id, ...scopeArgs() })
    lastMessage.value = result.launched ? null : (result.error ?? '打开编辑器失败')
  }

  function clearMessage(): void {
    lastMessage.value = null
  }

  return {
    snapshot,
    entries,
    globalSkills,
    projectSkills,
    enabledProjectCount,
    projectSkillCount,
    systemSkills,
    systemSkillCount,
    needsMirror,
    loading,
    lastMessage,
    busyId,
    refresh,
    retainFocusRefresh,
    subscribeToBackendChanges,
    setEnabled,
    mirror,
    migrate,
    remove,
    reveal,
    openInEditor,
    clearMessage,
  }
})
