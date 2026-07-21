<template>
  <div class="h-full flex relative">
    <!-- 侧边栏 -->
    <Sidebar />

    <!-- 主聊天区 -->
    <div class="flex-1 flex flex-col min-w-0">
      <RuntimeConfigBar />

      <MessageList v-if="messageStore.messages.length > 0" class="flex-1" />
      <div v-else class="flex-1 flex items-center justify-center text-muted-foreground">
        <div class="text-center">
          <p class="text-lg font-medium text-foreground">开始新对话</p>
          <p class="text-sm mt-2">
            在工作区 {{ workspaceStore.currentWorkspace?.name }} 里发条消息
          </p>
          <p class="text-xs mt-1">使用 {{ backendStore.currentId }} 后端</p>
        </div>
      </div>

      <ApprovalDialog v-if="messageStore.pendingApproval" />

      <!--
        Claude 权限请求 dialog——claude 通过内置 MCP server 的权限请求触发
        （--permission-prompt-tool = mcp__catmax__approve）。
        跟 codex 的 ApprovalDialog 互斥显示（同一时刻只一个 backend 在跑 turn）。
      -->
      <ClaudePermissionDialog v-if="messageStore.pendingClaudePermission" />

      <!--
        AskUserQuestion 弹窗——claude 调 AskUserQuestion 时弹出。
        pendingQuestion 由 backend 推 ask_user_question TurnEvent 设置。
        提交时把答案拼成自然语言，复用 onSend 当新用户消息发下一轮 turn
        （claude -p 模式不接受外部 tool_result 回写，只能走新 turn --resume）。
      -->
      <AskUserQuestionDialog
        v-if="messageStore.pendingQuestion"
        @submit="onAskUserQuestionSubmit"
        @cancel="onAskUserQuestionCancel"
      />

      <Composer :disabled="!backendStore.isAvailable" v-model="runtimeConfig" @send="onSend" />
    </div>

    <!-- 右栏切换按钮（floating） -->
    <button
      class="absolute top-2 right-2 z-10 p-1.5 rounded-md bg-background/80 hover:bg-muted text-muted-foreground hover:text-foreground"
      title="切换右栏"
      @click="uiStore.toggleRightPanel()"
    >
      <PanelRightIcon class="w-4 h-4" />
    </button>

    <!-- 右栏面板 -->
    <RightPanel :visible="uiStore.rightPanelVisible" />
  </div>
</template>

<script setup lang="ts">
import ApprovalDialog from '@renderer/components/chat/ApprovalDialog.vue'
import AskUserQuestionDialog from '@renderer/components/chat/AskUserQuestionDialog.vue'
import ClaudePermissionDialog from '@renderer/components/chat/ClaudePermissionDialog.vue'
import Composer from '@renderer/components/chat/Composer.vue'
import MessageList from '@renderer/components/chat/MessageList.vue'
import RuntimeConfigBar from '@renderer/components/chat/RuntimeConfigBar.vue'
import RightPanel from '@renderer/components/panel/RightPanel.vue'
import Sidebar from '@renderer/components/sidebar/Sidebar.vue'
import { useStreamMessage } from '@renderer/composables/useStreamMessage'
import { randomUUID } from '@renderer/lib/utils'
import { useBackendStore } from '@renderer/stores/backend'
import { useGitStore } from '@renderer/stores/git'
import { useMessageStore } from '@renderer/stores/message'
import { useSessionStore } from '@renderer/stores/session'
import { useUiStore } from '@renderer/stores/ui'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { serializeContextTags } from '@shared/backend/context-tags'
import type { ContextBlock, EffortLevel, PermissionMode } from '@shared/backend/types'
import { PanelRightIcon } from 'lucide-vue-next'
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const workspaceStore = useWorkspaceStore()
const backendStore = useBackendStore()
const sessionStore = useSessionStore()
const messageStore = useMessageStore()
const gitStore = useGitStore()
const uiStore = useUiStore()
useStreamMessage()

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

interface RuntimeConfig {
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode
}

const runtimeConfig = ref<RuntimeConfig>({
  model: null,
  effort: 'medium',
  permissionMode: 'default',
})

onMounted(async () => {
  if (!workspaceStore.currentWorkspace) {
    router.push('/')
    return
  }
  await backendStore.refresh()
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

// 切换 backend 时清空 model selection——不同 backend 的 model id 不互通
// （比如 claude 的 'sonnet' 传给 codex 会报 "The 'sonnet' model is not supported
// when using Codex with a ChatGPT account"）。清空后上面的 watch 会从新 backend
// 的 models 列表重新挑一个默认。
watch(
  () => backendStore.currentId,
  () => {
    runtimeConfig.value.model = null
  },
)

async function onSend(text: string, attachments: ContextBlock[]): Promise<void> {
  if ((!text.trim() && attachments.length === 0) || !workspaceStore.currentWorkspace) return

  const model = runtimeConfig.value.model
  const effort = runtimeConfig.value.effort

  // 如果还没 session，先创建
  let sessionId = sessionStore.currentSession?.id
  if (!sessionId) {
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
  messageStore.pushUserMessage(turnId, text, attachments.length > 0 ? attachments : undefined)

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

/**
 * AskUserQuestion 弹窗提交——把答案拼成的自然语言当作新用户消息发下一轮 turn。
 * claude -p 模式硬编码拒绝外部对 AskUserQuestion 的 tool_result 回应（实测过），
 * 没法在同一 turn 进程内回写答案，所以走新一轮 turn + --resume 继续。
 */
async function onAskUserQuestionSubmit(text: string): Promise<void> {
  messageStore.pendingQuestion = null
  await onSend(text, [])
}

/** AskUserQuestion 弹窗取消——清 pendingQuestion，不发任何消息。 */
function onAskUserQuestionCancel(): void {
  messageStore.pendingQuestion = null
}
</script>
