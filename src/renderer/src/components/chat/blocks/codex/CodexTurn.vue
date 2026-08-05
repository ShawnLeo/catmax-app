<template>
  <section class="min-w-0">
    <!-- 处理中态始终展示；已完成态仅在展开有内容时展示，避免空"已处理"行。 -->
    <button
      v-if="running || sections.processBlocks.length"
      type="button"
      class="flex w-full items-center gap-1.5 border-b border-border/70 pb-2 text-left text-[length:var(--chat-text-base)] text-muted-foreground hover:text-foreground"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span>{{ running ? '处理中' : '已处理' }}</span>
      <span v-if="durationLabel" class="tabular-nums">{{ durationLabel }}</span>
      <ChevronDownIcon
        class="size-3.5 transition-transform"
        :class="open ? 'rotate-180' : '-rotate-90'"
      />
    </button>

    <div v-if="open && sections.processBlocks.length" class="space-y-4 pt-4">
      <template v-for="block in sections.processBlocks" :key="block.id">
        <MarkdownView
          v-if="block.type === 'text' && block.text.trim()"
          :text="block.text"
          compact
          class="text-foreground"
        />
        <CodexActivityBlockView
          v-else-if="block.type === 'codex_activity'"
          :block="block"
          :cwd="cwd"
        />
        <CodexToolCallBlockView v-else-if="block.type === 'tool_call'" :block="block" />
        <PlanBlockView v-else-if="block.type === 'plan'" :block="block" />
      </template>
    </div>

    <!-- Generated Images: 生成结果是回合产物，不随默认折叠的处理日志隐藏。 -->
    <CodexGeneratedImageGallery
      v-if="sections.generatedImageBlocks.length"
      :blocks="sections.generatedImageBlocks"
      class="mt-4"
    />

    <div
      v-if="sections.finalBlocks.length"
      :class="open && sections.processBlocks.length ? 'mt-5' : 'pt-4'"
      class="space-y-3"
    >
      <MarkdownView v-for="block in sections.finalBlocks" :key="block.id" :text="block.text" />
    </div>

    <ChangesCard v-if="changedFiles.length" :files="changedFiles" :stats="changeStats" />

    <!-- Codex Turn Thinking: 始终跟在当前已输出内容之后，保持为回合最末状态。 -->
    <div
      v-if="running"
      class="flex items-center gap-2 pt-3 text-[length:var(--chat-text-base)] text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <span class="size-1.5 rounded-full bg-current animate-pulse" aria-hidden="true" />
      <span>正在思考</span>
      <LoadingDots :dot-size="3" :duration="1.6" />
    </div>
  </section>
</template>

<script setup lang="ts">
import type { DiffStats } from '@renderer/lib/diff-stats'
import { reviewFileFromCodexChange, type ReviewFile } from '@renderer/lib/review'
import type { CodexActivityContentBlock, ReasoningContentBlock } from '@shared/backend/blocks'
import type { NormalizedMessage } from '@shared/backend/types'
import { ChevronDownIcon } from 'lucide-vue-next'
import { computed, onUnmounted, ref, watch } from 'vue'

import ChangesCard from '../../changes/ChangesCard.vue'
import LoadingDots from '../../messages/LoadingDots.vue'

import CodexActivityBlockView from './CodexActivityBlockView.vue'
import CodexGeneratedImageGallery from './CodexGeneratedImageGallery.vue'
import CodexToolCallBlockView from './CodexToolCallBlockView.vue'
import { splitCodexTurn } from './conversation'
import MarkdownView from './MarkdownView.vue'
import PlanBlockView from './PlanBlockView.vue'

const props = defineProps<{
  messages: NormalizedMessage[]
  cwd?: string | undefined
  running?: boolean | undefined
}>()

// A live turn starts open, then auto-collapses when it ends. A freshly loaded history starts closed.
const open = ref(props.running === true)
watch(
  () => props.running,
  (running) => {
    open.value = running === true
  },
)

const sections = computed(() => splitCodexTurn(props.messages, { running: props.running === true }))

/**
 * 本轮首个活动 message 的 createdAt ——
 * upsertCodexActivityBlock 在首次插入活动 message 时写 Date.now()（见 message.ts）。
 * 这是 running 态的实时计时起点（用户选定的"首个活动开始时间"口径）。
 * 历史回放时 message.createdAt = 0，但 running 态只在实时流时为 true，不会走到这里。
 */
const activityStartedAt = computed(() => {
  for (const message of props.messages) {
    if (message.blocks?.some((block) => block.type === 'codex_activity')) {
      return message.createdAt
    }
  }
  return undefined
})

/**
 * 处理中（running）态用 1s tick 的 now 拿到递增的"已运行"时长；
 * 组件 unmount 或转完成时清理 interval，避免泄漏。多 turn 并发时每个 CodexTurn
 * 实例独立计时（各自的 startedAt + now），互不干扰。
 */
