<template>
  <div ref="containerRef" class="h-full flex relative">
    <!--
      侧栏停靠形态（宽窗口）：始终挂载，折叠通过宽度 0 过渡，见 Sidebar.vue。
      窄窗口下侧栏走浮层（见下方 sidebar overlay 分支），停靠树整块隐藏。
    -->
    <template v-if="!sidebarOverlay">
      <Sidebar />
      <ResizeHandle
        v-if="!uiStore.sidebarCollapsed"
        side="left"
        :min="SIDEBAR_MIN"
        :max="sidebarMax"
        :current="uiStore.sidebarWidth"
        @resize="uiStore.setSidebarWidth"
      />
    </template>

    <!--
      Sidebar Peek 热区：侧栏折叠时，窗口最左边缘一条 8px 的感应带。
      指针划进来就临时划出一层浮动侧栏（会话列表 + 底部设置栏），不改变折叠状态。
      仅停靠形态下挂——浮层形态侧栏是展开的，用不到 peek。
    -->
    <div
      v-if="!sidebarOverlay && uiStore.sidebarCollapsed"
      class="absolute inset-y-0 left-0 z-30 w-2"
      aria-hidden="true"
      @pointerenter="openPeek"
    />

    <!--
      Sidebar Peek 划出的浮层（停靠形态 + 折叠态）：从顶栏下方开始（顶栏 h-12 已有窗口
      控制按钮和标题，不重复划出），内容复用同一个 Sidebar 组件的 overlay 形态，
      指针离开后由 useSidebarPeek 自动收回。
    -->
    <Transition name="sidebar-peek">
      <div
        v-if="!sidebarOverlay && uiStore.sidebarPeeking"
        ref="peekRef"
        class="absolute bottom-0 left-0 top-12 z-40 flex"
      >
        <Sidebar variant="overlay" />
      </div>
    </Transition>

    <!--
      Sidebar Overlay（窄窗口展开侧栏）：浮在聊天区之上，不占布局宽度。展开/收起由
      顶栏切换按钮控制；点侧栏外或按 Esc 收起（抽屉式，见 useSidebarOverlay）。
      完整侧栏（含窗口控制按钮），所以 showWorkspace=true。
    -->
    <Transition name="sidebar-overlay">
      <div
        v-if="sidebarOverlay && !uiStore.sidebarCollapsed"
        ref="sidebarOverlayRef"
        class="absolute inset-y-0 left-0 z-40 flex"
      >
        <Sidebar variant="overlay" show-workspace />
      </div>
    </Transition>

    <!-- 主聊天区:用具体 min-width 而非 min-w-0,防止被右面板挤压到低于 250px。
         sidebar 折叠时宽度为 0,不占空间;展开时由 ResizeHandle clamp 在 [SIDEBAR_MIN, 容器一半],
         加上这里的 min-w 保证主聊天区 + sidebar 不会被右面板挤没。 -->
    <div ref="chatColumnRef" class="relative flex-1 flex flex-col min-w-[250px]">
      <!--
        File Mention: 拖拽文件时的投放区，盖住整条主聊天列（含输入框）。
        relative 是它的定位锚——遮罩用 absolute inset-0 铺满这一列，
        不能铺到侧栏/右栏上，见 useChatFileDrop 的「生效边界 = 视觉边界」。
      -->
      <FileDropOverlay :active="fileDragActive" @drop="onFileDrop" />

      <RuntimeConfigBar :window-draggable="!topBarCoveredByOverlay" />

      <MessageList
        v-if="messageStore.messages.length > 0"
        class="flex-1"
        :nav-rail-visible="navRailVisible"
        :show-thinking="runtimeConfig.effort !== 'none'"
      />
      <div
        v-else
        class="new-session flex-1 flex items-center justify-center px-6 text-muted-foreground"
      >
        <div class="relative z-10 flex max-w-md flex-col items-center text-center">
          <CatmaxLogo variant="plain" class="mb-7 h-28 w-28" />

          <p class="text-[length:var(--ui-text-u3)] font-semibold tracking-tight text-foreground">
            开始一段新对话
          </p>
          <p class="mt-2 max-w-sm text-[length:var(--ui-text-base)] leading-relaxed">
            告诉我你想构建、修改或了解什么，我们可以从这里开始。
          </p>

          <!--
            File Mention: 拖放是个没有可见入口的功能——不写出来就只有知道的人会用。
            放在这里而不是输入框附近，是因为空会话页正是用户还没想好从哪下手的时刻。
          -->
          <p
            class="mt-4 inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-3 py-1 text-[length:var(--ui-text-d3)] text-muted-foreground"
          >
            <FilePlusIcon class="h-3.5 w-3.5" />
            把文件或文件夹拖进来，就能在对话里引用它
          </p>

          <div
            class="mt-5 flex items-center justify-center gap-3 text-[length:var(--ui-text-d3)] leading-none text-muted-foreground"
          >
            <span class="inline-flex items-center gap-1.5">
              <span>工作区</span>
              <span class="inline-flex items-center gap-1.5 font-medium text-foreground/80">
                <HouseIcon class="h-3.5 w-3.5" />
                {{ workspaceStore.currentWorkspace?.name ?? '当前工作区' }}
              </span>
            </span>
            <span class="h-3 w-px bg-border" aria-hidden="true" />
            <span class="inline-flex items-center gap-1.5">
              <span>后端</span>
              <span class="inline-flex items-center gap-1.5 font-medium text-foreground/80">
                <BackendIcon :backend="backendStore.currentId" class="h-3.5 w-3.5" />
                {{ backendDisplayName }}
              </span>
            </span>
          </div>
        </div>
      </div>

      <!--
        底部交互区三选一（同一时刻只一个，都覆盖 Composer 位置，让聊天记录可见）：
        1. agent 问题（pendingAgentQuestion）→ QuestionPanel（claude 调 ask_user 工具）
        2. 权限确认（pendingApproval / pendingClaudePermission）→ PermissionPanel
        3. 都没有 → Composer 正常输入
      -->
      <QuestionPanel v-if="messageStore.pendingAgentQuestion" :nav-rail-visible="navRailVisible" />
      <PermissionPanel
        v-else-if="messageStore.pendingApproval || messageStore.pendingClaudePermission"
        :nav-rail-visible="navRailVisible"
      />
      <Composer
        v-else
        :disabled="!backendStore.isAvailable"
        :model-value="composerModelValue"
        :nav-rail-visible="navRailVisible"
        @update:model-value="onComposerUpdate"
        @send="onSend"
      />

      <!-- 底部终端面板（始终挂载，折叠通过高度 0 过渡） -->
      <ResizeHandle
        v-if="uiStore.bottomPanelVisible"
        side="bottom"
        :min="BOTTOM_PANEL_MIN"
        :max="bottomPanelMax"
        :current="uiStore.bottomPanelHeight"
        @resize="uiStore.setBottomPanelHeight"
      />
      <BottomTerminalPanel />
    </div>

    <!--
      右栏面板两种形态（切换阈值见 useRightPanelOverlay）：
      - 停靠（宽屏）：参与布局，跟主聊天区并排，拖宽会挤压聊天区。
      - 浮层（窄屏）：绝对定位浮在聊天区之上，不占布局宽度，聊天区保持全宽；
        抽屉式交互——点面板以外的地方或按 Esc 收起。
    -->
    <template v-if="!rightPanelOverlay">
      <ResizeHandle
        v-if="uiStore.rightPanelVisible"
        side="right"
        :min="rightPanelMin"
        :max="rightPanelMax"
        :current="rightPanelCurrent"
        @resize="resizeRightPanel"
      />
      <RightPanel :file-split-allowed="fileSplitAllowed" />
    </template>
    <Transition v-else name="right-panel-overlay">
      <div
        v-if="uiStore.rightPanelVisible"
        ref="rightPanelOverlayRef"
        class="absolute inset-y-0 right-0 z-40 flex"
      >
        <ResizeHandle
          side="right"
          :min="rightPanelMin"
          :max="rightPanelMax"
          :current="rightPanelCurrent"
          @resize="resizeRightPanel"
        />
        <RightPanel variant="overlay" :file-split-allowed="fileSplitAllowed" />
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import Composer from '@renderer/components/chat/composer/Composer.vue'
import PermissionPanel from '@renderer/components/chat/feedback/PermissionPanel.vue'
import QuestionPanel from '@renderer/components/chat/feedback/QuestionPanel.vue'
import BottomTerminalPanel from '@renderer/components/chat/layout/BottomTerminalPanel.vue'
import RuntimeConfigBar from '@renderer/components/chat/layout/RuntimeConfigBar.vue'
import MessageList from '@renderer/components/chat/messages/MessageList.vue'
import FileDropOverlay from '@renderer/components/chat/overlays/FileDropOverlay.vue'
import BackendIcon from '@renderer/components/icons/BackendIcon.vue'
import CatmaxLogo from '@renderer/components/icons/CatmaxLogo.vue'
import RightPanel from '@renderer/components/panel/RightPanel.vue'
import Sidebar from '@renderer/components/sidebar/Sidebar.vue'
import ResizeHandle from '@renderer/components/ui/ResizeHandle.vue'
import { useChatFileDrop } from '@renderer/composables/useChatFileDrop'
import {
  OVERLAY_MAX_RATIO as RIGHT_PANEL_OVERLAY_MAX_RATIO,
  useRightPanelOverlay,
} from '@renderer/composables/useRightPanelOverlay'
import { useSidebarOverlay } from '@renderer/composables/useSidebarOverlay'
import { useSidebarPeek } from '@renderer/composables/useSidebarPeek'
import { useStreamMessage } from '@renderer/composables/useStreamMessage'
import { MIN_WIDTH_FOR_MESSAGE_NAV_RAIL } from '@renderer/lib/chat-layout'
import { isNavigableUserMessage } from '@renderer/lib/message-navigation'
import {
  FILE_PREVIEW_MIN,
  FILE_SPLIT_HANDLE_WIDTH,
  FILE_TREE_MIN,
  MIN_WIDTH_FOR_FILE_SPLIT,
  RIGHT_PANEL_MIN,
} from '@renderer/lib/panel-layout'
import { randomUUID } from '@renderer/lib/utils'
import { useBackendStore } from '@renderer/stores/backend'
import { useFilesStore } from '@renderer/stores/files'
import { useGitStore } from '@renderer/stores/git'
import { useMessageStore } from '@renderer/stores/message'
import { useSessionStore } from '@renderer/stores/session'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore } from '@renderer/stores/ui'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { serializeContextTags } from '@shared/backend/context-tags'
import type {
  ContextBlock,
  EffortLevel,
  PermissionMode,
  TurnConfigUpdate,
} from '@shared/backend/types'
import { type BackendId, NARROW_WINDOW_BREAKPOINT } from '@shared/constants'
import type { RuntimeConfigSnapshot } from '@shared/ipc/session'
import { FilePlusIcon, HouseIcon } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const workspaceStore = useWorkspaceStore()
const backendStore = useBackendStore()
const filesStore = useFilesStore()
const sessionStore = useSessionStore()
const messageStore = useMessageStore()
const gitStore = useGitStore()
const uiStore = useUiStore()
const settingsStore = useSettingsStore()
useStreamMessage()
// Sidebar Peek: 折叠态下从左边缘划出的临时侧栏，收回逻辑（含 Teleport 出去的菜单）在 composable 里
const { peekRef, openPeek } = useSidebarPeek()

