<template>
  <div class="flex flex-col gap-7">
    <template v-for="entry in entries" :key="entry.id">
      <CodexUserMessage v-if="entry.kind === 'user'" :message="entry.message" />
      <CompactHistoryEntry v-else-if="entry.kind === 'compact'" :summary="entry.summary" />
      <CodexTurn
        v-else
        :messages="entry.messages"
        :cwd="cwd"
        :running="running && entry.turnId === currentTurnId"
      />
    </template>
    <CodexTurn
      v-if="running && currentTurnId && !hasCurrentTurn"
      :messages="[]"
      :cwd="cwd"
      running
    />
  </div>
</template>

<script setup lang="ts">
import type { NormalizedMessage } from '@shared/backend/types'
import { computed } from 'vue'

import CompactHistoryEntry from '../../CompactHistoryEntry.vue'

import CodexTurn from './CodexTurn.vue'
import CodexUserMessage from './CodexUserMessage.vue'
import { buildCodexConversationEntries } from './conversation'

const props = defineProps<{
  messages: NormalizedMessage[]
  cwd?: string | undefined
  showThinking?: boolean | undefined
  running?: boolean | undefined
  currentTurnId?: string | null | undefined
}>()

const entries = computed(() => buildCodexConversationEntries(props.messages))
const hasCurrentTurn = computed(() =>
  entries.value.some((entry) => entry.kind === 'turn' && entry.turnId === props.currentTurnId),
)
</script>
