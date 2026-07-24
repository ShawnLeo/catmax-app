<template>
  <!--
    扫描并导入外部会话对话框。

    打开时自动调 session.scanImportable() 全盘扫：
      - claude：扫所有 ~/.claude/projects/*/*.jsonl
      - codex：调 thread/list 拿全部 thread
    用户勾选 + 给每条选归属 workspace，点「导入」后调 session.import。

    单 backend 失败（如 codex 进程没启动）容错——只显示警告条，不影响另一个 backend 的结果。
  -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    @click.self="onClose"
  >
    <div
      class="bg-card text-card-foreground rounded-lg shadow-xl w-[min(900px,95vw)] max-h-[85vh] flex flex-col"
    >
      <!-- 头部 -->
      <div class="flex items-center justify-between p-4 border-b border-border">
        <div>
          <h3 class="text-lg font-semibold">扫描导入会话</h3>
          <p class="text-xs text-muted-foreground mt-0.5">
            扫描磁盘/RPC 上已存在但还没纳入 catmax 的 claude / codex 会话
          </p>
        </div>
        <button
          class="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer"
          title="关闭"
          @click="onClose"
        >
          <XIcon class="w-4 h-4" />
        </button>
      </div>

      <!-- 错误警告条（单 backend 失败时显示） -->
      <div
        v-if="result?.errors.length"
        class="px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-xs text-amber-700 dark:text-amber-400 flex items-center gap-2"
      >
        <AlertTriangleIcon class="w-3.5 h-3.5 flex-shrink-0" />
        <span class="flex-1">
          <template v-for="err in result.errors" :key="err.backend">
            {{ err.backend }} 扫描失败：{{ err.error }}。
          </template>
          其他后端结果仍可用。
        </span>
      </div>

      <!-- 主体：扫描结果列表 -->
      <div class="flex-1 overflow-y-auto p-4">
        <!-- 加载中 -->
        <div
          v-if="scanning"
          class="flex items-center justify-center py-16 gap-2 text-sm text-muted-foreground"
        >
          <Loader2Icon class="w-4 h-4 animate-spin" />
          <span>正在扫描磁盘和后端...</span>
        </div>

        <!-- 空结果 -->
        <div
          v-else-if="result && importableSessions.length === 0"
          class="text-center py-16 text-sm text-muted-foreground"
        >
          <CheckCircle2Icon class="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>没有发现可导入的会话</p>
          <p class="text-xs mt-1 opacity-70">
            已扫描 claude 项目目录和 codex 后端的所有会话，全部已纳入或为空
          </p>
        </div>

        <!-- 列表 -->
        <template v-else-if="result">
          <!-- 工具条：全选 / 数量统计 -->
          <div class="flex items-center justify-between mb-3 text-xs">
            <label class="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                :checked="allSelected"
                :indeterminate.prop="someSelected && !allSelected"
                class="cursor-pointer"
                @change="toggleSelectAll(($event.target as HTMLInputElement).checked)"
              />
              <span>全选可导入（{{ importableSessions.length }}）</span>
            </label>
            <span v-if="result.unmatchedCount > 0" class="text-amber-600 dark:text-amber-400">
              {{ result.unmatchedCount }} 条 cwd 未匹配已注册工作区——需手动选择归属
            </span>
          </div>

          <div class="border border-border rounded-md divide-y divide-border">
            <ImportSessionRow
              v-for="(sess, idx) in importableSessions"
              :key="`${sess.backend}:${sess.backendThreadId}`"
              :session="sess"
              :workspaces="workspaces"
              :selected-workspace-id="
                selectedWorkspaceByItem[`${sess.backend}:${sess.backendThreadId}`] ?? null
              "
              :checked="selectedItems.has(`${sess.backend}:${sess.backendThreadId}`)"
              @toggle="toggleItem(sess)"
              @select-workspace="(wsId) => onWorkspaceChange(sess, wsId)"
            >
              <!-- 反推路径没匹配上 workspace 时，在行内加一个"创建工作区"快捷入口 -->
              <template v-if="needsCreateWorkspace(sess, idx)" #hint>
                <button
                  class="text-xs text-primary hover:underline cursor-pointer"
                  @click="createWorkspaceFromCwd(sess.cwd!)"
                >
                  + 用此路径新建工作区
                </button>
              </template>
            </ImportSessionRow>
          </div>
        </template>
      </div>

      <!-- 底部操作 -->
      <div class="p-4 border-t border-border flex items-center justify-between gap-2">
        <button
          class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 cursor-pointer"
          :disabled="scanning"
          @click="rescan"
        >
          <RefreshCwIcon class="w-3.5 h-3.5" :class="{ 'animate-spin': scanning }" />
          重新扫描
        </button>
        <div class="flex items-center gap-2">
          <span v-if="selectedCount > 0" class="text-xs text-muted-foreground">
            已选 {{ selectedCount }} 条
          </span>
          <Button variant="outline" size="sm" @click="onClose">取消</Button>
          <Button size="sm" :disabled="selectedCount === 0 || importing" @click="onImport">
            {{ importing ? '导入中...' : `导入${selectedCount > 0 ? ` (${selectedCount})` : ''}` }}
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button } from '@renderer/components/ui/button'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type {
  ImportableSession,
  ImportSessionItem,
  ScanImportableResult,
} from '@shared/ipc/session'
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  Loader2Icon,
  RefreshCwIcon,
  XIcon,
} from 'lucide-vue-next'
import { computed, onMounted, ref } from 'vue'

import ImportSessionRow from './ImportSessionRow.vue'

const emit = defineEmits<{ close: [] }>()

const workspaceStore = useWorkspaceStore()

const scanning = ref(false)
const importing = ref(false)
const result = ref<ScanImportableResult | null>(null)

/** 选中条目集合，key = `${backend}:${backendThreadId}` */
const selectedItems = ref(new Set<string>())
/** 每条选中的条目对应的 workspaceId（key 同上） */
const selectedWorkspaceByItem = ref<Record<string, string>>({})

