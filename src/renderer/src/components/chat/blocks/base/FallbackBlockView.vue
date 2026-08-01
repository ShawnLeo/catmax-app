<template>
  <details
    class="rounded border border-border/60 p-2 text-[length:var(--chat-text-d1)] text-muted-foreground"
  >
    <summary>未知内容块：{{ block.type }}</summary>
    <pre class="mt-2 overflow-auto whitespace-pre-wrap">{{ JSON.stringify(block, null, 2) }}</pre>
  </details>
</template>

<script setup lang="ts">
import type { BaseContentBlock } from '@shared/backend/blocks'

defineProps<{ block: BaseContentBlock }>()
</script>
