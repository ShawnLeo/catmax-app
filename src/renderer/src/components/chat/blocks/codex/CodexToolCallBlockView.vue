<template>
  <div class="text-[length:var(--chat-text-base)] text-muted-foreground">
    <button
      type="button"
      class="flex max-w-full items-center gap-2 py-0.5 text-left hover:text-foreground"
      @click="open = !open"
    >
      <LoaderCircleIcon v-if="block.status === 'running'" class="size-3.5 animate-spin" />
      <WrenchIcon v-else class="size-3.5" />
      <span class="truncate">{{ statusLabel }} {{ block.info.title }}</span>
      <ChevronDownIcon
        v-if="hasDetails"
        class="size-3 transition-transform"
        :class="open ? 'rotate-180' : ''"
      />
    </button>
    <pre
      v-if="open && hasDetails"
      class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/30 px-3 py-2 font-mono text-[length:var(--chat-text-d2)]"
      >{{ details }}</pre>
  </div>
</template>

<script setup lang="ts">
import type { ToolCallContentBlock } from '@shared/backend/blocks'
import { ChevronDownIcon, LoaderCircleIcon, WrenchIcon } from 'lucide-vue-next'
import { computed, ref } from 'vue'

const props = defineProps<{ block: ToolCallContentBlock }>()
const open = ref(false)
const statusLabel = computed(() => {
  if (props.block.status === 'running') return '正在运行'
  if (props.block.status === 'failed') return '运行失败'
  return '已运行'
})
const details = computed(() => props.block.output?.output ?? props.block.info.detail ?? '')
const hasDetails = computed(() => details.value.length > 0)
</script>
