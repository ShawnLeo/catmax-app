<template>
  <ThinkingBlock
    v-if="showThinking !== false && block.text.trim()"
    :text="block.text"
    :streaming="streaming ?? false"
    :duration-sec="durationSec ?? null"
    :completed-label="block.completedLabel"
  />
</template>

<script setup lang="ts">
import type { ReasoningContentBlock } from '@shared/backend/blocks'

import ThinkingBlock from '../../ThinkingBlock.vue'

defineProps<{
  block: ReasoningContentBlock
  showThinking?: boolean
  streaming?: boolean
  durationSec?: number | null
}>()
</script>
