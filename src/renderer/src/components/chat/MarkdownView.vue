<template>
  <div class="markdown-body" v-html="rendered" />
</template>

<script setup lang="ts">
import { renderMarkdown } from '@renderer/lib/markdown'
import { ref, watch } from 'vue'

const props = defineProps<{ text: string }>()
const rendered = ref('')

watch(
  () => props.text,
  async (text) => {
    try {
      rendered.value = await renderMarkdown(text)
    } catch {
      // fallback：直接显示纯文本
      rendered.value = `<p>${text.replace(/</g, '&lt;')}</p>`
    }
  },
  { immediate: true },
)
</script>

<style scoped>
.markdown-body :deep(p) {
  margin: 0 0 0.5em;
}
.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}
.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 0.5em 0;
  padding-left: 1.5em;
}
.markdown-body :deep(code) {
  @apply font-mono text-[13px] bg-muted px-1 py-0.5 rounded;
}
.markdown-body :deep(pre) {
  @apply bg-code-block text-foreground rounded-md p-3 my-2 overflow-x-auto;
}
.markdown-body :deep(pre code) {
  @apply bg-transparent p-0;
}
.markdown-body :deep(a) {
  @apply text-primary underline;
}
.markdown-body :deep(blockquote) {
  @apply border-l-2 border-border pl-3 italic text-muted-foreground my-2;
}
</style>
