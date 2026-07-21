<template>
  <div class="p-2 flex flex-col h-full">
    <!-- 当前工作区不存在时 -->
    <div
      v-if="!workspaceStore.currentWorkspace"
      class="text-center text-xs text-muted-foreground py-8"
    >
      请先选择工作区
    </div>

    <template v-else>
      <!-- 顶部：新建会话 + 扫描导入按钮 -->
      <div class="flex gap-1.5 mb-2">
        <button
          class="flex-1 px-3 py-2 text-sm text-primary hover:bg-muted rounded-md flex items-center gap-2 border border-sidebar-border"
          @click="newSession"
        >
          <PlusIcon class="w-4 h-4" />
          新建会话
        </button>
        <button
          class="px-2.5 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded-md border border-sidebar-border"
          title="扫描磁盘/RPC 上已存在但还没纳入 catmax 的 claude/codex 会话"
          @click="importDialogOpen = true"
        >
          <DownloadIcon class="w-4 h-4" />
        </button>
      </div>

      <!-- backend tab —— 切 tab = 筛选该 backend 的会话 + 切换当前后端 -->
      <div class="flex border-b border-sidebar-border mb-2">
        <button
          v-for="id in BACKEND_IDS"
          :key="id"
          type="button"
          :disabled="!isBackendAvailable(id)"
          :class="[
            'flex-1 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors capitalize',
            backendStore.currentId === id
              ? 'border-primary text-foreground'
              : 'border-transparent text-muted-foreground hover:text-foreground',
            !isBackendAvailable(id) ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
          ]"
          :title="backendTabTooltip(id)"
          @click="switchBackendTab(id)"
        >
          {{ id }}
          <span class="ml-1 text-[10px] opacity-60">({{ sessionStore.countByBackend[id] }})</span>
        </button>
      </div>

      <!-- 当前 backend 的会话列表 -->
      <div class="flex-1 overflow-y-auto">
        <SessionItem
          v-for="session in currentBackendSessions"
          :key="session.id"
          :session="session"
          :active="session.id === sessionStore.currentSessionId"
          @click="selectSession(session.id)"
          @remove="removeSession(session.id)"
        />

        <!-- 空状态 -->
        <div
          v-if="currentBackendSessions.length === 0"
          class="text-center text-xs text-muted-foreground py-8"
        >
          没有 {{ backendStore.currentId }} 会话
        </div>
      </div>
    </template>

    <!-- 「扫描导入」对话框 -->
    <ImportSessionsDialog v-if="importDialogOpen" @close="onImportDialogClose" />
  </div>
</template>

<script setup lang="ts">
import { explainBackendError } from '@renderer/lib/backend-error'
import { useBackendStore } from '@renderer/stores/backend'
import { useMessageStore } from '@renderer/stores/message'
import { useSessionStore } from '@renderer/stores/session'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { BACKEND_IDS, type BackendId } from '@shared/constants'
import { DownloadIcon, PlusIcon } from 'lucide-vue-next'
import { computed, onMounted, ref, watch } from 'vue'

import ImportSessionsDialog from './ImportSessionsDialog.vue'
import SessionItem from './SessionItem.vue'

const workspaceStore = useWorkspaceStore()
const sessionStore = useSessionStore()
const backendStore = useBackendStore()

/** 「扫描导入」对话框显隐——点按钮打开，dialog 关闭时刷新会话列表 */
const importDialogOpen = ref(false)
const messageStore = useMessageStore()

/** 当前 backend tab 下的会话——直接按 session.backend 筛选，不依赖 continuable 字段 */
const currentBackendSessions = computed(
  () => sessionStore.sessionsByBackend[backendStore.currentId] ?? [],
)

function backendStatus(id: BackendId) {
  return backendStore.statuses.find((s) => s.id === id)
}

function isBackendAvailable(id: BackendId): boolean {
  return backendStatus(id)?.available ?? false
}

/**
 * tab 的 tooltip——可用时显示版本，不可用时显示错误简述+修复指引。
 * 因为底部 BackendIndicator 已删，这是用户看到 backend 不可用原因的唯一入口。
 */
function backendTabTooltip(id: BackendId): string {
  const status = backendStatus(id)
  if (!status) return id
  if (status.available) return `${id} (${status.version ?? 'unknown'})`
  const info = explainBackendError(status.error)
  let text = `${id} 不可用：${info.title}\n${info.detail}`
  if (info.fix && info.fix.length > 0) {
    text += '\n\n修复步骤：\n' + info.fix.map((s) => `  · ${s}`).join('\n')
  }
  return text
}

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

/**
 * 切 backend tab——直接切，不弹窗。
 * 用户点 tab 意图明确（就是想看那个 backend 的会话）。
 * 弹窗只在底部 BackendIndicator 主动切换时才有——但现在底部切换器删了。
 */
async function switchBackendTab(id: BackendId): Promise<void> {
  if (id === backendStore.currentId) return
  if (!isBackendAvailable(id)) return
  // 切 backend 会清掉所有会话上下文（不同 backend 的 session 状态不混用）
  await backendStore.switchTo(id)
  sessionStore.setCurrent('')
  messageStore.resetAll()
}

/**
 * 点历史会话——切到该会话的 backend（不弹窗），再加载历史。
 *
 * 必须切 backend 的原因：startTurn 用当前 backend 的 adapter 调
 * backendThreadId，如果 session.backend ≠ currentBackend，必然失败
 * （codex 的 thread id 在 claude 那边不存在，反之亦然）。
 *
 * 不调 reset——切 session 保留各 session 的状态（多 turn 并发隔离）。
 * loadHistory 的 setMessages 只覆盖当前 session 的 messages。
 */
async function selectSession(id: string): Promise<void> {
  const session = sessionStore.sessions.find((s) => s.id === id)
  if (!session) return
  if (session.backend !== backendStore.currentId) {
    if (!isBackendAvailable(session.backend)) {
      // 极端情况：会话所属 backend 不可用——不让选
      return
    }
    await backendStore.switchTo(session.backend)
  }
  sessionStore.setCurrent(id)
  messageStore.setCurrentSession(id)
  await sessionStore.loadHistory(id)
}

async function removeSession(id: string): Promise<void> {
  if (!window.confirm('删除此会话？')) return
  // 清理被删 session 的状态（防止内存泄漏）
  messageStore.clearSession(id)
  await sessionStore.remove(id)
}

function newSession(): void {
  sessionStore.setCurrent('')
  messageStore.setCurrentSession(null)
}

/**
 * 「扫描导入」对话框关闭时刷新当前 workspace 的 session 列表——
 * 即使没有导入任何东西也刷新一下（用户可能用了"用此路径新建工作区"，
 * workspaces 列表变了，重 load 一下让 badge 数字对齐）。
 */
async function onImportDialogClose(): Promise<void> {
  importDialogOpen.value = false
  if (workspaceStore.currentWorkspace) {
    await sessionStore.load(workspaceStore.currentWorkspace.id)
  }
}
</script>
