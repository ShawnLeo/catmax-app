<template>
  <div class="border-b border-border px-4 py-2 flex items-center gap-2 bg-background">
    <!-- Stub: replaced by full implementation in Task 15 -->
  </div>
</template>

<script setup lang="ts">
import type { EffortLevel, PermissionMode } from '@shared/backend/types'

defineProps<{
  modelValue: {
    model: string | null
    effort: EffortLevel | null
    permissionMode: PermissionMode
  }
}>()

defineEmits<{
  'update:modelValue': [
    value: {
      model: string | null
      effort: EffortLevel | null
      permissionMode: PermissionMode
    },
  ]
}>()
</script>
