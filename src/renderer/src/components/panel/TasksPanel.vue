<template>
  <!--
    Background Tasks Panel: 当前 session 的后台任务列表。

    消息流里的 TaskCard 只在任务对应的那条消息旁边，用户滚走就看不见了；
    而后台任务恰恰是"发完就去干别的"的场景。这里给它一个固定的位置：
      - 分组：进行中 / 已完成两段式（参考 Claude 官方 Desktop 客户端的
        Background Tasks 面板），停止/失败的任务也归到"已完成"段，
        用状态图标区分具体结局——否则长会话里运行中的任务会被淹没在
        一串已完成任务中间，找不到当前真正在跑什么。
      - 展开：子 Agent 看内部过程，shell 看输出 tail
      - 停止：单条任务停止，不影响同一 turn 的其他任务
  -->
  <div ref="listEl" class="h-full flex flex-col min-h-0">
    <div
      v-if="tasks.length === 0"
      class="flex-1 grid place-items-center text-[length:var(--ui-text-d3)] text-muted-foreground px-4 text-center"
    >
      当前会话没有后台任务
    </div>

    <div v-else class="flex-1 overflow-y-auto">
      <template v-for="row in taskRows" :key="row.key">
        <!-- 分组标题：进行中 / 已完成 -->
        <h3
          v-if="row.kind === 'header'"
          class="px-3 pt-2.5 pb-1 text-[length:var(--ui-text-d4)] font-medium text-muted-foreground uppercase tracking-wide"
        >
          {{ row.label }} ({{ row.count }})
        </h3>

        <div v-else :data-task-id="row.task.taskId" class="border-b border-border/60">
          <!-- 任务行 -->
          <div
            class="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/40 cursor-pointer"
            @click="toggle(row.task.taskId)"
          >
            <component
              :is="statusIcon(row.task)"
              class="w-3.5 h-3.5 flex-shrink-0"
              :class="statusIconClass(row.task)"
            />
            <div class="flex-1 min-w-0">
              <div
                class="text-[length:var(--ui-text-d2)] text-foreground truncate"
                :title="row.task.description"
              >
                {{ row.task.description || row.task.taskId }}
              </div>
              <div
                class="text-[length:var(--ui-text-d4)] font-mono text-muted-foreground/80 truncate"
              >
                {{ statusLine(row.task) }}
              </div>
            </div>
            <!-- 停止按钮仅运行中出现 -->
            <button
              v-if="row.task.status === 'running'"
              type="button"
              class="flex-shrink-0 p-1 rounded text-muted-foreground hover:text-destructive hover:bg-muted"
              title="停止该任务"
              @click.stop="onStop(row.task.taskId)"
            >
              <SquareIcon class="w-3 h-3" />
            </button>
            <ChevronDownIcon
              class="w-3 h-3 flex-shrink-0 text-muted-foreground transition-transform"
              :class="expanded.has(row.task.taskId) ? 'rotate-180' : ''"
            />
          </div>

          <!-- 展开区：进度详情 -->
          <div v-if="expanded.has(row.task.taskId)" class="px-3 pb-2.5 space-y-1.5">
            <!--
              summary 对 shell 任务是一句话，对子 Agent 却是整份产出（几千字）。
              这里只当"一眼扫过"的摘要用，钳到 3 行；完整内容在下面的过程视图里。
            -->
            <p
              v-if="row.task.summary"
              class="summary-clamp text-[length:var(--ui-text-d3)] text-muted-foreground break-words"
              :title="row.task.summary"
            >
              {{ row.task.summary }}
            </p>
            <p
              v-if="row.task.error"
              class="text-[length:var(--ui-text-d3)] text-destructive break-words"
            >
              {{ row.task.error }}
            </p>
            <div
              v-if="metrics(row.task)"
              class="text-[length:var(--ui-text-d4)] font-mono text-muted-foreground/70"
            >
              {{ metrics(row.task) }}
            </div>

            <!--
              Subagent Transcript: 子 Agent 的内部过程。

              放这里而不是消息流的工具卡片里——卡片会随对话滚走，而看过程时
              正需要它固定在视野中。运行中来自 SDK 转发的实时消息
              （forwardSubagentText，按发起它的 tool_use id 索引）；实时消息缺席时
              （历史会话、或转发早于展开）回落到落盘的子 Agent jsonl。

              必须排在 outputFile 前面：子 Agent 完成时 task_notification 也会带
              output_file，按 outputFile 优先会让刚跑完的子 Agent 从过程视图
              退化成一堆原始 jsonl。
            -->
            <SubagentTranscript
              v-if="transcriptOf(row.task).length > 0"
              :key="row.task.taskId"
              :messages="transcriptOf(row.task)"
            />

            <!--
              shell 任务的进度就是命令输出本身——SDK 不给 task_progress，
              outputFile 是运行期唯一能看到"它在干什么"的东西。

              仅限 shell：子 Agent 的 output_file 是指向它自己 jsonl 的软链接，
              当纯文本 tail 出来就是几万字符的原始 JSON 刷屏。
            -->
            <template v-else-if="isTailable(row.task)">
              <pre
                v-if="outputs[row.task.taskId]"
                class="max-h-64 overflow-auto rounded bg-muted/50 p-2 font-mono text-[length:var(--ui-text-d4)] leading-relaxed whitespace-pre-wrap break-words text-muted-foreground"
                >{{ outputs[row.task.taskId] }}</pre>
              <p v-else class="text-[length:var(--ui-text-d4)] text-muted-foreground/60">
                暂无输出
              </p>
            </template>

            <p
              v-else-if="loadingTranscripts.has(row.task.taskId)"
              class="text-[length:var(--ui-text-d4)] text-muted-foreground/60"
            >
              正在读取子 Agent 过程…
            </p>
            <p
              v-else-if="row.task.status === 'running' && !metrics(row.task)"
              class="text-[length:var(--ui-text-d4)] text-muted-foreground/60"
            >
              任务运行中，暂无进度信息
            </p>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useBackendStore } from '@renderer/stores/backend'
