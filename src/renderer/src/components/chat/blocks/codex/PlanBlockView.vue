<template>
  <details class="rounded-lg border border-border/60 bg-muted/20 p-3" open>
    <summary class="cursor-pointer text-xs font-medium text-muted-foreground">实施计划</summary>
    <MarkdownView class="mt-2 text-[14px]" :text="block.text" />
  </details>
</template>

<script setup lang="ts">
import type { PlanContentBlock } from '@shared/backend/blocks'

import MarkdownView from './MarkdownView.vue'

defineProps<{ block: PlanContentBlock }>()
</script>
