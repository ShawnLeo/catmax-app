<template>
  <span class="group relative inline-flex shrink-0 align-middle">
    <button
      type="button"
      class="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      :aria-label="label"
    >
      <CircleHelpIcon class="h-3.5 w-3.5" />
    </button>
    <span
      role="tooltip"
      class="pointer-events-none absolute left-1/2 top-full z-50 mt-2 hidden w-72 -translate-x-1/2 rounded-md border border-sidebar-border bg-popover px-3 py-2 text-left text-[length:var(--ui-text-d3)] font-normal leading-relaxed text-popover-foreground shadow-md group-hover:block group-focus-within:block"
    >
      <slot />
    </span>
  </span>
</template>

<script setup lang="ts">
import { CircleHelpIcon } from 'lucide-vue-next'

withDefaults(defineProps<{ label?: string }>(), {
  label: '查看说明',
})
</script>
