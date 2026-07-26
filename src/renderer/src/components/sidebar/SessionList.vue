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
      <!-- 会话操作：主按钮保持强视觉层级，导入和刷新作为紧凑的次级操作 -->
      <div class="mb-2 flex items-center gap-1 rounded-lg bg-sidebar-accent/70 p-1">
        <button
          class="group flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-background/40 cursor-pointer"
          @click="newSession"
        >
          <span
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-foreground text-background shadow-sm transition-transform group-active:scale-95"
          >
            <PlusIcon class="h-3.5 w-3.5" stroke-width="2.5" />
          </span>
          <span class="truncate">新建会话</span>
        </button>
        <button
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/40 hover:text-foreground cursor-pointer"
          title="扫描磁盘/RPC 上已存在但还没纳入 catmax 的 claude/codex 会话"
          aria-label="导入会话"
          @click="importDialogOpen = true"
        >
          <FileInputIcon class="w-4 h-4" />
        </button>
        <button
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
          title="刷新当前工作区会话"
          aria-label="刷新当前工作区会话"
          :disabled="refreshingSessions"
          @click="refreshSessions"
        >
          <RefreshCwIcon class="w-4 h-4" :class="{ 'animate-spin': refreshingSessions }" />
        </button>
      </div>

      <!-- 会话列表——按 lastActiveAt 倒序混排（DB 已 ORDER BY last_active_at DESC），
           用 SessionItem 左侧的 backend 图标区分 codex / claude -->
      <div class="flex-1 overflow-y-auto">
        <SessionItem
          v-for="session in sessionStore.sessions"
          :key="session.id"
          :session="session"
          :backend="session.backend"
          :active="session.id === sessionStore.currentSessionId"
          :running="isSessionRunning(session.id)"
          :unread-activity="hasUnreadActivity(session.id)"
          @click="selectSession(session.id)"
          @remove="removeSession(session.id)"
        />

        <!-- 空状态 -->
        <div
          v-if="sessionStore.sessions.length === 0"
          class="text-center text-xs text-muted-foreground py-8"
        >
          暂无会话
        </div>
      </div>
    </template>

    <!-- 「扫描导入」对话框 -->
    <ImportSessionsDialog v-if="importDialogOpen" @close="onImportDialogClose" />
  </div>
</template>

<script setup lang="ts">
import { useBackendStore } from '@renderer/stores/backend'
import { useMessageStore } from '@renderer/stores/message'
import { useSessionStore } from '@renderer/stores/session'
import { useSettingsStore } from '@renderer/stores/settings'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { type BackendId } from '@shared/constants'
import { FileInputIcon, PlusIcon, RefreshCwIcon } from 'lucide-vue-next'
import { onMounted, ref, watch } from 'vue'

import ImportSessionsDialog from './ImportSessionsDialog.vue'
import SessionItem from './SessionItem.vue'

const workspaceStore = useWorkspaceStore()
const sessionStore = useSessionStore()
const backendStore = useBackendStore()
const settings = useSettingsStore()

/** 「扫描导入」对话框显隐——点按钮打开，dialog 关闭时刷新会话列表 */
const importDialogOpen = ref(false)
const refreshingSessions = ref(false)
const messageStore = useMessageStore()

/**
 * 查某会话是否有 turn 在后台跑。
 *
 * 数据来源 messageStore.sessionStates（reactive Map）——applyEvent 按 sessionId
 * 路由事件，所以即使是用户切走的后台会话，isRunning 也会正确更新。
 * 没记录过的会话（从未在本进程跑过 turn）Map 里没条目，按 false 处理。
 */
function isSessionRunning(sessionId: string): boolean {
  return messageStore.sessionStates.get(sessionId)?.isRunning ?? false
}

/**
 * 查某会话是否有"未读活动"——后台 turn 跑完了用户还没看。
 * turn_completed 且非当前 session 时置 true；用户切到该 session 时清 false。
 */
function hasUnreadActivity(sessionId: string): boolean {
  return messageStore.sessionStates.get(sessionId)?.unreadActivity ?? false
}

function backendStatus(id: BackendId) {
  return backendStore.statuses.find((s) => s.id === id)
}

function isBackendAvailable(id: BackendId): boolean {
  return backendStatus(id)?.available ?? false
}

onMounted(async () => {
  if (workspaceStore.currentWorkspace) {
    await sessionStore.load(workspaceStore.currentWorkspace.id, backendStore.currentId)
    await sessionStore.reconcile(workspaceStore.currentWorkspace.id, backendStore.currentId)
  }
})