const now = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null
watch(
  () => !!props.running && activityStartedAt.value !== undefined,
  (shouldTick) => {
    if (shouldTick && !tickTimer) {
      now.value = Date.now()
      tickTimer = setInterval(() => {
        now.value = Date.now()
      }, 1000)
    } else if (!shouldTick && tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  },
  { immediate: true },
)

/**
 * running → false 的瞬间冻结 turn 结束时刻。completed 态用它算「首个活动起 → 结束」
 * 的总时长——跟 running 计时同口径，避免回落到 reasoning 的「思考时长」
 * （后者通常远小于总时长，会被 durationLabel 的 Math.max(1, …) 拉成"1s"）。
 *
 * 仅覆盖实时流刚结束的 turn：历史回放时 message.createdAt = 0，activityStartedAt
 * 也为 0，下面的 > 0 守卫会跳过本路，回落到 reasoning.durationMs（app-server 权威值）。
 */
const turnEndedAt = ref<number | undefined>(undefined)
watch(
  () => props.running,
  (running, prev) => {
    if (prev && !running && activityStartedAt.value !== undefined && activityStartedAt.value > 0) {
      turnEndedAt.value = Date.now()
    }
  },
)
onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
})

/**
 * 顶部状态行耗时（毫秒），取值优先级递减：
 *   1. running 态：now - activityStartedAt（实时递增，处理中态专用）
 *   2. completed 态：reasoning.durationMs（历史回放，app-server 的 turn.durationMs 权威值）
 *   3. completed 态（实时流刚结束）：turnEndedAt - activityStartedAt（与 running 同口径的总时长）
 *   4. completed 态、有 reasoning 边界：endedAt - startedAt（思考时长，兜底）
 *   5. completed 态、无 reasoning：所有 codex_activity 块 durationMs 之和（兜底）
 * 都拿不到 → undefined → durationLabel 为空，不显示。
 */
const durationMs = computed(() => {
  if (props.running) {
    const started = activityStartedAt.value
    if (started !== undefined && started > 0) return Math.max(0, now.value - started)
  }
  const reasoning = sections.value.reasoningBlocks.find(
    (block): block is ReasoningContentBlock => block.type === 'reasoning',
  )
  if (reasoning?.durationMs !== undefined) return reasoning.durationMs
  // 实时流刚结束：用与 running 计时同口径的「首个活动起 → 结束」总时长，
  // 不回落到 reasoning 思考时长（模型很快决定动手时思考时长≈0，会被拉成"1s"）。
  if (
    turnEndedAt.value !== undefined &&
    activityStartedAt.value !== undefined &&
    activityStartedAt.value > 0
  ) {
    return Math.max(0, turnEndedAt.value - activityStartedAt.value)
  }
  if (reasoning?.startedAt !== undefined && reasoning.endedAt !== undefined) {
    return Math.max(0, reasoning.endedAt - reasoning.startedAt)
  }
  // 兜底：无 reasoning 的 turn（直接跑命令）—— 活动块 durationMs 在 message.ts 已聚合。
  const activityTotal = sections.value.processBlocks
    .filter((block): block is CodexActivityContentBlock => block.type === 'codex_activity')
    .reduce((total, block) => total + (block.durationMs ?? 0), 0)
  return activityTotal > 0 ? activityTotal : undefined
})
const durationLabel = computed(() => {
  if (durationMs.value === undefined) return ''
  const seconds = Math.max(1, Math.round(durationMs.value / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
})

const activityBlocks = computed(() =>
  sections.value.processBlocks.filter(
    (block): block is CodexActivityContentBlock => block.type === 'codex_activity',
  ),
)
// codex 的 file_change 每次下发的都是「该文件本轮至今的累计 diff」，所以按 path
// 覆盖式收集即可，最后一次就是最终结果——不像 claude 需要把多次编辑串起来。
const changedFiles = computed<ReviewFile[]>(() => {
  const byPath = new Map<string, ReviewFile>()
  for (const block of activityBlocks.value) {
    for (const activity of block.activities) {
      if (activity.kind !== 'file_change') continue
      for (const change of activity.changes) {
        byPath.set(change.path, reviewFileFromCodexChange(change))
      }
    }
  }
  return [...byPath.values()]
})
const changeStats = computed<DiffStats>(() => {
  let turnStats: DiffStats | undefined
  for (let index = activityBlocks.value.length - 1; index >= 0; index--) {
    turnStats = activityBlocks.value[index]?.turnDiffStats
    if (turnStats) break
  }
  if (turnStats) return turnStats
  return changedFiles.value.reduce(
    (total, file) => ({
      additions: total.additions + file.stats.additions,
      deletions: total.deletions + file.stats.deletions,
    }),
    { additions: 0, deletions: 0 },
  )
})
</script>
