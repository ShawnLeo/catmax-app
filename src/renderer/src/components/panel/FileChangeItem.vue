<template>
  <button
    class="w-full flex items-center gap-2 text-[length:var(--ui-text-d3)] px-2 py-1 hover:bg-muted rounded cursor-pointer"
    :title="file.path"
  >
    <span :class="['w-2 h-2 rounded-full flex-shrink-0', statusColor]" />
    <span class="font-mono text-foreground truncate flex-1 text-left">{{ file.path }}</span>
    <span class="text-muted-foreground flex-shrink-0">{{ file.status }}</span>
  </button>
</template>

<script setup lang="ts">
import type { FileChange } from '@shared/ipc/git'
import { computed } from 'vue'

const props = defineProps<{ file: FileChange }>()

const statusColor = computed(() => {
  switch (props.file.status) {
    case 'added':
      return 'bg-success'
    case 'modified':
      return 'bg-warning'
    case 'deleted':
      return 'bg-destructive'
    case 'renamed':
      return 'bg-primary'
    default:
      return 'bg-muted-foreground'
  }
})
</script>
