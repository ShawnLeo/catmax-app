import type { DiffStats } from '@renderer/lib/diff-stats'
import type { ReviewFile } from '@renderer/lib/review'
import { PANEL_SIZE_LIMITS } from '@shared/settings-schema'
import { defineStore } from 'pinia'
import { ref } from 'vue'

const DEFAULT_SIDEBAR_WIDTH = 240
const DEFAULT_RIGHT_PANEL_WIDTH = 320
const DEFAULT_FILE_PREVIEW_WIDTH = 520
const DEFAULT_BOTTOM_PANEL_HEIGHT = 320

// Pointer coordinates can be fractional under display scaling. Persisted panel dimensions are
// integer pixels within a fixed range, so normalize them at the store boundary before they can
// reach settings.update —— 越界的值会被 Zod 打回，而写入方（拖拽结束）不看返回值，
// 表现是主进程刷 ZodError、这次拖出来的宽度存不进去，拖拽当下却没有任何提示。
function normalizePanelSize(size: number, limits: { min: number; max: number }): number {
  return Math.min(limits.max, Math.max(limits.min, Math.round(size)))
}

/**
 * 审查 tab 的最小推荐宽度——split diff 视图需要左右两列空间，
 * 低于这个宽度会挤；showReview 会把右栏临时撑到这个值。
 */
const REVIEW_PANEL_MIN_WIDTH = 760

export type RightPanelTab = 'git' | 'files' | 'review' | 'tasks'
/** Review Diff Mode: 统一(单列 +/- 穿插) 或 拆分(左右双列) */
export type ReviewDiffMode = 'unified' | 'split'