const backendDisplayName = computed(() => {
  if (backendStore.currentId === 'claude') return 'Claude'
  if (backendStore.currentId === 'codex') return 'Codex'
  return backendStore.currentId
})

// 侧栏可拖拽宽度--min 为当前默认宽度，max 为容器一半（即最大 1:1 与聊天区同宽）
const SIDEBAR_MIN = 280
// 主聊天区最小宽度——右面板拖宽时不能把聊天区挤到低于此值。
// 250px 保证 textarea + 发送按钮至少能正常显示,再加窄就失去可用性。
const CHAT_AREA_MIN = 250
// 底部终端面板可拖拽高度——min 保证终端至少能显示几行，max 不超过容器 70%（留空间给聊天区）
const BOTTOM_PANEL_MIN = 120
const containerRef = ref<HTMLElement | null>(null)
const chatColumnRef = ref<HTMLElement | null>(null)
const containerWidth = ref(Number.POSITIVE_INFINITY)
const containerHeight = ref(Number.POSITIVE_INFINITY)
const chatColumnWidth = ref(0)

// Narrow Window: 只在“跨入”手机宽度时自动收起一次。进入窄屏后用户仍可手动打开
// 任一抽屉，不会因为后续每一帧 ResizeObserver 回调又被强制关闭。
watch(
  () => containerWidth.value <= NARROW_WINDOW_BREAKPOINT,
  (narrow, wasNarrow) => {
    if (!narrow || wasNarrow === true) return
    if (!uiStore.sidebarCollapsed) uiStore.toggleSidebar()
    uiStore.closeSidebarPeek()
    uiStore.hideRightPanel()
  },
)

