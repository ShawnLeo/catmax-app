<template>
  <ToolCallInline v-if="isInline" :tool="block" />
  <ToolCallCard v-else :tool="block" :cwd="cwd ?? ''" :show-thinking="showThinking ?? true" />
</template>

<script setup lang="ts">
import type { ToolCallContentBlock } from '@shared/backend/blocks'
import { computed } from 'vue'

import ToolCallCard from '../../tools/ToolCallCard.vue'
import ToolCallInline from '../../tools/ToolCallInline.vue'

const props = defineProps<{
  block: ToolCallContentBlock
  cwd?: string
  showThinking?: boolean
}>()

const isInline = computed(
  () => props.block.info.kind === 'file_read' && /^Read:/.test(props.block.info.title),
)
</script>
