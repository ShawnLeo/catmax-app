<template>
  <div class="p-2 flex flex-col h-full">
    <!-- 当前工作区不存在时 -->
    <div
      v-if="!workspaceStore.currentWorkspace"
      class="text-center text-[length:var(--ui-text-d3)] text-muted-foreground py-8"
    >
      请先选择工作区
    </div>

    <template v-else>
      <!-- 会话操作：主按钮保持强视觉层级，导入和刷新作为紧凑的次级操作 -->
      <div class="mb-2 flex items-center gap-1 rounded-lg bg-sidebar-accent/70 p-1">
        <button
          class="group flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-[length:var(--ui-text-base)] font-medium text-sidebar-foreground transition-colors hover:bg-background/40 cursor-pointer"
          @click="newSession"
        >
          <span
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-foreground text-background shadow-sm transition-transform group-active:scale-95"
          >
            <PlusIcon class="h-3.5 w-3.5" stroke-width="2.5" />
          </span>
          <span class="truncate">新建会话</span>
        </button>
        <!-- 导入会话按钮：暂时注释（导入功能暂不使用）
        <button
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/40 hover:text-foreground cursor-pointer"
          title="扫描磁盘/RPC 上已存在但还没纳入 catmax 的 claude/codex 会话"
          aria-label="导入会话"
          @click="importDialogOpen = true"
        >
          <FileInputIcon class="w-4 h-4" />
        </button>
        -->
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
      <div class="session-scroll flex-1 overflow-y-auto">
        <SessionItem
          v-for="session in sessionStore.sessions"
          :key="session.id"
          :session="session"
          :backend="session.backend"
          :active="session.id === sessionStore.currentSessionId"
          :running="isSessionRunning(session.id)"
          :unread-activity="hasUnreadActivity(session.id)"
          :renaming="renamingSessionId === session.id"
          :menu-open="contextMenu?.session.id === session.id"
          @click="selectSession(session.id)"
          @contextmenu="openContextMenu(session, $event)"
          @menu="openMenuFromButton(session, $event)"
          @rename="renameSession(session.id, $event)"
          @rename-cancel="renamingSessionId = null"
        />

        <!-- 空状态 -->
        <div
          v-if="sessionStore.sessions.length === 0"
          class="text-center text-[length:var(--ui-text-d3)] text-muted-foreground py-8"
        >
          暂无会话
        </div>
      </div>
    </template>

    <!-- 会话右键菜单：置顶 / 重命名 / 在文件管理器中显示 / 复制会话 -->
    <ContextMenu
      v-if="contextMenu"
      :x="contextMenu.x"
      :y="contextMenu.y"
      :items="contextMenuItems"
      @select="onContextMenuSelect"
      @close="closeContextMenu"
    />

    <!-- 「扫描导入」对话框 -->
    <ImportSessionsDialog v-if="importDialogOpen" @close="onImportDialogClose" />
  </div>
</template>

