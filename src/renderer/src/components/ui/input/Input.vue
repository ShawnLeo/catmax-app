<script setup lang="ts">
import { cn } from '@renderer/lib/utils'
import type { HTMLAttributes } from 'vue'

interface Props {
  modelValue?: string | number
  defaultValue?: string | number
  class?: HTMLAttributes['class']
}

const props = defineProps<Props>()
const emits = defineEmits<{
  'update:modelValue': [value: string | number]
}>()

function onInput(e: Event): void {
  const target = e.target as HTMLInputElement
  const value = typeof props.modelValue === 'number' ? target.valueAsNumber : target.value
  emits('update:modelValue', value)
}
</script>

<template>
  <input
    :value="modelValue ?? defaultValue"
    :class="
      cn(
        'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        props.class,
      )
    "
    @input="onInput"
  />
</template>