import { useMessageStore } from '@renderer/stores/message'
import { useUiStore } from '@renderer/stores/ui'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { BackgroundTaskSnapshot, NormalizedMessage } from '@shared/backend/types'
import {
  ChevronDownIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  CircleXIcon,
  LoaderCircleIcon,
  SquareIcon,
} from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, ref, watch, type Component } from 'vue'

import SubagentTranscript from './SubagentTranscript.vue'

const messageStore = useMessageStore()
const uiStore = useUiStore()
const workspaceStore = useWorkspaceStore()
const backendStore = useBackendStore()
const tasks = computed(() => messageStore.backgroundTasks)

type TaskRow =
  | { kind: 'header'; key: string; label: string; count: number }
  | { kind: 'task'; key: string; task: BackgroundTaskSnapshot }

/**
 * 进行中 / 已完成两段式分组（对齐 Claude 官方 Desktop 客户端 Background Tasks
 * 面板的 Running / Completed 分段）。failed/stopped 都并入"已完成"——它们和
 * completed 一样不再消耗用户的持续关注，行内的状态图标已经能区分具体结局，
 * 没必要为每种终态单开一段。用一个打平的行数组而不是嵌套结构，是为了复用
 * 下面单个 v-for 里原本就很长的任务行/展开区模板，不必写两份。
 */
const taskRows = computed<TaskRow[]>(() => {
  const running = tasks.value.filter((t) => t.status === 'running')
  const done = tasks.value.filter((t) => t.status !== 'running')
  const rows: TaskRow[] = []
  if (running.length > 0) {
    rows.push({ kind: 'header', key: 'header-running', label: '进行中', count: running.length })
    for (const task of running) rows.push({ kind: 'task', key: task.taskId, task })
  }
  if (done.length > 0) {
    rows.push({ kind: 'header', key: 'header-done', label: '已完成', count: done.length })
    for (const task of done) rows.push({ kind: 'task', key: task.taskId, task })
  }
  return rows
})