const navRailVisible = computed(
  () =>
    !messageStore.loading &&
    chatColumnWidth.value >= MIN_WIDTH_FOR_MESSAGE_NAV_RAIL &&
    messageStore.messages.filter(isNavigableUserMessage).length >= 2,
)

const sidebarMax = computed(() => Math.max(SIDEBAR_MIN, Math.floor(containerWidth.value / 2)))

// File Preview Layout: 右侧拖拽目标是“预览 + 文件树”的组合宽度。
const filePreviewOpen = computed(
  () => uiStore.rightPanelTab === 'files' && filesStore.previewTabs.length > 0,
)
/**
 * Right Panel Layout: 这个窗口最多能给右栏多少宽度——取「浮层上限」和「停靠上限」中
 * 更宽松的那个，刻意不看当前是哪种形态。
 *
 * 形态判定（useRightPanelOverlay）本身要拿右栏的期望宽度当输入，而下面的单栏/并排
 * 决策又会改变期望宽度，跟着形态走就成了循环依赖。取 max 是安全的：停靠放不下的时候
 * 布局会自动切成浮层，所以真正的上限本来就是两者中较大的那个。
 */
const rightPanelAvailable = computed(() =>
  Math.max(
    Math.floor(containerWidth.value * RIGHT_PANEL_OVERLAY_MAX_RATIO),
    containerWidth.value - (uiStore.sidebarCollapsed ? 0 : uiStore.sidebarWidth) - CHAT_AREA_MIN,
  ),
)

// File Preview Split: 并排放不下时（可用宽度低于 MIN_WIDTH_FOR_FILE_SPLIT）退成单栏，
// 预览和文件树同一时刻只显示一个，由 uiStore.fileTreeVisible 决定是哪一个。
const fileSplitAllowed = computed(() => rightPanelAvailable.value >= MIN_WIDTH_FOR_FILE_SPLIT)
const fileSplitActive = computed(
  () => filePreviewOpen.value && uiStore.fileTreeVisible && fileSplitAllowed.value,
)
/** 单栏形态下当前占满右栏的是文件树（而不是预览）吗？ */
const fileTreeSolo = computed(
  () => uiStore.rightPanelTab === 'files' && !fileSplitActive.value && uiStore.fileTreeVisible,
)
const rightPanelCurrent = computed(() => {
  if (fileSplitActive.value) {
    return uiStore.rightPanelWidth + uiStore.filePreviewWidth + FILE_SPLIT_HANDLE_WIDTH
  }
  return filePreviewOpen.value && !fileTreeSolo.value
    ? uiStore.filePreviewWidth
    : uiStore.rightPanelWidth
})
/**
 * 拖拽下限也要向窗口让步：预览的理想下限是 360，但窗口本身只有 360 宽时，坚持这个
 * 下限只会让面板顶出窗口——溢出的是左边那一栏，正好是用户在看的文件详情。
 */
const rightPanelMin = computed(() => {
  const ideal = fileSplitActive.value
    ? MIN_WIDTH_FOR_FILE_SPLIT
    : filePreviewOpen.value && !fileTreeSolo.value
      ? FILE_PREVIEW_MIN
      : RIGHT_PANEL_MIN
  return Math.min(ideal, rightPanelAvailable.value)
})