<script setup lang="ts">
import { ContextMenu, type ContextMenuItem } from '@renderer/components/ui/context-menu'
import { startNewSession } from '@renderer/lib/new-session'
import { useBackendStore } from '@renderer/stores/backend'
import { useMessageStore } from '@renderer/stores/message'
import { useSessionStore } from '@renderer/stores/session'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { type BackendId } from '@shared/constants'
import type { SessionView } from '@shared/domain'
import {
  CopyIcon,
  FolderOpenIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from 'lucide-vue-next'
import { computed, onMounted, ref, watch } from 'vue'

import ImportSessionsDialog from './ImportSessionsDialog.vue'
import SessionItem from './SessionItem.vue'

const workspaceStore = useWorkspaceStore()
const sessionStore = useSessionStore()
const backendStore = useBackendStore()

/** 「扫描导入」对话框显隐——点按钮打开，dialog 关闭时刷新会话列表 */
const importDialogOpen = ref(false)
const refreshingSessions = ref(false)
const messageStore = useMessageStore()

// ---------------------------------------------------------------------------
// 会话右键菜单
// ---------------------------------------------------------------------------

/** 右键菜单状态：目标会话 + 鼠标坐标。null = 未打开 */
const contextMenu = ref<{ session: SessionView; x: number; y: number } | null>(null)
/** Session Rename: 正在就地编辑标题的会话（同一时刻只允许一条） */
const renamingSessionId = ref<string | null>(null)
/** 「在 Finder / 文件资源管理器中显示」的文案随平台变——启动时问一次 */
const platform = ref<'darwin' | 'win32' | 'linux'>('darwin')

const revealLabel = computed(() => {
  if (platform.value === 'darwin') return '在 Finder 中显示'
  if (platform.value === 'win32') return '在文件资源管理器中显示'
  return '在文件管理器中显示'
})

const contextMenuItems = computed<ContextMenuItem[]>(() => {
  const session = contextMenu.value?.session
  if (!session) return []
  const pinned = session.pinnedAt !== null
  return [
    {
      key: 'pin',
      label: pinned ? '取消置顶' : '置顶聊天',
      icon: pinned ? PinOffIcon : PinIcon,
    },
    { key: 'rename', label: '重命名会话', icon: PencilIcon },
    { key: 'reveal', label: revealLabel.value, icon: FolderOpenIcon },
    { key: 'fork', label: '复制会话', icon: CopyIcon },
    // 删除单独隔一档——它是这里唯一不可逆的操作，不该跟前面几项挨着让人误点
    { key: 'delete-sep', label: '', separator: true },
    { key: 'delete', label: '删除会话', icon: Trash2Icon, danger: true },
  ]
})

function openContextMenu(session: SessionView, event: MouseEvent): void {
  // 右键换一条会话时，先前那条的就地编辑框直接收掉——它的 blur 会自行提交
  renamingSessionId.value = null
  contextMenu.value = { session, x: event.clientX, y: event.clientY }
}

/**
 * 最近一次菜单关闭的会话与时刻——只为让「更多」按钮能真正 toggle。
 *
 * 菜单开着时点那个按钮，事件顺序是：ContextMenu 的 mousedown(capture) 先判定
 * "点到了菜单外面"把菜单关掉，之后才轮到按钮的 click。等 click 跑起来时
 * contextMenu 已经是 null，"开着就关掉"的判断永远命中不了，表现就是菜单
 * 关掉又立刻重开（看起来像点了没反应）。所以要记住这一下是不是关闭的余波。
 */
let lastMenuClose: { sessionId: string; at: number } | null = null

function closeContextMenu(): void {
  if (contextMenu.value) {
    lastMenuClose = { sessionId: contextMenu.value.session.id, at: Date.now() }
  }
  contextMenu.value = null
}

/**
 * 「更多」按钮打开菜单——内容跟右键完全一样，只有定位方式不同。
 *
 * 用按钮的位置而不是鼠标坐标：按钮是个固定目标，菜单每次都贴在它下方同一处；
 * 跟着鼠标走的话，同一个按钮点两次菜单会出现在两个地方，看着像飘。
 * 贴近窗口右/下边缘时 ContextMenu 自己会翻转，这里不用管。
 */
function openMenuFromButton(session: SessionView, event: MouseEvent): void {
  // 同一次点击里刚把这一条的菜单关掉（见 lastMenuClose）——这下就是收起，不再开
  if (
    lastMenuClose &&
    lastMenuClose.sessionId === session.id &&
    Date.now() - lastMenuClose.at < 250
  ) {
    lastMenuClose = null
    return
  }
  renamingSessionId.value = null
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  contextMenu.value = { session, x: rect.left, y: rect.bottom + 4 }
}

/**
 * 菜单项分发。
 *
 * 先把菜单目标取出来再执行——onContextMenuSelect 之后 ContextMenu 会 emit close
 * 把 contextMenu 置 null，异步动作里再读就没了。
 */
async function onContextMenuSelect(key: string): Promise<void> {
  const session = contextMenu.value?.session
  if (!session) return
  try {
    switch (key) {
      case 'pin':
        await sessionStore.setPinned(session.id, session.pinnedAt === null)
        break
      case 'rename':
        renamingSessionId.value = session.id
        break
      case 'reveal':
        await window.api.session.revealInFolder({ sessionId: session.id })
        break
      case 'fork':
        await forkSession(session)
        break
      case 'delete':
        await removeSession(session.id)
        break
    }
  } catch (e) {
    // 项目还没有 toast 机制，跟删除确认一样用原生弹窗兜底
    window.alert(e instanceof Error ? e.message : String(e))
  }
}

/** Session Rename: 提交新标题。失败时保持编辑态，让用户能重试或按 Esc 放弃 */
async function renameSession(sessionId: string, title: string): Promise<void> {
  try {
    await sessionStore.rename(sessionId, title)
    renamingSessionId.value = null
  } catch (e) {
    window.alert(e instanceof Error ? e.message : String(e))
  }
}

/**
 * Session Fork: 复制会话并切到副本。
 *
 * 切过去是刻意的——用户复制会话就是为了在副本里接着聊（保住原会话不被污染），
 * 复制完停在原会话上还得自己再点一次。
 */
async function forkSession(session: SessionView): Promise<void> {
  const workspace = workspaceStore.currentWorkspace
  if (!workspace) return
  const newSessionId = await sessionStore.fork(session.id, workspace.id, backendStore.currentId)
  await selectSession(newSessionId)
}

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
  // 右键菜单的「在 Finder 中显示」文案要按平台改，拿一次缓存住。
  // 拿不到就用默认文案，不值得为此报错。
  try {
    platform.value = (await window.api.system.platformInfo()).platform
  } catch {
    /* 保持默认 */
  }

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

/** 新建会话。实现在 lib/new-session.ts——命令面板 / ⌘N / 托盘菜单共用同一份。 */
async function newSession(): Promise<void> {
  await startNewSession()
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

<style scoped>
/*
 * 会话列表滚动条：默认完全隐藏，只在容器悬停或滚动中时显示细滚动条。
 * 覆盖全局 ::-webkit-scrollbar 的常驻 8px 样式，让侧栏更干净。
 * 不能再加标准的 scrollbar-width/scrollbar-color：Chromium 126 一旦看到元素上
 * 声明了标准滚动条属性，就会整体切到标准滚动条渲染路径，无视这里的
 * ::-webkit-scrollbar-track 透明覆盖，轨道会露出系统默认的浅色底（白边）。
 */
.session-scroll::-webkit-scrollbar {
  width: 6px;
}
.session-scroll::-webkit-scrollbar-thumb {
  background-color: transparent;
  border-radius: 3px;
  transition: background-color 0.2s ease;
}
.session-scroll:hover::-webkit-scrollbar-thumb {
  background-color: oklch(50% 0 0 / 0.3);
}
.session-scroll:hover::-webkit-scrollbar-thumb:hover {
  background-color: oklch(50% 0 0 / 0.5);
}
/* 滚动进行中强制可见（滚动停下后回归透明） */
.session-scroll:active::-webkit-scrollbar-thumb {
  background-color: oklch(50% 0 0 / 0.4);
}
</style>
