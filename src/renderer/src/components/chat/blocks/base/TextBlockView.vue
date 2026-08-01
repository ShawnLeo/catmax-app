<template>
  <!--
    whitespace-pre-wrap 只能套在纯文本分支上。
    assistant 分支走 MarkdownView（markdown-it 产出的结构化 HTML），段落间距由
    .markdown-body 的 p margin 精确控制；若外层再叠 pre-wrap，块级元素之间的 "\n"
    会被保留成匿名行框，凭空多撑出一行行高，叠加 margin 后段落间距过大。
    pre-wrap 仅给纯文本分支（用户消息）用——保留换行+折行。
  -->
  <div
    v-if="block.text.trim()"
    class="leading-relaxed text-[length:var(--chat-text-u2)] break-words"
  >
    <MarkdownView v-if="messageRole === 'assistant'" :text="block.text" />
    <div v-else class="whitespace-pre-wrap">{{ block.text }}</div>
  </div>
</template>

<script setup lang="ts">
import type { TextContentBlock } from '@shared/backend/blocks'

import MarkdownView from './MarkdownView.vue'

defineProps<{ block: TextContentBlock; messageRole?: string }>()
</script>
