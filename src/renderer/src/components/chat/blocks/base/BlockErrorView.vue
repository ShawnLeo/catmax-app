<template>
  <div class="text-[length:var(--chat-text-d1)] text-destructive">
    内容块渲染失败：{{ block.type }}
  </div>
</template>

<script setup lang="ts">
import type { BaseContentBlock } from '@shared/backend/blocks'

defineProps<{ block: BaseContentBlock }>()
</script>