// 切工作区时重新加载（每个工作区各自刷新成当前 backend 的会话）
watch(
  () => workspaceStore.currentWorkspace?.id,
  async (id) => {
    if (id) {
      await sessionStore.load(id, backendStore.currentId)
      await sessionStore.reconcile(id, backendStore.currentId)
    }
  },
)

// 切后端时刷新当前工作区的会话列表——只刷当前选中的工作区，
// 用户切到别的工作区时上面的 watch workspace.id 会自动按新 backend 刷新。
watch(
  () => backendStore.currentId,
  async (newBackend) => {
    if (workspaceStore.currentWorkspace) {
      await sessionStore.load(workspaceStore.currentWorkspace.id, newBackend)
      await sessionStore.reconcile(workspaceStore.currentWorkspace.id, newBackend)
    }
  },
)

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
  let session = sessionStore.sessions.find((s) => s.id === id)
  if (!session && workspaceStore.currentWorkspace) {
    // 列表可能过期（load 中、刚切 workspace、reconcile 刚改库），重拉一次再找。
    // 不静默 return——否则 currentSessionId 留在前一个状态，用户下次发消息时
    // onSend 会以为"没选 session"偷偷创建新会话（Bug B）。
    await sessionStore.load(workspaceStore.currentWorkspace.id, backendStore.currentId)
    session = sessionStore.sessions.find((s) => s.id === id)
  }
  if (!session) return // 重拉后还是没有——真没了（被删/被其他端改）

  // ⚠️ 关键：先把 currentSessionId 设上，再 await switchTo / loadHistory。
  // 否则 await 期间用户发消息，currentSessionId 还是旧值（可能 '' 或别处），
  // onSend 拿不到 currentSession 就会创建新会话（Bug B 的 race 触发点）。
  sessionStore.setCurrent(id)
  messageStore.setCurrentSession(id)

  if (session.backend !== backendStore.currentId) {
    if (!isBackendAvailable(session.backend)) {
      // 极端情况：会话所属 backend 不可用——不让选
      // 回滚 currentSessionId，避免挂在一个不可用 backend 上
      sessionStore.setCurrent('')
      messageStore.setCurrentSession(null)
      return
    }
    await backendStore.switchTo(session.backend)
  }
  await sessionStore.loadHistory(id)
}

async function removeSession(id: string): Promise<void> {
  if (!window.confirm('删除此会话？')) return
  // 清理被删 session 的状态（防止内存泄漏）
  messageStore.clearSession(id)
  await sessionStore.remove(id)
}

/**
 * 新建会话——先切到设置里的默认后端，再清空当前会话。
 *
 * 必须切的原因：onSend 用 backendStore.currentId（当前 adapter）创建会话，
 * 如果不切，刚浏览过 claude 会话后点「新建会话」会以 claude adapter 起线程，
 * 但默认后端可能是 codex——发出去的消息会建出 backend 不匹配的会话。
 * 默认后端不可用时静默跳过（沿用当前 adapter，让用户至少能发消息）。
 */
async function newSession(): Promise<void> {
  const def = settings.settings?.defaultBackend
  if (def && def !== backendStore.currentId && isBackendAvailable(def)) {
    await backendStore.switchTo(def)
  }
  sessionStore.setCurrent('')
  messageStore.setCurrentSession(null)
}

/** 手动刷新当前工作区，并与当前后端的真实会话状态重新对账。 */
async function refreshSessions(): Promise<void> {
  const workspace = workspaceStore.currentWorkspace
  if (!workspace || refreshingSessions.value) return

  refreshingSessions.value = true
  try {
    await sessionStore.load(workspace.id, backendStore.currentId)
    await sessionStore.reconcile(workspace.id, backendStore.currentId)
  } finally {
    refreshingSessions.value = false
  }
}

/**
 * 「扫描导入」对话框关闭时刷新当前 workspace 的 session 列表——
 * 即使没有导入任何东西也刷新一下（用户可能用了"用此路径新建工作区"，
 * workspaces 列表变了，重 load 一下让 badge 数字对齐）。
 */
async function onImportDialogClose(): Promise<void> {
  importDialogOpen.value = false
  if (workspaceStore.currentWorkspace) {
    await sessionStore.load(workspaceStore.currentWorkspace.id, backendStore.currentId)
  }
}
</script>