// Right Panel Overlay: 窗口窄到聊天区放不下时右栏改成浮层，不再挤占布局宽度。
const {
  overlayMode: rightPanelOverlay,
  overlayRef: rightPanelOverlayRef,
  overlayMaxWidth,
} = useRightPanelOverlay({ containerWidth, desiredWidth: rightPanelCurrent })

// Sidebar Overlay: 窗口窄到聊天区放不下时，展开侧栏也改成浮层（跟右栏对称），不挤压宽度。
// 必须在 containerWidth 声明之后调用（同 useRightPanelOverlay）。
const { overlayMode: sidebarOverlay, overlayRef: sidebarOverlayRef } = useSidebarOverlay({
  containerWidth,
})

// File Mention: 拖文件进会话。这个 composable 还顺带在 window 上拦掉所有文件投放——
// 不拦的话 Chromium 会导航到 file:// URL，整个应用白屏且无路可退。
const { dragActive: fileDragActive, onDrop: onFileDrop } = useChatFileDrop()

// Window Drag Region: 任一浮层展开时，它的标题栏就压在 RuntimeConfigBar 那条上（两者
// 都是顶部 48px）。Electron 的拖拽区是全局矩形集合、不看 z-index，重叠会让浮层里按钮
// 的 no-drag 洞被填回去（工作区下拉打不开、右栏 tab 点不动）——所以这时让底下那条整条
// 退出拖拽区，重叠像素只保留浮层自己的声明。详见 RuntimeConfigBar 的 windowDraggable。
const topBarCoveredByOverlay = computed(
  () =>
    (sidebarOverlay.value && !uiStore.sidebarCollapsed) ||
    (rightPanelOverlay.value && uiStore.rightPanelVisible),
)

const rightPanelMax = computed(() => {
  // 浮层形态不占布局宽度,"挤压聊天区"这个约束不再成立——只要不铺满整个窗口即可
  // （得给聊天区留一条看得见、点得到的边，点外部要能收起面板）。
  if (rightPanelOverlay.value) return Math.max(rightPanelMin.value, overlayMaxWidth.value)
  // 停靠形态下右面板最大值受「主聊天区最小宽度」约束:
  // 容器 - sidebar 实际宽度 - 聊天区最小宽度 = 右面板能占的最大空间。
  // sidebar 折叠时不占空间(宽度 0),展开时用 uiStore.sidebarWidth。
  const sidebarWidth = uiStore.sidebarCollapsed ? 0 : uiStore.sidebarWidth
  const available = containerWidth.value - sidebarWidth - CHAT_AREA_MIN
  // 不低于 rightPanelMin(否则 handle 无法拖到 min),也不超过容器 78%
  return Math.max(
    rightPanelMin.value,
    Math.min(Math.floor(available), Math.floor(containerWidth.value * 0.78)),
  )
})
const bottomPanelMax = computed(() =>
  Math.max(BOTTOM_PANEL_MIN, Math.floor(containerHeight.value * 0.7)),
)

