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

    <!-- 主聊天区 -->
    <div class="flex-1 flex flex-col min-w-0">
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
        底部交互区：有 pending 权限时显示 PermissionPanel（覆盖输入框位置，
        让聊天记录始终可见），否则显示 Composer。
        claude 权限（pendingClaudePermission）和 codex 权限（pendingApproval）
        都走同一个 PermissionPanel。同一时刻只一个 backend 在跑 turn。
      -->
      <PermissionPanel
        v-if="messageStore.pendingApproval || messageStore.pendingClaudePermission"
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
      :min="RIGHT_PANEL_MIN"
      :max="rightPanelMax"
      :current="uiStore.rightPanelWidth"
      @resize="uiStore.setRightPanelWidth"
    />
    <RightPanel v-if="uiStore.rightPanelVisible" />
  </div>
</template>

<script setup lang="ts">
import BottomTerminalPanel from '@renderer/components/chat/BottomTerminalPanel.vue'
import Composer from '@renderer/components/chat/Composer.vue'
import MessageList from '@renderer/components/chat/MessageList.vue'
import PermissionPanel from '@renderer/components/chat/PermissionPanel.vue'
import RuntimeConfigBar from '@renderer/components/chat/RuntimeConfigBar.vue'
import RightPanel from '@renderer/components/panel/RightPanel.vue'
import Sidebar from '@renderer/components/sidebar/Sidebar.vue'
import ResizeHandle from '@renderer/components/ui/ResizeHandle.vue'
import { useStreamMessage } from '@renderer/composables/useStreamMessage'
import { randomUUID } from '@renderer/lib/utils'
import { useBackendStore } from '@renderer/stores/backend'
import { useGitStore } from '@renderer/stores/git'
import { useMessageStore } from '@renderer/stores/message'
import { useSessionStore } from '@renderer/stores/session'
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
const sessionStore = useSessionStore()
const messageStore = useMessageStore()
const gitStore = useGitStore()
const uiStore = useUiStore()
useStreamMessage()

// 侧栏可拖拽宽度--min 为当前默认宽度，max 为容器一半（即最大 1:1 与聊天区同宽）
const SIDEBAR_MIN = 280
const RIGHT_PANEL_MIN = 320
// 底部终端面板可拖拽高度——min 保证终端至少能显示几行，max 不超过容器 70%（留空间给聊天区）
const BOTTOM_PANEL_MIN = 120
const containerRef = ref<HTMLElement | null>(null)
const containerWidth = ref(Number.POSITIVE_INFINITY)
const containerHeight = ref(Number.POSITIVE_INFINITY)

const sidebarMax = computed(() => Math.max(SIDEBAR_MIN, Math.floor(containerWidth.value / 2)))
const rightPanelMax = computed(() =>
  Math.max(RIGHT_PANEL_MIN, Math.floor(containerWidth.value / 2)),
)
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

  // 从 last-used 恢复 runtimeConfig——新建会话默认从这里取。
  // permissionMode 兜底成 'default'；backend 兜底成 currentId。
  try {
    const last = await window.api.session.getLastRuntimeConfig()
    if (last) {
      isRestoring.value = true
      runtimeConfig.value = {
        backend: last.backend,
        model: last.model,
        effort: last.effort,
        permissionMode: last.permissionMode ?? 'default',
      }
      isRestoring.value = false
    }
  } catch (e) {
    console.warn('[ChatView] load last runtime config failed:', e)
  }

  // 若 last-used 的 backend 跟当前后端不一致，切过去。
  if (runtimeConfig.value.backend !== backendStore.currentId) {
    try {
      await backendStore.switchTo(runtimeConfig.value.backend)
    } catch (e) {
      console.warn('[ChatView] switch to last-used backend failed:', e)
      runtimeConfig.value.backend = backendStore.currentId
    }
  }

  await backendStore.loadModels()
  await sessionStore.load(workspaceStore.currentWorkspace.id)

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
  },
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
