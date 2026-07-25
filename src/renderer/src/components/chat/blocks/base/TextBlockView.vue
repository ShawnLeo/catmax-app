<template>
  <div v-if="block.text.trim()" class="leading-relaxed text-[15px] whitespace-pre-wrap break-words">
    <MarkdownView v-if="messageRole === 'assistant'" :text="block.text" />
    <template v-else>{{ block.text }}</template>
  </div>
</template>

<script setup lang="ts">
import type { TextContentBlock } from '@shared/backend/blocks'

import MarkdownView from '../../MarkdownView.vue'

defineProps<{ block: TextContentBlock; messageRole?: string }>()
</script>