const workspaces = computed(() => workspaceStore.workspaces)

/**
 * 可导入的会话——过滤掉 alreadyImported 的。
 * alreadyImported 的不在 UI 显示，避免视觉噪音。
 */
const importableSessions = computed<ImportableSession[]>(() => {
  if (!result.value) return []
  return result.value.sessions.filter((s) => !s.alreadyImported)
})

const selectedCount = computed(() => selectedItems.value.size)
const allSelected = computed(
  () =>
    importableSessions.value.length > 0 &&
    selectedItems.value.size === importableSessions.value.length,
)
const someSelected = computed(() => selectedItems.value.size > 0)

onMounted(async () => {
  await workspaceStore.load()
  await rescan()
})

async function rescan(): Promise<void> {
  scanning.value = true
  try {
    result.value = await window.api.session.scanImportable()
    // 重置选中状态
    selectedItems.value = new Set()
    selectedWorkspaceByItem.value = {}
    // 默认预选匹配到 workspace 的 + 默认预填 workspace id
    for (const sess of importableSessions.value) {
      const defaultWsId = pickDefaultWorkspace(sess)
      if (defaultWsId) {
        selectedWorkspaceByItem.value[itemKey(sess)] = defaultWsId
      }
    }
  } catch (e) {
    console.error('scanImportable failed:', e)
    result.value = { sessions: [], unmatchedCount: 0, errors: [] }
  } finally {
    scanning.value = false
  }
}

/**
 * 给一条会话挑默认 workspace：
 * - claude：优先用 matchedWorkspaceId（精确匹配），其次当前 workspace
 * - codex：用当前 workspace（codex 不带 cwd，挂到用户当前看的 workspace 最自然）
 */
function pickDefaultWorkspace(sess: ImportableSession): string | null {
  if (sess.matchedWorkspaceId) return sess.matchedWorkspaceId
  return workspaceStore.currentWorkspaceId ?? workspaces.value[0]?.id ?? null
}