const listEl = ref<HTMLElement | null>(null)
const expanded = ref<Set<string>>(new Set())
const outputs = ref<Record<string, string>>({})
/** 落盘 jsonl 读出来的子 Agent 过程，按 taskId 缓存（读一次就够，文件不再变）。 */
const diskTranscripts = ref<Record<string, NormalizedMessage[]>>({})
const loadingTranscripts = ref<Set<string>>(new Set())

/**
 * 该任务的子 Agent 过程：实时优先，回落到落盘 jsonl。
 *
 * 实时消息的索引键是 toolUseId 而非 taskId：转发消息带的是发起它的 tool_use id
 * （SDK 的 parent_tool_use_id），而任务表的主键是 taskId，两者不是一回事。
 */
function transcriptOf(task: BackgroundTaskSnapshot): NormalizedMessage[] {
  const live = task.toolUseId ? messageStore.subagentMessagesFor(task.toolUseId) : []
  if (live.length > 0) return live
  return diskTranscripts.value[task.taskId] ?? []
}

/**
 * outputFile 能不能当纯文本 tail？
 *
 * 只有 shell 任务的 output_file 是命令的 stdout/stderr。子 Agent 的那一份是指向
 * 它自己会话 jsonl 的软链接——那是给 transcriptOf 解析用的，不是给人看的。
 * 用白名单而不是"排除 subagent"：新出现的 task_type（monitor/workflow…）默认
 * 不 tail，最坏只是少显示一段，而猜错方向就是又一次原始 JSON 刷屏。
 */
function isTailable(task: BackgroundTaskSnapshot): boolean {
  return task.taskType === 'shell' && Boolean(task.outputFile)
}

/** 子 Agent 且没有实时过程时，才值得去磁盘找它的 jsonl。 */
function needsDiskTranscript(task: BackgroundTaskSnapshot): boolean {
  if (isTailable(task)) return false
  if (transcriptOf(task).length > 0) return false
  if (loadingTranscripts.value.has(task.taskId)) return false
  const agentId = task.stats.agentId
  return typeof agentId === 'string' && agentId.length > 0
}

async function loadDiskTranscript(task: BackgroundTaskSnapshot): Promise<void> {
  const agentId = task.stats.agentId
  const cwd = workspaceStore.currentWorkspace?.path
  if (!agentId || !cwd) return
  loadingTranscripts.value = new Set(loadingTranscripts.value).add(task.taskId)
  try {
    const messages = await window.api.session.readSubagentHistory({
      backend: backendStore.currentId,
      agentId,
      cwd,
    })
    if (messages.length > 0) diskTranscripts.value[task.taskId] = messages
  } catch (e) {
    console.error('Failed to read subagent history:', e)
  } finally {
    const next = new Set(loadingTranscripts.value)
    next.delete(task.taskId)
    loadingTranscripts.value = next
  }
}

/** 秒级心跳——让运行中任务的"已运行 N 秒"跟着走。 */
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null
/** 输出轮询——只在有展开的 shell 任务时才跑，收起就停。 */
let outputTimer: ReturnType<typeof setInterval> | null = null

function toggle(taskId: string): void {
  const next = new Set(expanded.value)
  if (next.has(taskId)) next.delete(taskId)
  else next.add(taskId)
  expanded.value = next
}

async function onStop(taskId: string): Promise<void> {
  await messageStore.stopBackgroundTask(taskId)
}

/** 拉取所有已展开且可 tail 的任务的输出尾部。 */
async function refreshOutputs(): Promise<void> {
  const targets = tasks.value.filter((t) => expanded.value.has(t.taskId) && isTailable(t))
  await Promise.all(
    targets.map(async (task) => {
      try {
        const res = await window.api.backend.readBackgroundTaskOutput({
          taskId: task.taskId,
          outputFile: task.outputFile!,
        })
        if (res.exists) outputs.value[task.taskId] = res.content
      } catch (e) {
        console.error('Failed to read background task output:', e)
      }
    }),
  )
}

