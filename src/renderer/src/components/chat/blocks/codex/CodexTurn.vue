<template>
  <section class="min-w-0">
    <button
      type="button"
      class="flex w-full items-center gap-1.5 border-b border-border/70 pb-2 text-left text-[13px] text-muted-foreground hover:text-foreground"
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

    <div
      v-if="sections.finalBlocks.length"
      :class="open && sections.processBlocks.length ? 'mt-5' : 'pt-4'"
      class="space-y-3"
    >
      <MarkdownView v-for="block in sections.finalBlocks" :key="block.id" :text="block.text" />
    </div>

    <CodexChangesCard v-if="changedFiles.length" :files="changedFiles" :stats="changeStats" />
  </section>
</template>

<script setup lang="ts">
import type {
  CodexActivityContentBlock,
  CodexDiffStats,
  CodexFileChange,
  ReasoningContentBlock,
} from '@shared/backend/blocks'
import type { NormalizedMessage } from '@shared/backend/types'
import { ChevronDownIcon } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'

import MarkdownView from '../../MarkdownView.vue'

import CodexActivityBlockView from './CodexActivityBlockView.vue'
import CodexChangesCard from './CodexChangesCard.vue'
import CodexToolCallBlockView from './CodexToolCallBlockView.vue'
import { splitCodexTurn } from './conversation'
import PlanBlockView from './PlanBlockView.vue'

const props = defineProps<{
  messages: NormalizedMessage[]
  cwd?: string | undefined
  running?: boolean | undefined
}>()

// A live turn starts open and stays where the user left it. A freshly loaded history starts closed.
const open = ref(props.running === true)
watch(
  () => props.running,
  (running) => {
    if (running) open.value = true
  },
)

const sections = computed(() => splitCodexTurn(props.messages))
const durationMs = computed(() => {
  const reasoning = sections.value.reasoningBlocks.find(
    (block): block is ReasoningContentBlock => block.type === 'reasoning',
  )
  if (reasoning?.durationMs !== undefined) return reasoning.durationMs
  if (reasoning?.startedAt !== undefined && reasoning.endedAt !== undefined) {
    return Math.max(0, reasoning.endedAt - reasoning.startedAt)
  }
  return undefined
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
const changedFiles = computed<CodexFileChange[]>(() => {
  const byPath = new Map<string, CodexFileChange>()
  for (const block of activityBlocks.value) {
    for (const activity of block.activities) {
      if (activity.kind !== 'file_change') continue
      for (const change of activity.changes) byPath.set(change.path, change)
    }
  }
  return [...byPath.values()]
})
const changeStats = computed<CodexDiffStats>(() => {
  let turnStats: CodexDiffStats | undefined
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
