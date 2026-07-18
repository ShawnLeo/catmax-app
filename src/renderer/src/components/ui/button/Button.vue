<script setup lang="ts">
import { cn } from '@renderer/lib/utils'
import type { HTMLAttributes } from 'vue'

import { buttonVariants, type ButtonVariants } from '.'

interface Props {
  variant?: ButtonVariants['variant']
  size?: ButtonVariants['size']
  class?: HTMLAttributes['class']
  disabled?: boolean
  type?: 'button' | 'submit' | 'reset'
}

const props = withDefaults(defineProps<Props>(), {
  type: 'button',
})

const emits = defineEmits<{
  click: [event: MouseEvent]
}>()

function onClick(event: MouseEvent): void {
  if (!props.disabled) emits('click', event)
}
</script>

<template>
  <button
    :type="type"
    :disabled="disabled"
    :class="cn(buttonVariants({ variant, size }), props.class)"
    @click="onClick"
  >
    <slot />
  </button>
</template>