export const useUiStore = defineStore('ui', () => {
  const sidebarCollapsed = ref(false)
  // Sidebar Peek: 侧栏折叠时，鼠标划到窗口最左边缘临时"划出"的那层浮动侧栏。
  // 它跟 sidebarCollapsed 是两个独立状态——peek 只是临时借看一眼会话列表，
  // 收回时折叠状态不变（真正展开仍然只能靠 toggleSidebar）。
  const sidebarPeeking = ref(false)
  // Sidebar Overlay: toggleSidebar 的调用计数。窄窗口下侧栏展开是浮层形态（抽屉式，
  // 点侧栏外面收起），而顶栏的「切换侧栏」按钮本身也在侧栏外面——这个序号让"点外部"
  // 能分辨"用户想收起侧栏"和"用户点的正是切换按钮（它自己会翻转状态）"，后者不该
  // 被 outside-close 再插一手（否则刚点开的浮层立刻又被收起）。跟 rightPanelOpenSeq 同构。
  const sidebarToggleSeq = ref(0)
  const settingsDialogOpen = ref(false)
  const rightPanelVisible = ref(false)
  const bottomPanelVisible = ref(false)
  const commandPaletteVisible = ref(false)
  const rightPanelTab = ref<RightPanelTab>('files')
  // Right Panel Overlay: showRightPanel 的调用计数。浮层形态是抽屉式的（点面板外面收起），
  // 而消息流里的「审查」「后台任务」入口本身也在面板外面——这个序号让"点外部"能分辨
  // "用户想关掉面板"和"用户点的正是打开面板的入口"，后者不该先关一次再弹回来。
  const rightPanelOpenSeq = ref(0)

  // ===== 审查 tab 状态 =====
  // 审查是「某一轮改动」的只读快照：files/stats 由 ChangesCard 传入（codex 来自
  // file_change 活动，claude 来自本轮的 Edit/Write 工具调用，见 lib/review.ts），
  // selectedPath/diffMode 是用户在审查面板内的交互选择。数据只活在内存，不持久化
  // （每轮的 diff 已在消息块里，点审核时把当前轮的 files 快照塞进来即可）。
  const reviewFiles = ref<ReviewFile[]>([])
  const reviewStats = ref<DiffStats>({ additions: 0, deletions: 0 })
  const reviewDiffMode = ref<ReviewDiffMode>('unified')
  const reviewSelectedPath = ref<string | null>(null)
  // 审查面板内文件树的宽度和显隐（可拖宽、可关闭让 diff 列表占满）
  const reviewTreeWidth = ref(240)
  const reviewTreeVisible = ref(true)
  // 列表里展开的文件 path 集合——多文件可同时展开查看 diff
  const reviewExpandedPaths = ref<Set<string>>(new Set())

  // ===== 后台任务 tab 状态 =====
  // Background Tasks Focus: 从消息流的工具卡片点「在后台面板查看」时的跳转目标。
  // 只放 taskId，任务数据仍在 message store——这里存的是"面板该把哪一条展开并滚到眼前"。
  // TasksPanel 消费后置回 null，否则用户手动收起后下次打开面板又会被强行展开。
  const focusedBackgroundTaskId = ref<string | null>(null)

  const sidebarWidth = ref(DEFAULT_SIDEBAR_WIDTH)
  const rightPanelWidth = ref(DEFAULT_RIGHT_PANEL_WIDTH)
  // File Preview Layout: 预览宽度与文件树宽度分开保存，拖动组合面板时互不覆盖。
  const filePreviewWidth = ref(DEFAULT_FILE_PREVIEW_WIDTH)
  const fileTreeVisible = ref(true)
  const bottomPanelHeight = ref(DEFAULT_BOTTOM_PANEL_HEIGHT)

  // 拖拽 resize 期间为 true：面板关掉 transition（避免动画追赶造成卡顿），
  // 且 setSidebarWidth 等不再每帧写盘（拖拽结束统一持久化一次）。
  const panelDragging = ref(false)

  function startPanelDrag(): void {
    panelDragging.value = true
  }

  function endPanelDrag(): void {
    panelDragging.value = false
    saveWidths()
  }

  function setSidebarWidth(width: number): void {
    sidebarWidth.value = normalizePanelSize(width, PANEL_SIZE_LIMITS.sidebarWidth)
    if (!panelDragging.value) saveWidths()
  }

  function setRightPanelWidth(width: number): void {
    rightPanelWidth.value = normalizePanelSize(width, PANEL_SIZE_LIMITS.rightPanelWidth)
    if (!panelDragging.value) saveWidths()
  }

  function setFilePreviewWidth(width: number): void {
    filePreviewWidth.value = width
  }

  function setFileTreeVisible(visible: boolean): void {
    fileTreeVisible.value = visible
  }

  function setBottomPanelHeight(height: number): void {
    bottomPanelHeight.value = normalizePanelSize(height, PANEL_SIZE_LIMITS.bottomPanelHeight)
    if (!panelDragging.value) saveWidths()
  }

  function loadWidths(
    sidebarWidthFromSettings: number | undefined,
    rightPanelWidthFromSettings: number | undefined,
    bottomPanelHeightFromSettings: number | undefined,
  ): void {
    if (sidebarWidthFromSettings !== undefined) {
      sidebarWidth.value = sidebarWidthFromSettings
    }
    if (rightPanelWidthFromSettings !== undefined) {
      rightPanelWidth.value = rightPanelWidthFromSettings
    }
    if (bottomPanelHeightFromSettings !== undefined) {
      bottomPanelHeight.value = bottomPanelHeightFromSettings
    }
  }

  async function saveWidths(): Promise<void> {
    const { useSettingsStore } = await import('@renderer/stores/settings')
    const settingsStore = useSettingsStore()
    if (settingsStore.settings) {
      await settingsStore.update({
        sidebarWidth: sidebarWidth.value,
        rightPanelWidth: rightPanelWidth.value,
        bottomPanelHeight: bottomPanelHeight.value,
      })
    }
  }

  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value
    sidebarToggleSeq.value += 1
    // 展开/折叠后 peek 一律收掉：展开时它会跟真侧栏重叠，折叠时用户刚做完显式操作，
    // 再留一层浮层在那儿只会挡住视线。
    sidebarPeeking.value = false
  }

  /** 划出临时侧栏——只在折叠状态下有意义（展开时真侧栏就在那儿）。 */
  function openSidebarPeek(): void {
    if (!sidebarCollapsed.value) return
    sidebarPeeking.value = true
  }

  /** 收回临时侧栏。 */
  function closeSidebarPeek(): void {
    sidebarPeeking.value = false
  }

  function openSettings(): void {
    settingsDialogOpen.value = true
  }

  function closeSettings(): void {
    settingsDialogOpen.value = false
  }

  function toggleRightPanel(): void {
    rightPanelVisible.value = !rightPanelVisible.value
  }

  function showRightPanel(tab: RightPanelTab = rightPanelTab.value): void {
    rightPanelTab.value = tab
    rightPanelVisible.value = true
    rightPanelOpenSeq.value += 1
  }

  function hideRightPanel(): void {
    rightPanelVisible.value = false
  }

  /**
   * 打开审查 tab：把当前轮的变更文件快照塞进来。
   *
   * - 无 focusPath：默认展开第一个有 diff 的文件（列表里直接能看到它的 diff）。
   * - 有 focusPath（从 ChangesCard 点具体文件进入）：选中该文件并展开它，
   *   列表会滚动定位到这张卡片。
   *
   * split diff 视图需要足够宽度——若右栏当前太窄，临时撑到 REVIEW_PANEL_MIN_WIDTH
   * 并持久化（拖拽时用户仍可自由调，这里只在打开时兜底，避免 split 挤成一团）。
   */
  function showReview(files: ReviewFile[], stats: DiffStats, focusPath?: string): void {
    reviewFiles.value = files
    reviewStats.value = stats
    reviewExpandedPaths.value = new Set()
    if (focusPath) {
      reviewSelectedPath.value = focusPath
      reviewExpandedPaths.value = new Set([focusPath])
    } else {
      // 默认展开第一个有内容可看的文件——没 diff 也没 edits 的展开只是占位。
      // 两个字段都要看：codex 给 diff，claude 给 edits（见 lib/review.ts）。
      const firstWithDiff = files.find((f) => Boolean(f.diff) || Boolean(f.edits?.length))
      const target = firstWithDiff?.path ?? files[0]?.path ?? null
      reviewSelectedPath.value = target
      if (target) reviewExpandedPaths.value = new Set([target])
    }
    if (rightPanelWidth.value < REVIEW_PANEL_MIN_WIDTH) {
      setRightPanelWidth(REVIEW_PANEL_MIN_WIDTH)
      void saveWidths()
    }
    showRightPanel('review')
  }

  function setReviewSelectedPath(path: string): void {
    reviewSelectedPath.value = path
  }

  function setReviewDiffMode(mode: ReviewDiffMode): void {
    reviewDiffMode.value = mode
  }

  function setReviewTreeWidth(width: number): void {
    reviewTreeWidth.value = width
  }

  function setReviewTreeVisible(visible: boolean): void {
    reviewTreeVisible.value = visible
  }

  /** 切换某文件卡片的展开/收起 */
  function toggleReviewFileExpanded(path: string): void {
    const next = new Set(reviewExpandedPaths.value)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    reviewExpandedPaths.value = next
  }

  /** 显式设置某文件卡片展开/收起（树点击联动列表时用） */
  function setReviewFileExpanded(path: string, open: boolean): void {
    const next = new Set(reviewExpandedPaths.value)
    if (open) next.add(path)
    else next.delete(path)
    reviewExpandedPaths.value = next
  }

  /** 全部展开：把所有 reviewFiles 的 path 都加入展开集合 */
  function expandAllReviewFiles(): void {
    reviewExpandedPaths.value = new Set(reviewFiles.value.map((f) => f.path))
  }

  /** 全部收起：清空展开集合 */
  function collapseAllReviewFiles(): void {
    reviewExpandedPaths.value = new Set()
  }

  /** 清空审查快照——切换后端/工作区时调用，避免残留别处的 codex 改动 */
  function clearReview(): void {
    reviewFiles.value = []
    reviewStats.value = { additions: 0, deletions: 0 }
    reviewSelectedPath.value = null
    reviewExpandedPaths.value = new Set()
    if (rightPanelTab.value === 'review') {
      rightPanelTab.value = 'files'
    }
  }

  function setRightPanelTab(tab: RightPanelTab): void {
    rightPanelTab.value = tab
  }

  /** 打开后台面板并定位到某条任务（工具卡片的「在后台面板查看」入口）。 */
  function focusBackgroundTask(taskId: string): void {
    focusedBackgroundTaskId.value = taskId
    showRightPanel('tasks')
  }

  /** TasksPanel 消费完跳转目标后调用，避免下次打开面板时又被强行展开。 */
  function clearBackgroundTaskFocus(): void {
    focusedBackgroundTaskId.value = null
  }

  function toggleBottomPanel(): void {
    bottomPanelVisible.value = !bottomPanelVisible.value
  }

  function openCommandPalette(): void {
    commandPaletteVisible.value = true
  }

  function closeCommandPalette(): void {
    commandPaletteVisible.value = false
  }

  function toggleCommandPalette(): void {
    commandPaletteVisible.value = !commandPaletteVisible.value
  }

  return {
    sidebarCollapsed,
    sidebarPeeking,
    sidebarToggleSeq,
    settingsDialogOpen,
    rightPanelVisible,
    bottomPanelVisible,
    commandPaletteVisible,
    rightPanelTab,
    rightPanelOpenSeq,
    reviewFiles,
    reviewStats,
    reviewDiffMode,
    reviewSelectedPath,
    reviewTreeWidth,
    reviewTreeVisible,
    reviewExpandedPaths,
    focusedBackgroundTaskId,
    sidebarWidth,
    rightPanelWidth,
    filePreviewWidth,
    fileTreeVisible,
    bottomPanelHeight,
    panelDragging,
    startPanelDrag,
    endPanelDrag,
    setSidebarWidth,
    setRightPanelWidth,
    setFilePreviewWidth,
    setFileTreeVisible,
    setBottomPanelHeight,
    toggleSidebar,
    openSidebarPeek,
    closeSidebarPeek,
    openSettings,
    closeSettings,
    toggleRightPanel,
    showRightPanel,
    hideRightPanel,
    showReview,
    setReviewSelectedPath,
    setReviewDiffMode,
    setReviewTreeWidth,
    setReviewTreeVisible,
    toggleReviewFileExpanded,
    setReviewFileExpanded,
    expandAllReviewFiles,
    collapseAllReviewFiles,
    clearReview,
    setRightPanelTab,
    focusBackgroundTask,
    clearBackgroundTaskFocus,
    toggleBottomPanel,
    openCommandPalette,
    closeCommandPalette,
    toggleCommandPalette,
    loadWidths,
  }
})
