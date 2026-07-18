<template>
  <div class="h-full flex">
    <!-- 侧边栏 -->
    <Sidebar />

    <!-- 主聊天区 -->
    <div class="flex-1 flex flex-col min-w-0">
      <RuntimeConfigBar :model-value="runtimeConfig" @update:model-value="runtimeConfig = $event" />

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

      <Composer :disabled="!backendStore.isAvailable" @send="onSend" />
    </div>
  </div>
</template>

<script setup lang="ts">
import ApprovalDialog from '@renderer/components/chat/ApprovalDialog.vue'
import Composer from '@renderer/components/chat/Composer.vue'
import MessageList from '@renderer/components/chat/MessageList.vue'
import RuntimeConfigBar from '@renderer/components/chat/RuntimeConfigBar.vue'
import Sidebar from '@renderer/components/sidebar/Sidebar.vue'
import { useStreamMessage } from '@renderer/composables/useStreamMessage'
import { randomUUID } from '@renderer/lib/utils'
import { useBackendStore } from '@renderer/stores/backend'
import { useMessageStore } from '@renderer/stores/message'
import { useSessionStore } from '@renderer/stores/session'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { EffortLevel, PermissionMode } from '@shared/backend/types'
import { ref, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const workspaceStore = useWorkspaceStore()
const backendStore = useBackendStore()
const sessionStore = useSessionStore()
const messageStore = useMessageStore()
useStreamMessage()

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

async function onSend(text: string): Promise<void> {
  if (!text.trim() || !workspaceStore.currentWorkspace) return

  const model = runtimeConfig.value.model
  const effort = runtimeConfig.value.effort

  // 如果还没 session，先创建
  let sessionId = sessionStore.currentSession?.id
  if (!sessionId) {
    const createArgs: Parameters<typeof sessionStore.create>[0] = {
      workspaceId: workspaceStore.currentWorkspace.id,
      cwd: workspaceStore.currentWorkspace.path,
      permissionMode: runtimeConfig.value.permissionMode,
    }
    if (model !== null) createArgs.model = model
    if (effort !== null) createArgs.effort = effort
    sessionId = await sessionStore.create(createArgs)
    sessionStore.setCurrent(sessionId)
  }

  // 找 backendThreadId（session.detail 已经能拿到；MVP 简化：直接用 backendThreadId 字段）
  const session = sessionStore.sessions.find((s) => s.id === sessionId)
  if (!session) return

  // 推用户消息到 UI
  const turnId = randomUUID()
  messageStore.pushUserMessage(turnId, text)

  // 启动 turn（sessionId 字段实际传 backendThreadId 给 backend）
  const startArgs: Parameters<typeof window.api.backend.startTurn>[0] = {
    sessionId: session.backendThreadId,
    prompt: text,
    permissionMode: runtimeConfig.value.permissionMode,
  }
  if (model !== null) startArgs.model = model
  if (effort !== null) startArgs.effort = effort
  await window.api.backend.startTurn(startArgs)
}
</script>