let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  if (containerRef.value) {
    containerWidth.value = containerRef.value.clientWidth
    containerHeight.value = containerRef.value.clientHeight
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === containerRef.value) {
          containerWidth.value = entry.contentRect.width
          containerHeight.value = entry.contentRect.height
        }
        if (entry.target === chatColumnRef.value) {
          chatColumnWidth.value = entry.contentRect.width
        }
      }
    })
    resizeObserver.observe(containerRef.value)
    if (chatColumnRef.value) {
      chatColumnWidth.value = chatColumnRef.value.clientWidth
      resizeObserver.observe(chatColumnRef.value)
    }
  }
})
onUnmounted(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

function resizeRightPanel(width: number): void {
  // File Preview Layout: 文件树宽度保持稳定，并排时只调整它左侧的预览区域。
  if (fileSplitActive.value) {
    uiStore.setFilePreviewWidth(width - uiStore.rightPanelWidth - FILE_SPLIT_HANDLE_WIDTH)
  } else if (filePreviewOpen.value && !fileTreeSolo.value) {
    uiStore.setFilePreviewWidth(width)
  } else {
    uiStore.setRightPanelWidth(width)
  }
}

/**
 * Right Panel Layout: 把存下来的宽度收进当前窗口放得下的范围。
 *
 * 浮层形态没有"挤压聊天区"这个泄压阀，停靠形态下右栏又是 shrink-0，任何一种形态里
 * 存量宽度超出可用空间都会直接溢出到窗口外——而右栏是贴着右边缘定位的，溢出的是它
 * 最左边那一栏，也就是文件详情。窗口缩小、tab 切换、并排退成单栏都会改变可用宽度，
 * 所以这里盯着最终生效的 rightPanelCurrent，而不是某一个具体来源。
 */
watch(
  [rightPanelCurrent, rightPanelMax, rightPanelMin],
  ([current, maxWidth, minWidth]) => {
    if (current <= maxWidth) return
    if (fileSplitActive.value) {
      // 并排：先压预览（文件树已经是导航用的窄栏），压不动了再动文件树。
      const treeWidth = uiStore.rightPanelWidth
      const previewTarget = maxWidth - treeWidth - FILE_SPLIT_HANDLE_WIDTH
      if (previewTarget >= FILE_PREVIEW_MIN) {
        uiStore.setFilePreviewWidth(previewTarget)
        return
      }
      uiStore.setFilePreviewWidth(FILE_PREVIEW_MIN)
      uiStore.setRightPanelWidth(
        Math.max(FILE_TREE_MIN, maxWidth - FILE_PREVIEW_MIN - FILE_SPLIT_HANDLE_WIDTH),
      )
      return
    }
    const target = Math.max(minWidth, maxWidth)
    if (filePreviewOpen.value && !fileTreeSolo.value) uiStore.setFilePreviewWidth(target)
    else uiStore.setRightPanelWidth(target)
  },
  { immediate: true },
)

/**
 * File Preview Split: 并排放不下的那一刻优先留下文件详情——文件树是导航，详情才是
 * 用户正在读的内容。反过来空间够了不自动恢复并排，避免跟用户手动的显隐来回打架。
 */
watch(fileSplitAllowed, (allowed) => {
  if (!allowed && filePreviewOpen.value) uiStore.setFileTreeVisible(false)
})

// 工作区切换时刷新 git status
watch(
  () => workspaceStore.currentWorkspace?.id,
  async (id) => {
    if (id && workspaceStore.currentWorkspace) {
      await gitStore.refresh(workspaceStore.currentWorkspace.path)
    } else {
      gitStore.reset()
    }
  },
  { immediate: true },
)

// 右栏首次打开时加载 git
watch(
  () => uiStore.rightPanelVisible,
  async (visible) => {
    if (visible && workspaceStore.currentWorkspace && !gitStore.status.isRepo) {
      await gitStore.refresh(workspaceStore.currentWorkspace.path)
    }
  },
)

/**
 * 运行时配置——后端 / 模型 / 权限模式 / 思考强度。
 *
 * 注意 permissionMode 是非空类型——默认 'default'（与 Composer 下拉保持一致）。
 * 序列化成 RuntimeConfigSnapshot 持久化时，permissionMode 若为 'default'
 * 也允许写 null（"用户没显式选过"），见 toSnapshot()。
 */
interface RuntimeConfig {
  backend: BackendId
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode
}

const runtimeConfig = ref<RuntimeConfig>({
  backend: 'codex',
  model: null,
  effort: 'medium',
  permissionMode: 'default',
})

/**
 * 从 settings 读指定 backend 的默认运行时配置（model/effort/permissionMode）。
 * 按 backend 分别配——codex / claude 各一组。null 字段由调用方兜底到硬编码默认。
 * 用于无 last-used 时的兜底——last-used 优先，settings 默认值仅兜底。
 */
function defaultsFor(b: BackendId): {
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode | null
} {
  const cfg = settingsStore.settings?.defaultRuntimeConfig?.[b]
  return {
    model: cfg?.model ?? null,
    effort: cfg?.effort ?? null,
    permissionMode: cfg?.permissionMode ?? null,
  }
}

/**
 * 校验 model 是否在当前 backend 的下拉列表里，不在就兜底。
 *
 * 兜底优先级：settings 默认值（若它也在下拉里）> backend 的 isDefault 模型 > null。
 * 用于两处：
 *   - onMounted 启动恢复（last-used 可能存了无效脏数据）
 *   - 切历史会话（老会话的 model 在当前 backend 下拉里可能已不存在）
 *
 * 依赖 backendStore.models 已对齐到目标 backend（调用方需确保 loadModels 完成）。
 */
function ensureValidModel(): void {
  const current = runtimeConfig.value.model
  if (current === null) return
  if (backendStore.models.some((m) => m.id === current)) return
  // 当前 model 无效 → 兜底
  const dft = defaultsFor(backendStore.currentId)
  const settingsDefault =
    dft.model && backendStore.models.some((m) => m.id === dft.model) ? dft.model : null
  runtimeConfig.value.model =
    settingsDefault ?? backendStore.models.find((m) => m.isDefault)?.id ?? null
}

/** 程序是否正在用 last-used 恢复 runtimeConfig——避免回写 watch 触发循环。 */
const isRestoring = ref(false)

/**
 * Composer 的 v-model 桥——只暴露 model/effort/permissionMode（不含 backend）。
 * runtimeConfig 加了 backend 字段但 Composer 的 RuntimeConfigValue 不含，
 * 这里用 computed 把 backend 剥掉，update 通过 onComposerUpdate 写回。
 */
const composerModelValue = computed(() => ({
  model: runtimeConfig.value.model,
  effort: runtimeConfig.value.effort,
  permissionMode: runtimeConfig.value.permissionMode,
}))

function onComposerUpdate(v: {
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode
}): void {
  runtimeConfig.value = {
    ...runtimeConfig.value,
    model: v.model,
    effort: v.effort,
    permissionMode: v.permissionMode,
  }
}

onMounted(async () => {
  if (!workspaceStore.currentWorkspace) {
    router.push('/')
    return
  }
  await backendStore.refresh()

  // 启动 backend 取值优先级：settings.defaultBackend（用户在设置里明确选的）
  // > lastRuntimeConfig.backend（上次运行时碰巧用的）。defaultBackend 反映用户
  // 当前对"默认用哪个后端"的明确意图，优先级最高——否则用户在设置里改了 backend，
  // 重启后又被 last-used 覆盖回去，与预期不符（会话列表过滤也会跟着错）。
  const defaultBackend = settingsStore.settings?.defaultBackend

  // 从 last-used 恢复 runtimeConfig——last-used 优先，字段为 null 时用 settings 默认值兜底。
  // backend 仍由 defaultBackend 覆盖（settings 里明确选的优先级最高）。
  try {
    const last = await window.api.session.getLastRuntimeConfig()
    if (last) {
      isRestoring.value = true
      const resolvedBackend = defaultBackend ?? last.backend
      const dft = defaultsFor(resolvedBackend)
      runtimeConfig.value = {
        backend: resolvedBackend,
        // model/effort/permissionMode：last-used 有值用它，null 时用 settings 默认值兜底
        model: last.model ?? dft.model,
        effort: last.effort ?? dft.effort ?? 'medium',
        permissionMode: last.permissionMode ?? dft.permissionMode ?? 'default',
      }
      isRestoring.value = false
    } else {
      // 无 last-used，全用 settings 默认值 + 硬编码兜底
      const b = defaultBackend ?? backendStore.currentId
      const dft = defaultsFor(b)
      isRestoring.value = true
      runtimeConfig.value = {
        backend: b,
        model: dft.model,
        effort: dft.effort ?? 'medium',
        permissionMode: dft.permissionMode ?? 'default',
      }
      isRestoring.value = false
    }
  } catch (e) {
    console.warn('[ChatView] load last runtime config failed:', e)
  }

  // 若目标 backend 跟当前后端不一致，切过去。
  // switchTo 不可用时（backend 未安装）兜底成 currentId，避免挂死。
  if (runtimeConfig.value.backend !== backendStore.currentId) {
    try {
      await backendStore.switchTo(runtimeConfig.value.backend)
    } catch (e) {
      console.warn('[ChatView] switch to backend failed:', e)
      runtimeConfig.value.backend = backendStore.currentId
    }
  }

  await backendStore.loadModels()

  // model 有效性校验——last-used 可能存了无效值（历史脏数据，如 codex 的 model 曾被
  // 错误存成 modelProvider 'openai'），或切 backend 后旧 model id 在新 backend 下拉里不存在。
  ensureValidModel()

  await sessionStore.load(workspaceStore.currentWorkspace.id, backendStore.currentId)

  // 订阅 session:titleChanged —— claude turn 完成后从 jsonl 读到 aiTitle，
  // main 回写 db + 广播，这里同步更新本地 sessions 数组让侧边栏标题刷新。
  unsubscribeTitleChanged = window.api.session.onTitleChanged(({ sessionId, title }) => {
    const target = sessionStore.sessions.find((s) => s.id === sessionId)
    if (target && target.title !== title) {
      target.title = title
    }
  })
})

let unsubscribeTitleChanged: (() => void) | null = null
onUnmounted(() => {
  unsubscribeTitleChanged?.()
  unsubscribeTitleChanged = null
})

watch(
  () => backendStore.models,
  (models) => {
    if (models.length > 0 && !runtimeConfig.value.model) {
      const def = models.find((m) => m.isDefault) ?? models[0]
      runtimeConfig.value.model = def!.id
    }
  },
  { immediate: true },
)

/**
 * 切 backend（来自 RuntimeConfigBar 下拉 / SessionList tab）时：
 *   1. 同步 runtimeConfig.backend
 *   2. 清空 model selection——不同 backend 的 model id 不互通
 *      （比如 claude 的 'sonnet' 传给 codex 会报 "The 'sonnet' model is not supported
 *      when using Codex with a ChatGPT account"）。清空后上面的 watch 会从新 backend
 *      的 models 列表重新挑一个默认。
 *
 * 不在这里触发 last-used 写回——runtimeConfig 的 watch 会处理（backend 变更
 * 是 runtimeConfig 字段变化，会自然触发 watch）。
 */
watch(
  () => backendStore.currentId,
  (newId) => {
    if (runtimeConfig.value.backend !== newId) {
      runtimeConfig.value.backend = newId
      runtimeConfig.value.model = null
    }
  },
)

/**
 * 切历史会话时按 session 字段恢复 runtimeConfig。
 *
 * session.backend：切到对应后端（selectSession 已经处理过，这里兜底对齐）。
 * session.model/effort/permissionMode：null 时保留 last-used 不动（导入的老会话可能没记录）。
 */
watch(
  () => sessionStore.currentSession?.id,
  (newId) => {
    if (!newId) return
    const session = sessionStore.sessions.find((s) => s.id === newId)
    if (!session) return
    isRestoring.value = true
    // backend 对齐——session.backend 是会话固有属性
    if (session.backend !== runtimeConfig.value.backend) {
      runtimeConfig.value.backend = session.backend
      // backend 变了 model 必须清空（不同 backend 的 model id 不互通）
      runtimeConfig.value.model = null
    }
    // model/effort/permissionMode：null 时保留现有值（避免老会话覆盖 last-used）
    if (session.model) runtimeConfig.value.model = session.model
    if (session.effort) runtimeConfig.value.effort = session.effort
    if (session.permissionMode) runtimeConfig.value.permissionMode = session.permissionMode
    isRestoring.value = false
    // 立即校验 model 有效性——覆盖「同 backend 切会话」场景（models 没变，
    // 下面的 watch(backendStore.models) 不会触发）。老会话的 model 可能是脏值
    // （如 'openai'）或已下线，这里兜底到 settings 默认值。
    // 注意：若切会话伴随 backend 切换，此处 backendStore.models 可能还是旧列表，
    // 校验可能不准——但 models 更新后 watch(backendStore.models) 会再校验一次兜底。
    ensureValidModel()
  },
)

/**
 * backend 模型列表更新后，校验当前 runtimeConfig.model 是否仍有效。
 *
 * 触发场景：切 backend 后 loadModels 完成 / 切历史会话后 models 刷新。
 * 老会话的 model 可能在当前 backend 下拉里已不存在（如 codex 旧 model 'gpt-5.2-codex'
 * 已下线），此时兜底到 settings 默认值或 backend 默认模型。
 */
watch(
  () => backendStore.models,
  () => {
    if (isRestoring.value) return
    ensureValidModel()
  },
  { deep: true },
)

/**
 * runtimeConfig 变化时同步：
 *   1. 写回 last-used 全局缓存（下次新建会话的默认值）
 *   2. 写回当前 session 的 db 字段（切回这个会话能恢复）
 *   3. 同步本地 sessions 数组（侧边栏 / 别处 reactive）
 *
 * isRestoring=true 时跳过——正在从 last-used/session 字段恢复时不该再回写，
 * 否则会把恢复中的中间态当作用户选择持久化下来。
 *
 * isRestoring=false 但没 currentSession（用户在新建会话初始态）只写 last-used，
 * 不调 updateConfig（没 sessionId 可写）。
 */
watch(
  runtimeConfig,
  async (cfg, oldCfg) => {
    if (isRestoring.value) return
    const snapshot: RuntimeConfigSnapshot = {
      backend: cfg.backend,
      model: cfg.model,
      effort: cfg.effort,
      permissionMode: cfg.permissionMode === 'default' ? null : cfg.permissionMode,
    }
    await window.api.session
      .setLastRuntimeConfig(snapshot)
      .catch((e) => console.warn('[ChatView] setLastRuntimeConfig failed:', e))
    const sid = sessionStore.currentSession?.id
    if (sid) {
      await window.api.session
        .updateConfig({
          sessionId: sid,
          model: cfg.model,
          effort: cfg.effort,
          permissionMode: snapshot.permissionMode,
        })
        .catch((e) => console.warn('[ChatView] updateConfig failed:', e))
      // 同步本地 sessions 数组（updateConfig IPC 没返回新值）
      const target = sessionStore.sessions.find((s) => s.id === sid)
      if (target) {
        target.model = cfg.model
        target.effort = cfg.effort
        if (snapshot.permissionMode) target.permissionMode = snapshot.permissionMode
      }
    }

    // 热切换：如果当前有正在运行的 turn，且 backend 支持热切换，
    // 把变更的配置即时下发给后端（不中断当前 turn）。
    // 只下发实际变化了的字段，避免无谓的 SDK control 请求。
    if (messageStore.isRunning && messageStore.currentTurnId && oldCfg) {
      const supportsHotSwap = backendStore.current?.capabilities.supportsHotSwap
      if (!supportsHotSwap) return
      const turnId = messageStore.currentTurnId
      const update: TurnConfigUpdate = {}
      if (cfg.model && cfg.model !== oldCfg.model) update.model = cfg.model
      if (cfg.effort && cfg.effort !== oldCfg.effort) update.effort = cfg.effort
      if (cfg.permissionMode !== oldCfg.permissionMode) {
        update.permissionMode = cfg.permissionMode
      }
      if (Object.keys(update).length > 0) {
        window.api.backend
          .updateTurnConfig({ turnId, config: update })
          .catch((e) => console.warn('[ChatView] updateTurnConfig failed:', e))
      }
    }
  },
  { deep: true },
)

async function onSend(text: string, attachments: ContextBlock[]): Promise<void> {
  if ((!text.trim() && attachments.length === 0) || !workspaceStore.currentWorkspace) return

  // 运行中再次发送不是新开并发 turn，而是 steer 到当前 turn。
  // 协调器仍保持同 session 单 active turn；用户补充要求会进入当前 backend 的输入流。
  if (messageStore.isRunning && messageStore.currentTurnId) {
    if (!backendStore.current?.capabilities.supportsSteer) return
    const activeTurnId = messageStore.currentTurnId
    messageStore.pushUserMessage(
      activeTurnId,
      text,
      attachments.length > 0 ? attachments : undefined,
    )
    await window.api.backend.steerTurn({
      turnId: activeTurnId,
      prompt: serializeContextTags(text, attachments),
    })
    return
  }

  const model = runtimeConfig.value.model
  const effort = runtimeConfig.value.effort

  // 如果还没 session，先创建
  let sessionId = sessionStore.currentSession?.id
  if (!sessionId) {
    const selectionVersionBeforeCreate = sessionStore.selectionVersion
    // observability：currentSessionId 被设过但找不到对应 session——这是可疑状态
    // （可能是 selectSession race / store 不一致），但为了不阻塞用户发消息仍然创建。
    // 真正的新建场景（点"新建会话"按钮 / 切 backend tab）currentSessionId === null/''。
    if (sessionStore.currentSessionId !== null && sessionStore.currentSessionId !== '') {
      console.error(
        '[onSend] currentSessionId set but session not found, creating new session anyway. currentSessionId=',
        sessionStore.currentSessionId,
        'sessions=',
        sessionStore.sessions.map((s) => s.id),
      )
    }
    const createArgs: Parameters<typeof sessionStore.create>[0] = {
      workspaceId: workspaceStore.currentWorkspace.id,
      cwd: workspaceStore.currentWorkspace.path,
      // 显式传 backend——避免依赖 main 端默认值（getCurrentId）。
      // 切 backend 后 ChatView 应该以新 backend 创建会话。
      backend: backendStore.currentId,
      permissionMode: runtimeConfig.value.permissionMode,
      // 第一条消息作为 initialPrompt——main handler 会 slice(0,50) 写入 db 的 title 字段，
      // 侧边栏立即显示这条消息的开头，不再显示 "(新会话)"。
      initialPrompt: text,
    }
    if (model !== null) createArgs.model = model
    if (effort !== null) createArgs.effort = effort
    sessionId = await sessionStore.create(createArgs)
    // 创建期间用户可能已经点了“新建会话”或选择了别的历史会话。
    // 只有选择版本没变化时才自动进入刚创建的 session；无论是否仍选中，
    // 本次发送后续都固定写入局部 sessionId，不会污染当前页面。
    if (sessionStore.selectionVersion === selectionVersionBeforeCreate) {
      sessionStore.setCurrent(sessionId)
      // messageStore 的 currentSessionId 跟 sessionStore 是两套 ref——
      // 当前页面仍是原 draft 时同步选中刚创建的 session。
      messageStore.setCurrentSession(sessionId)
    }
  }

  // 找 backendThreadId（session.detail 已经能拿到；MVP 简化：直接用 backendThreadId 字段）
  const session = sessionStore.sessions.find((s) => s.id === sessionId)
  if (!session) return

  // 推用户消息到 UI（带 contextBlocks，UI 渲染对应 tag 卡片）
  const turnId = randomUUID()
  // /compact 特殊处理：不展示 /compact 用户消息气泡，改为在消息流末尾插入
  // "正在压缩上下文 / 上下文已压缩"分隔线。turn_completed 时自动从呼吸切到静态。
  // 严格匹配 trim 后的 /compact——带参数的（/compact focus on X）走普通消息。
  if (text.trim() === '/compact') {
    messageStore.startCompactForSession(sessionId, turnId)
  } else {
    messageStore.pushUserMessageToSession(
      sessionId,
      turnId,
      text,
      attachments.length > 0 ? attachments : undefined,
    )
  }

  // 乐观标记 turn 已开始——发消息后立刻让 UI 进入"agent 正在干活"状态
  // （底部 loading 指示器、Composer 停止按钮），不用等 backend 的 turn_started
  // 事件（网络/进程启动有数百 ms ~ 数秒延迟，期间没有任何反馈）。
  // 后续真正的 turn_started 会覆盖；turn_completed / error 会复位，不会卡死。
  messageStore.markTurnStarting(sessionId, turnId)

  // 发给后端的完整 prompt：把 attachments 序列化成 sentinel 标签拼到文本里
  // 后端 adapter 收到的是单字符串，原样发给 claude/codex（不用改 adapter 契约）
  const fullPrompt = serializeContextTags(text, attachments)

  // 启动 turn（sessionId 字段实际传 backendThreadId 给 backend）
  // cwd 必须传——claude adapter 用它作为 spawn cwd（per-turn process 模型）。
  // clientSessionId 传 catmax 的 session.id——manager.ts 用它做 envelope 路由
  // （renderer 的 messageStore 按 clientSessionId 把流式 events 累积到对应 session）。
  // 不能复用 sessionId：backendThreadId 跟 catmax session.id 不是同一个 key，
  // applyEvent 会路由到不存在的 session 导致流式输出看不到。
  const startArgs: Parameters<typeof window.api.backend.startTurn>[0] = {
    clientTurnId: turnId,
    sessionId: session.backendThreadId,
    clientSessionId: sessionId,
    prompt: fullPrompt,
    permissionMode: runtimeConfig.value.permissionMode,
    cwd: workspaceStore.currentWorkspace.path,
  }
  if (model !== null) startArgs.model = model
  if (effort !== null) startArgs.effort = effort
  await window.api.backend.startTurn(startArgs)
}
</script>

<style scoped>
/* Sidebar Peek: 浮层从左边缘滑入/滑出，配合 200ms 的侧栏折叠动画节奏。 */
.sidebar-peek-enter-active,
.sidebar-peek-leave-active {
  transition:
    transform 200ms ease,
    opacity 200ms ease;
}

.sidebar-peek-enter-from,
.sidebar-peek-leave-to {
  transform: translateX(-100%);
  opacity: 0;
}

/* Sidebar Overlay: 窄窗口下展开侧栏的浮层，同样从左边缘滑入/滑出。 */
.sidebar-overlay-enter-active,
.sidebar-overlay-leave-active {
  transition:
    transform 200ms ease,
    opacity 200ms ease;
}

.sidebar-overlay-enter-from,
.sidebar-overlay-leave-to {
  transform: translateX(-100%);
  opacity: 0;
}

/* Right Panel Overlay: 浮层从右边缘滑入/滑出，跟侧栏 peek 同一套节奏。 */
.right-panel-overlay-enter-active,
.right-panel-overlay-leave-active {
  transition:
    transform 200ms ease,
    opacity 200ms ease;
}

.right-panel-overlay-enter-from,
.right-panel-overlay-leave-to {
  transform: translateX(100%);
  opacity: 0;
}

/* New Session Welcome: 克制的中心光晕把品牌 Logo 融入空状态，不制造厚重卡片边界。 */
.new-session {
  position: relative;
  overflow: hidden;
}

.new-session::before {
  position: absolute;
  width: min(520px, 72%);
  aspect-ratio: 1;
  border-radius: 9999px;
  background: radial-gradient(
    circle,
    color-mix(in oklch, var(--foreground) 5%, transparent) 0,
    color-mix(in oklch, var(--foreground) 2%, transparent) 42%,
    transparent 72%
  );
  content: '';
  pointer-events: none;
}
</style>
