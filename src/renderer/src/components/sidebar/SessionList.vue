<template>
  <div class="p-2">
    <!-- 当前工作区不存在时 -->
    <div
      v-if="!workspaceStore.currentWorkspace"
      class="text-center text-xs text-muted-foreground py-8"
    >
      请先选择工作区
    </div>

    <template v-else>
      <!-- 可继续区 -->
      <div v-if="sessionsByBackend.continuable.length > 0" class="mb-4">
        <div class="text-xs font-medium text-muted-foreground px-2 mb-1 uppercase tracking-wide">
          {{ backendStore.currentId }} · 可继续
        </div>
        <SessionItem
          v-for="session in sessionsByBackend.continuable"
          :key="session.id"
          :session="session"
          :active="session.id === sessionStore.currentSessionId"
          @click="selectSession(session.id)"
          @remove="removeSession(session.id)"
        />
      </div>

      <!-- 其他后端只读区 -->
      <details v-if="sessionsByBackend.readonly.length > 0" class="mb-2">
        <summary
          class="text-xs font-medium text-muted-foreground px-2 py-1 cursor-pointer hover:text-foreground"
        >
          其他后端 · 只读 ({{ sessionsByBackend.readonly.length }})
        </summary>
        <SessionItem
          v-for="session in sessionsByBackend.readonly"
          :key="session.id"
          :session="session"
          :active="session.id === sessionStore.currentSessionId"
          readonly
          @click="selectSession(session.id)"
          @remove="removeSession(session.id)"
        />
      </details>

      <!-- 新建会话按钮 -->
      <button
        class="w-full mt-2 px-3 py-2 text-sm text-primary hover:bg-muted rounded-md flex items-center gap-2"
        @click="newSession"
      >
        <PlusIcon class="w-4 h-4" />
        新建会话
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useBackendStore } from '@renderer/stores/backend'
import { useMessageStore } from '@renderer/stores/message'
import { useSessionStore } from '@renderer/stores/session'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { PlusIcon } from 'lucide-vue-next'
import { computed, onMounted, watch } from 'vue'

import SessionItem from './SessionItem.vue'

const workspaceStore = useWorkspaceStore()
const sessionStore = useSessionStore()
const backendStore = useBackendStore()
const messageStore = useMessageStore()

const sessionsByBackend = computed(() => sessionStore.sessionsByBackend)

onMounted(async () => {
  if (workspaceStore.currentWorkspace) {
    await sessionStore.load(workspaceStore.currentWorkspace.id)
    await sessionStore.reconcile(workspaceStore.currentWorkspace.id)
  }
})

// 切工作区时重新加载
watch(
  () => workspaceStore.currentWorkspace?.id,
  async (id) => {
    if (id) {
      await sessionStore.load(id)
      await sessionStore.reconcile(id)
    }
  },
)

async function selectSession(id: string): Promise<void> {
  sessionStore.setCurrent(id)
  messageStore.reset()
  await sessionStore.loadHistory(id)
}

async function removeSession(id: string): Promise<void> {
  if (!window.confirm('删除此会话？')) return
  await sessionStore.remove(id)
}

async function newSession(): Promise<void> {
  sessionStore.setCurrent('')
  messageStore.reset()
}
</script>