// 展开集合或任务状态变化时重建轮询：有运行中的展开任务才需要定时刷新，
// 已结束的任务读一次就够——输出文件不会再变。展开子 Agent 时顺带补读落盘过程。
watch(
  [expanded, tasks],
  () => {
    void refreshOutputs()
    for (const task of tasks.value) {
      if (!expanded.value.has(task.taskId)) continue
      if (needsDiskTranscript(task)) void loadDiskTranscript(task)
    }
    const needsPolling = tasks.value.some(
      (t) => expanded.value.has(t.taskId) && isTailable(t) && t.status === 'running',
    )
    if (needsPolling && outputTimer === null) {
      outputTimer = setInterval(() => void refreshOutputs(), 1500)
    } else if (!needsPolling && outputTimer !== null) {
      clearInterval(outputTimer)
      outputTimer = null
    }
  },
  { deep: true },
)

// Background Tasks Focus: 消息流的工具卡片点「在后台面板查看」跳过来时，
// 把目标任务展开并滚到眼前，然后清掉跳转目标——否则用户手动收起后，
// 下次打开面板它又会被强行展开。
watch(
  () => uiStore.focusedBackgroundTaskId,
  async (taskId) => {
    if (!taskId) return
    if (!expanded.value.has(taskId)) {
      expanded.value = new Set(expanded.value).add(taskId)
    }
    await nextTick()
    listEl.value
      ?.querySelector(`[data-task-id="${CSS.escape(taskId)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
    uiStore.clearBackgroundTaskFocus()
  },
  { immediate: true },
)

watch(
  () => tasks.value.some((t) => t.status === 'running'),
  (hasRunning) => {
    if (hasRunning && clock === null) {
      clock = setInterval(() => {
        now.value = Date.now()
      }, 1000)
    } else if (!hasRunning && clock !== null) {
      clearInterval(clock)
      clock = null
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (clock !== null) clearInterval(clock)
  if (outputTimer !== null) clearInterval(outputTimer)
})

function formatSeconds(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  return `${m}m ${sec % 60}s`
}

function formatTokens(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`
}

function elapsed(task: BackgroundTaskSnapshot): number | null {
  if (task.status === 'running' && task.startedAt) {
    return Math.max(0, Math.floor((now.value - task.startedAt) / 1000))
  }
  const ms = task.stats.totalDurationMs
  return typeof ms === 'number' ? Math.max(0, Math.floor(ms / 1000)) : null
}

const STATUS_LABEL: Record<BackgroundTaskSnapshot['status'], string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
}

/** 任务类型标签——shell 和子 Agent 的"进度"含义不同，先让用户看清是哪种。 */
function typeLabel(task: BackgroundTaskSnapshot): string {
  if (task.taskType === 'shell') return '命令'
  if (task.taskType === 'subagent') return '子 Agent'
  return task.taskType ?? '任务'
}

function statusLine(task: BackgroundTaskSnapshot): string {
  const parts = [typeLabel(task), STATUS_LABEL[task.status]]
  const sec = elapsed(task)
  if (sec !== null) parts.push(formatSeconds(sec))
  return parts.join(' · ')
}

function metrics(task: BackgroundTaskSnapshot): string {
  const parts: string[] = []
  const { totalTokens, totalToolUseCount, lastToolName } = task.stats
  // 运行中 token 常年为 0（要等子 Agent 内部回合结束才结算），显示 "0 tokens"
  // 会被读成"它没在动"。有值才显示。
  if (totalTokens) parts.push(`${formatTokens(totalTokens)} tokens`)
  if (typeof totalToolUseCount === 'number') parts.push(`${totalToolUseCount} 次工具`)
  if (lastToolName) parts.push(`最近：${lastToolName}`)
  return parts.join(' · ')
}

function statusIcon(task: BackgroundTaskSnapshot): Component {
  switch (task.status) {
    case 'running':
      return LoaderCircleIcon
    case 'completed':
      return CircleCheckIcon
    case 'failed':
      return CircleXIcon
    default:
      return CircleSlashIcon
  }
}

function statusIconClass(task: BackgroundTaskSnapshot): string {
  switch (task.status) {
    case 'running':
      return 'text-primary animate-spin'
    case 'completed':
      return 'text-success'
    case 'failed':
      return 'text-destructive'
    default:
      return 'text-muted-foreground'
  }
}
</script>

<style scoped>
.summary-clamp {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
