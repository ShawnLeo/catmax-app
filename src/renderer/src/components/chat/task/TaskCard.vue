<template>
  <!--
    Task 工具卡片--子 agent 调用。

    三态显示（把子 Agent 从黑盒变成可观测）：
      - running：显示 description + 实时计时器"已运行 12s"（子 Agent 可能跑几十秒到几分钟）
      - completed：显示 description + 统计摘要"153s · 31.6k tokens · 5 次工具调用"
      - failed：同 completed 但标红

    prompt 仍然可折叠展示（这是子 Agent 接到的任务描述）。
    统计数据来自 claude CLI 的 tool_use_result 顶层字段（耗时/token/工具分类计数）。

    完成后有 agentId 时显示"展开子会话"按钮，点击读取 subagent jsonl 并渲染为嵌套消息列表。
  -->
  <div class="space-y-1.5 py-0.5">
    <!-- description + 状态摘要 -->
    <div class="flex items-center gap-1.5 text-[13px]">
      <BotIcon class="w-3.5 h-3.5 text-primary flex-shrink-0" />
      <span class="font-medium text-foreground flex-1 min-w-0 truncate">{{
        task.description
      }}</span>
      <!-- 右侧状态/统计摘要 -->
      <span class="flex-shrink-0 text-[11px] font-mono" :class="statusTextClass">
        {{ statusSummary }}
      </span>
    </div>

    <!-- prompt（可折叠） -->
    <div v-if="task.prompt" class="pl-5">
      <pre
        class="font-mono text-[12px] text-muted-foreground whitespace-pre-wrap break-words leading-relaxed"
        :class="expanded ? '' : 'line-clamp-3'"
        >{{ task.prompt }}</pre>
      <button
        v-if="task.prompt.split('\n').length > 3 || task.prompt.length > 200"
        class="text-[11px] text-primary hover:underline mt-1"
        @click="expanded = !expanded"
      >
        {{ expanded ? '收起' : '展开全部' }}
      </button>
    </div>

    <!-- 子 Agent 过程展开按钮（仅完成且有 agentId 时显示） -->
    <div v-if="canShowSubagentButton" class="pl-5 pt-1">
      <button
        class="text-[11px] text-primary hover:underline"
        :disabled="loadingSubagent"
        @click="onToggleSubagent"
      >
        {{ subagentExpanded ? '收起子会话' : '展开子会话' }}
      </button>
    </div>

    <!-- 子 Agent 消息列表（嵌套渲染，复用 MessageItem） -->
    <div
      v-if="subagentExpanded && subagentMessages.length > 0"
      class="pl-4 border-l border-border/40"
    >
      <MessageItem
        v-for="msg in subagentMessages"
        :key="msg.id"
        :message="msg"
        :show-thinking="showThinking ?? true"
        :cwd="props.cwd"
      />
      <div
        v-if="subagentMessages.length === 0 && !loadingSubagent"
        class="text-[11px] text-muted-foreground"
      >
        子 Agent 过程不可用（jsonl 文件不存在）
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useBackendStore } from '@renderer/stores/backend'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { ToolTaskInfo, ToolTaskStats } from '@shared/backend/types'
import type { NormalizedMessage } from '@shared/backend/types'
import { BotIcon } from 'lucide-vue-next'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import MessageItem from '../MessageItem.vue'

const props = defineProps<{
  task: ToolTaskInfo
  /** 完整 tool block--拿 status / startedAt / taskStats 算状态摘要 */
  tool: NonNullable<NormalizedMessage['toolBlocks']>[number]
  /** 工作区目录--读 subagent jsonl 需要 */
  cwd: string
  /** 是否显示思考块（透传给子 agent 的 MessageItem） */
  showThinking?: boolean
}>()

const expanded = ref(false)
const subagentExpanded = ref(false)
const subagentMessages = ref<NormalizedMessage[]>([])
const loadingSubagent = ref(false)
const backendStore = useBackendStore()
const workspaceStore = useWorkspaceStore()

/**
 * 能否显示"展开子会话"按钮？
 * 条件：Task 已完成 + 有 agentId（stats 里带）
 */
const canShowSubagentButton = computed(() => {
  return (
    props.tool.status === 'completed' &&
    props.tool.taskStats?.agentId &&
    props.tool.taskStats.agentId.length > 0
  )
})

/** 切换子会话展开状态 */
async function onToggleSubagent(): Promise<void> {
  if (subagentExpanded.value) {
    subagentExpanded.value = false
    return
  }

  // 首次展开时读取 subagent jsonl
  if (subagentMessages.value.length === 0 && !loadingSubagent.value) {
    const agentId = props.tool.taskStats?.agentId
    if (!agentId) return

    loadingSubagent.value = true
    try {
      // 调 IPC 读取 subagent 历史
      subagentMessages.value = await window.api.session.readSubagentHistory({
        backend: backendStore.currentId,
        agentId,
        cwd: props.cwd,
      })
    } catch (e) {
      console.error('Failed to read subagent history:', e)
    } finally {
      loadingSubagent.value = false
    }
  }

  subagentExpanded.value = true
}

/**
 * 实时计时器--只在 running 态跑。
 * 用 requestAnimationFrame 节流到秒级刷新（1s 一次足够，不必 60fps）。
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
    } else {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
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

/** 状态摘要文本 */
const statusSummary = computed(() => {
  if (props.tool.status === 'running') {
    return elapsedSec.value !== null ? `运行中 ${formatSeconds(elapsedSec.value)}` : '运行中'
  }
  const stats = props.tool.taskStats
  if (!stats) {
    return props.tool.status === 'failed' ? '失败' : '完成'
  }
  const parts: string[] = []
  if (elapsedSec.value !== null) parts.push(formatSeconds(elapsedSec.value))
  if (typeof stats.totalTokens === 'number') parts.push(`${formatTokens(stats.totalTokens)} tokens`)
  if (typeof stats.totalToolUseCount === 'number') parts.push(`${stats.totalToolUseCount} 次工具`)
  return parts.length > 0 ? parts.join(' · ') : props.tool.status === 'failed' ? '失败' : '完成'
})

const statusTextClass = computed(() => {
  if (props.tool.status === 'running') return 'text-muted-foreground animate-pulse'
  if (props.tool.status === 'failed') return 'text-destructive'
  return 'text-muted-foreground/80'
})

// 消除未使用 import 警告（ToolTaskStats 类型只用于文档注释语义）
void (null as unknown as ToolTaskStats)
</script>

<style scoped>
.line-clamp-3 {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
