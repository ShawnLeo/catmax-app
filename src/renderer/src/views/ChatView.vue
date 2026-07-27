<template>
  <div ref="containerRef" class="h-full flex relative">
    <!-- 侧边栏（始终挂载，折叠通过宽度 0 过渡，见 Sidebar.vue） -->
    <Sidebar />
    <ResizeHandle
      v-if="!uiStore.sidebarCollapsed"
      side="left"
      :min="SIDEBAR_MIN"
      :max="sidebarMax"
      :current="uiStore.sidebarWidth"
      @resize="uiStore.setSidebarWidth"
    />

    <!-- 主聊天区:用具体 min-width 而非 min-w-0,防止被右面板挤压到低于 250px。
         sidebar 折叠时宽度为 0,不占空间;展开时由 ResizeHandle clamp 在 [SIDEBAR_MIN, 容器一半],
         加上这里的 min-w 保证主聊天区 + sidebar 不会被右面板挤没。 -->
    <div class="flex-1 flex flex-col min-w-[250px]">
      <RuntimeConfigBar />

      <MessageList
        v-if="messageStore.messages.length > 0"
        class="flex-1"
        :show-thinking="runtimeConfig.effort !== 'none'"
      />
      <div v-else class="flex-1 flex items-center justify-center text-muted-foreground">
        <div class="text-center">
          <p class="text-lg font-medium text-foreground">开始新对话</p>
          <p class="text-sm mt-2">
            在工作区 {{ workspaceStore.currentWorkspace?.name }} 里发条消息
          </p>
          <p class="text-xs mt-1">使用 {{ backendStore.currentId }} 后端</p>
        </div>
      </div>

      <!--
        底部交互区三选一（同一时刻只一个，都覆盖 Composer 位置，让聊天记录可见）：
        1. agent 问题（pendingAgentQuestion）→ QuestionPanel（claude 调 ask_user 工具）
        2. 权限确认（pendingApproval / pendingClaudePermission）→ PermissionPanel
        3. 都没有 → Composer 正常输入
      -->
      <QuestionPanel v-if="messageStore.pendingAgentQuestion" />
      <PermissionPanel
        v-else-if="messageStore.pendingApproval || messageStore.pendingClaudePermission"
      />
      <Composer
        v-else
        :disabled="!backendStore.isAvailable"
        :model-value="composerModelValue"
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

    <!-- 右栏面板 -->
    <ResizeHandle
      v-if="uiStore.rightPanelVisible"
      side="right"
      :min="rightPanelMin"
      :max="rightPanelMax"
      :current="rightPanelCurrent"
      @resize="resizeRightPanel"
    />
    <RightPanel />
  </div>
</template>

<script setup lang="ts">
import Composer from '@renderer/components/chat/composer/Composer.vue'
import PermissionPanel from '@renderer/components/chat/feedback/PermissionPanel.vue'
import QuestionPanel from '@renderer/components/chat/feedback/QuestionPanel.vue'
import BottomTerminalPanel from '@renderer/components/chat/layout/BottomTerminalPanel.vue'
import RuntimeConfigBar from '@renderer/components/chat/layout/RuntimeConfigBar.vue'
import MessageList from '@renderer/components/chat/messages/MessageList.vue'
import RightPanel from '@renderer/components/panel/RightPanel.vue'
import Sidebar from '@renderer/components/sidebar/Sidebar.vue'
import ResizeHandle from '@renderer/components/ui/ResizeHandle.vue'
import { useStreamMessage } from '@renderer/composables/useStreamMessage'
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
import type { BackendId } from '@shared/constants'
import type { RuntimeConfigSnapshot } from '@shared/ipc/session'
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

// 侧栏可拖拽宽度--min 为当前默认宽度，max 为容器一半（即最大 1:1 与聊天区同宽）
const SIDEBAR_MIN = 280
const RIGHT_PANEL_MIN = 320
const FILE_PREVIEW_MIN = 360
const FILE_PREVIEW_SPLIT_HANDLE_WIDTH = 1
// 主聊天区最小宽度——右面板拖宽时不能把聊天区挤到低于此值。
// 250px 保证 textarea + 发送按钮至少能正常显示,再加窄就失去可用性。
const CHAT_AREA_MIN = 250
// 底部终端面板可拖拽高度——min 保证终端至少能显示几行，max 不超过容器 70%（留空间给聊天区）
const BOTTOM_PANEL_MIN = 120
const containerRef = ref<HTMLElement | null>(null)
const containerWidth = ref(Number.POSITIVE_INFINITY)
const containerHeight = ref(Number.POSITIVE_INFINITY)

const sidebarMax = computed(() => Math.max(SIDEBAR_MIN, Math.floor(containerWidth.value / 2)))

// File Preview Layout: 右侧拖拽目标是“预览 + 文件树”的组合宽度。
const filePreviewOpen = computed(
  () =>
    uiStore.rightPanelTab === 'files' &&
    filesStore.previewTabs.length > 0 &&
    uiStore.filePreviewVisible,
)
const fileTreeOpen = computed(
  () =>
    uiStore.rightPanelTab !== 'files' ||
    uiStore.fileTreeVisible ||
    filesStore.previewTabs.length === 0,
)
const rightPanelCurrent = computed(() => {
  if (filePreviewOpen.value && fileTreeOpen.value) {
    return uiStore.rightPanelWidth + uiStore.filePreviewWidth + FILE_PREVIEW_SPLIT_HANDLE_WIDTH
  }
  return filePreviewOpen.value ? uiStore.filePreviewWidth : uiStore.rightPanelWidth
})
const rightPanelMin = computed(() => (filePreviewOpen.value ? FILE_PREVIEW_MIN : RIGHT_PANEL_MIN))
const rightPanelMax = computed(() => {
  // 右面板最大值受「主聊天区最小宽度」约束:
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
        containerWidth.value = entry.contentRect.width
        containerHeight.value = entry.contentRect.height
      }
    })
    resizeObserver.observe(containerRef.value)
  }
})
onUnmounted(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

function resizeRightPanel(width: number): void {
  // File Preview Layout: 文件树宽度保持稳定，预览打开时只调整它左侧的预览区域。
  if (filePreviewOpen.value && fileTreeOpen.value) {
    uiStore.setFilePreviewWidth(width - uiStore.rightPanelWidth - FILE_PREVIEW_SPLIT_HANDLE_WIDTH)
  } else if (filePreviewOpen.value) {
    uiStore.setFilePreviewWidth(width)
  } else {
    uiStore.setRightPanelWidth(width)
  }
}

watch([filePreviewOpen, rightPanelMax], ([previewOpen, maxWidth]) => {
  if (previewOpen && rightPanelCurrent.value > maxWidth) {
    uiStore.setFilePreviewWidth(Math.max(FILE_PREVIEW_MIN, maxWidth - uiStore.rightPanelWidth))
  }
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

  const model = runtimeConfig.value.model
  const effort = runtimeConfig.value.effort

  // 如果还没 session，先创建
  let sessionId = sessionStore.currentSession?.id
  if (!sessionId) {
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
    sessionStore.setCurrent(sessionId)
    // messageStore 的 currentSessionId 跟 sessionStore 是两套 ref——
    // 必须同时设，否则后续 pushUserMessage / 流式 events 都路由不到正确 session。
    messageStore.setCurrentSession(sessionId)
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
    messageStore.startCompact(turnId)
  } else {
    messageStore.pushUserMessage(turnId, text, attachments.length > 0 ? attachments : undefined)
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
