<template>
  <nav
    aria-label="会话消息导航"
    class="pointer-events-none absolute left-4 top-1/2 z-30 flex h-auto max-h-[calc(100%-2rem)] w-10 -translate-y-1/2 flex-col justify-center"
    @mouseleave="hoveredIndex = null"
  >
    <div
      v-for="(message, index) in userMessages"
      :key="message.id"
      data-rail-item
      class="group pointer-events-auto relative flex h-[9px] min-h-[3px] w-10 shrink items-center"
      @mouseenter="hoveredIndex = index"
    >
      <button
        type="button"
        :aria-current="anchorApi?.activeId.value === message.id ? 'location' : undefined"
        :aria-describedby="previewIndex === index ? tooltipId(index) : undefined"
        :aria-label="`跳转到第 ${index + 1} 条消息：${navigationPreview(message)}`"
        class="flex h-full w-full items-center rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        @blur="onBlur(index)"
        @click="onNavigate(message.id, $event)"
        @focus="focusedIndex = index"
      >
        <span
          aria-hidden="true"
          :style="{ width: railWidth(index) }"
          :class="[
            'block rounded-full transition-[width,height,background-color] duration-150 ease-out motion-reduce:transition-none',
            isEmphasized(index, message.id) ? 'h-0.5 bg-foreground' : 'h-px bg-muted-foreground/45',
          ]"
        />
      </button>
      <div
        :id="tooltipId(index)"
        role="tooltip"
        :class="[
          'absolute left-full top-1/2 z-50 -translate-y-1/2 pl-2 transition-opacity duration-150 motion-reduce:transition-none',
          previewIndex === index
            ? 'pointer-events-auto visible opacity-100'
            : 'pointer-events-none invisible opacity-0',
        ]"
        @click.stop
        @wheel.stop
      >
        <div
          class="max-h-[50vh] w-80 max-w-[calc(100vw-4rem)] overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-popover px-2.5 py-2 text-[length:var(--ui-text-d3)] font-normal leading-relaxed text-popover-foreground shadow-lg"
        >
          {{ navigationMessageText(message) }}
        </div>
      </div>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { MESSAGE_ANCHOR_KEY } from '@renderer/composables/useMessageAnchors'
import { navigationMessageText, navigationPreview } from '@renderer/lib/message-navigation'
import type { NormalizedMessage } from '@shared/backend/types'
import { computed, inject, ref, useId } from 'vue'

defineProps<{ userMessages: NormalizedMessage[] }>()

const anchorApi = inject(MESSAGE_ANCHOR_KEY, null)
const componentId = useId()
const hoveredIndex = ref<number | null>(null)
const focusedIndex = ref<number | null>(null)
const previewIndex = computed(() => hoveredIndex.value ?? focusedIndex.value)

const DEFAULT_WIDTH = 8
const STAIR_WIDTHS = [24, 18, 13] as const

/** Codex-style proximity staircase: hovered/focused, neighbor, next neighbor, default. */
function railWidth(index: number): string {
  const interactionIndex = previewIndex.value
  if (interactionIndex === null) return `${DEFAULT_WIDTH}px`
  const distance = Math.abs(index - interactionIndex)
  return `${STAIR_WIDTHS[distance] ?? DEFAULT_WIDTH}px`
}

function isEmphasized(index: number, messageId: string): boolean {
  const interactionIndex = previewIndex.value
  if (interactionIndex !== null) return interactionIndex === index
  return anchorApi?.activeId.value === messageId
}

function onNavigate(messageId: string, event: MouseEvent): void {
  anchorApi?.scrollToMessage(messageId)
  // Pointer clicks should not leave a sticky focus tooltip behind. Keyboard activation keeps focus.
  if (event.detail > 0) {
    focusedIndex.value = null
    const target = event.currentTarget as HTMLElement | null
    target?.blur()
  }
}

function onBlur(index: number): void {
  if (focusedIndex.value === index) focusedIndex.value = null
}

function tooltipId(index: number): string {
  return `${componentId}-message-nav-tooltip-${index}`
}
</script>
