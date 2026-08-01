<template>
  <!--
    Task 工具卡片--子 agent 调用。

    卡片只回答"这次调用是什么"：一行状态/统计 + 完整的调用提示词。
    标题（Task + description）由外层 ToolCallCard 的 header 承担，这里不再重复；
    展开/收起也归外层——卡片本身就是被展开出来的内容，内部再套一层折叠只是噪音。

    真正的执行过程在右侧「后台」面板：卡片会随消息流滚走，而看过程时正需要它
    固定在视野里。「在后台面板查看」按钮负责这次跳转。
  -->
  <div class="space-y-2 py-0.5">
    <!-- 状态 / 统计行 + 跳转入口 -->
    <div class="flex items-center gap-2 text-[length:var(--chat-text-d2)] font-mono">
      <span :class="statusTextClass" class="min-w-0 truncate">{{ statusSummary }}</span>
      <div class="flex-1" />
      <button
        v-if="linkedTask"
        type="button"
        class="flex-shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-primary hover:bg-primary/10"
        title="在右侧后台面板查看该子 Agent 的执行过程"
        @click="onOpenPanel"
      >
        <PanelRightIcon class="w-3 h-3" />
        查看
      </button>
    </div>

    <!-- SDK 给的实时进度摘要（agentProgressSummaries 开启时才有） -->
    <p
      v-if="tool.taskStats?.progressSummary"
      class="text-[length:var(--chat-text-d1)] text-muted-foreground break-words leading-relaxed"
    >
      {{ tool.taskStats.progressSummary }}
    </p>

    <!-- 调用提示词：子 Agent 接到的完整任务描述 -->
    <div v-if="task.prompt" class="space-y-1">
      <div class="text-[length:var(--chat-text-d2)] text-muted-foreground/60">提示词</div>
      <pre
        class="rounded bg-muted/40 px-2.5 py-2 font-mono text-[length:var(--chat-text-d1)] text-foreground/80 whitespace-pre-wrap break-words leading-relaxed"
        >{{ task.prompt }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useMessageStore } from '@renderer/stores/message'
import { useUiStore } from '@renderer/stores/ui'
import type { NormalizedMessage, ToolTaskInfo } from '@shared/backend/types'
import { PanelRightIcon } from 'lucide-vue-next'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{
  task: ToolTaskInfo
  /** 完整 tool block--拿 status / startedAt / taskStats 算状态摘要 */
  tool: NonNullable<NormalizedMessage['toolBlocks']>[number]
}>()

const messageStore = useMessageStore()
const uiStore = useUiStore()

/**
 * 后台任务表里对应的那条任务。
 *
 * 任务表是本次运行的实时状态，历史回放的会话里是空的——查不到就不显示跳转按钮，
 * 免得点过去是一个空面板。
 */
const linkedTask = computed(() => messageStore.backgroundTaskByToolUseId(props.tool.id))

function onOpenPanel(): void {
  const taskId = linkedTask.value?.taskId
  if (!taskId) return
  uiStore.focusBackgroundTask(taskId)
}

/**
 * 实时计时器--只在 running 态跑，1s 一次足够。
 */
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

watch(
  () => props.tool.status,
  (status) => {
    if (status === 'running') {
      if (timer === null) {
        timer = setInterval(() => {
          now.value = Date.now()
        }, 1000)
      }
    } else if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer)
})

/** 秒数格式化：< 60s 显示"12s"，否则显示"2m 3s" / "3m 12s" */
function formatSeconds(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m ${s}s`
}

/** token 数格式化：< 1000 显示原数，否则显示 k 单位（1 位小数） */
function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  return `${(n / 1000).toFixed(1)}k`
}

/** running 态：用 startedAt -> now 实时算耗时；完成态：用 taskStats.totalDurationMs */
const elapsedSec = computed(() => {
  if (props.tool.status === 'running' && props.tool.startedAt) {
    return Math.max(0, Math.floor((now.value - props.tool.startedAt) / 1000))
  }
  const ms = props.tool.taskStats?.totalDurationMs
  return typeof ms === 'number' ? Math.max(0, Math.floor(ms / 1000)) : null
})

/** 状态摘要：子 Agent 类型 · 生命周期 · 耗时 · tokens · 工具次数 */
const statusSummary = computed(() => {
  const stats = props.tool.taskStats
  const parts: string[] = []

  const agentType = props.task.subagentType ?? stats?.agentType
  parts.push(agentType ? `子 Agent（${agentType}）` : '子 Agent')

  if (props.tool.status === 'running') {
    parts.push('运行中')
  } else if (stats?.status === 'stopped') {
    parts.push('已停止')
  } else if (stats?.status === 'failed' || props.tool.status === 'failed') {
    parts.push('失败')
  } else {
    parts.push('已完成')
  }

  if (elapsedSec.value !== null) parts.push(formatSeconds(elapsedSec.value))
  // token 统计要等子 Agent 内部回合结束才有值，运行中常年是 0。
  // 显示 "0 tokens" 会被读成"它没在动"，比不显示更糟——有值才显示。
  if (stats?.totalTokens) parts.push(`${formatTokens(stats.totalTokens)} tokens`)
  if (typeof stats?.totalToolUseCount === 'number') parts.push(`${stats.totalToolUseCount} 次工具`)
  return parts.join(' · ')
})

const statusTextClass = computed(() => {
  if (props.tool.status === 'running') return 'text-muted-foreground animate-pulse'
  if (props.tool.status === 'failed' && props.tool.taskStats?.status !== 'stopped') {
    return 'text-destructive'
  }
  return 'text-muted-foreground/80'
})
</script>