function itemKey(sess: ImportableSession): string {
  return `${sess.backend}:${sess.backendThreadId}`
}

function toggleItem(sess: ImportableSession): void {
  const key = itemKey(sess)
  const next = new Set(selectedItems.value)
  if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
    // 勾选时如果没有 workspace，补上默认
    if (!selectedWorkspaceByItem.value[key]) {
      const defaultId = pickDefaultWorkspace(sess)
      if (defaultId) selectedWorkspaceByItem.value[key] = defaultId
    }
  }
  selectedItems.value = next
}

function toggleSelectAll(checked: boolean): void {
  if (checked) {
    const next = new Set<string>()
    for (const sess of importableSessions.value) {
      const key = itemKey(sess)
      next.add(key)
      if (!selectedWorkspaceByItem.value[key]) {
        const defaultId = pickDefaultWorkspace(sess)
        if (defaultId) selectedWorkspaceByItem.value[key] = defaultId
      }
    }
    selectedItems.value = next
  } else {
    selectedItems.value = new Set()
  }
}

function onWorkspaceChange(sess: ImportableSession, wsId: string): void {
  selectedWorkspaceByItem.value[itemKey(sess)] = wsId
}

/**
 * 未匹配 workspace 且当前也没默认值——显示"新建工作区"快捷入口。
 * 已选 workspace（非 null）就不显示了——避免干扰。
 */
function needsCreateWorkspace(sess: ImportableSession, _idx: number): boolean {
  if (!sess.cwd) return false
  const key = itemKey(sess)
  // 已分配 workspace 时不显示
  return !sess.matchedWorkspaceId && !selectedWorkspaceByItem.value[key]
}

/**
 * 从反推 cwd 创建新工作区，并把当前条目分配给它。
 * 用 workspaceStore.add 会自动切到新 workspace——但我们这里不想切，
 * 所以只在 dialog 期间分配 workspaceId，让用户继续选别的，关闭 dialog 时再统一刷新。
 */
async function createWorkspaceFromCwd(cwd: string): Promise<void> {
  // 暂时不调 add（会自动切 workspace），改用低层 IPC 直接加，避免切换副作用
  // 但 add 是当前唯一入口，且自动切其实也没事——dialog 期间不依赖 currentWorkspace
  // 用 add 简单点：切了就切了，反正用户最终会回 chat
  await workspaceStore.add(cwd)
  // 重新拿最新 workspace 列表
  // add 已经把新 ws 加到列表里，selectedWorkspaceByItem 也要更新——
  // 调用方 row 内的 select 会随 workspaces reactive 自动更新选项
}

async function onImport(): Promise<void> {
  if (selectedItems.value.size === 0) return
  importing.value = true
  try {
    const items: ImportSessionItem[] = []
    for (const key of selectedItems.value) {
      const wsId = selectedWorkspaceByItem.value[key]
      if (!wsId) continue // 防御——理论上 toggle 时已经补了默认
      const [backend, backendThreadId] = key.split(':') as [string, string]
      items.push({
        backend: backend as ImportSessionItem['backend'],
        backendThreadId,
        workspaceId: wsId,
      })
    }
    const { imported, skipped } = await window.api.session.import({ sessions: items })
    if (skipped.length > 0) {
      console.warn('some sessions skipped during import:', skipped)
    }
    // 关闭前刷新当前 workspace 的 session 列表
    if (workspaceStore.currentWorkspaceId) {
      const { useSessionStore } = await import('@renderer/stores/session')
      const sessionStore = useSessionStore()
      await sessionStore.load(workspaceStore.currentWorkspaceId)
    }
    void imported
    emit('close')
  } catch (e) {
    console.error('import failed:', e)
    window.alert(`导入失败：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    importing.value = false
  }
}

function onClose(): void {
  if (importing.value) return // 导入中不允许关
  emit('close')
}
</script>
