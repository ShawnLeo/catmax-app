<template>
  <!--
    Markdown 渲染容器。

    - 由 markdown.ts 输出 HTML 通过 v-html 注入（GFM、代码块高亮、任务列表已在 render 阶段处理）
    - 代码块的"复制"按钮靠事件委托：markdown.ts 给每个 fence 包了 [data-action="copy-code"]，
      这里在容器上监听 click，向上找最近的 .code-block-wrapper，取其 pre code 文本写剪贴板
    - 任务列表的 checkbox 可点（本地状态，刷新会丢——临时检查清单语义）
  -->
  <div ref="container" class="markdown-body" @click="onClick" v-html="rendered" />
</template>

<script setup lang="ts">
import { renderMarkdown } from '@renderer/lib/markdown'
import { ref, watch } from 'vue'

const props = defineProps<{ text: string }>()
const rendered = ref('')
const container = ref<HTMLElement | null>(null)

watch(
  () => props.text,
  async (text) => {
    try {
      rendered.value = await renderMarkdown(text)
    } catch {
      // fallback：直接显示转义后的纯文本
      rendered.value = `<p>${text.replace(/</g, '&lt;')}</p>`
    }
  },
  { immediate: true },
)

/**
 * 事件委托：点 [data-action="copy-code"] 复制对应代码块。
 * 不在 render 阶段绑事件——v-html 出来的 DOM 不归 Vue 管，事件委托最省事。
 */
function onClick(e: MouseEvent): void {
  const target = e.target as HTMLElement | null
  if (!target) return
  const btn = target.closest('[data-action="copy-code"]') as HTMLElement | null
  if (!btn) return
  const wrapper = btn.closest('.code-block-wrapper')
  const codeEl = wrapper?.querySelector('pre code')
  const text = codeEl?.textContent ?? ''
  void navigator.clipboard.writeText(text).then(
    () => {
      btn.textContent = '已复制'
      setTimeout(() => {
        btn.textContent = '复制'
      }, 1500)
    },
    () => {
      // 剪贴板权限被拒或不可用——保持原样
    },
  )
}
</script>

<style scoped>
@reference "../../assets/styles/main.css";

/* ============ 整体排版基准 ============ */
.markdown-body {
  @apply text-[15px] leading-relaxed;
  overflow-wrap: anywhere;
}

/* ============ 标题层级（h1-h6 字号梯度） ============ */
.markdown-body :deep(h1) {
  @apply text-2xl font-semibold mt-6 mb-3;
}
.markdown-body :deep(h2) {
  @apply text-xl font-semibold mt-5 mb-2;
}
.markdown-body :deep(h3) {
  @apply text-lg font-semibold mt-4 mb-2;
}
.markdown-body :deep(h4) {
  @apply text-base font-semibold mt-3 mb-1;
}
.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  @apply text-sm font-semibold mt-2 mb-1 text-muted-foreground;
}

/* ============ 段落 / 首尾间距归零 ============ */
.markdown-body :deep(p) {
  @apply my-2;
}
.markdown-body :deep(:first-child) {
  @apply mt-0;
}
.markdown-body :deep(:last-child) {
  @apply mb-0;
}

/* ============ 列表 ============ */
.markdown-body :deep(ul) {
  @apply my-2 list-disc pl-6;
}
.markdown-body :deep(ol) {
  @apply my-2 list-decimal pl-6;
}
.markdown-body :deep(li) {
  @apply my-0.5;
}
.markdown-body :deep(li > ul),
.markdown-body :deep(li > ol) {
  @apply my-1;
}

/* GFM 任务列表（markdown-it-task-lists 输出 <li class="task-list-item">） */
.markdown-body :deep(.task-list-item) {
  @apply list-none pl-0;
}
.markdown-body :deep(.task-list-item > input[type='checkbox']) {
  @apply mr-2 align-middle cursor-pointer;
  accent-color: var(--color-primary);
}

/* ============ 表格（GFM） ============ */
.markdown-body :deep(table) {
  @apply my-3 w-full border-collapse text-sm overflow-hidden;
}
.markdown-body :deep(thead) {
  @apply bg-muted;
}
.markdown-body :deep(th) {
  @apply px-3 py-1.5 text-left font-semibold border border-border;
}
.markdown-body :deep(td) {
  @apply px-3 py-1.5 border border-border;
}
.markdown-body :deep(tbody tr:nth-child(even)) {
  @apply bg-muted/30;
}

/* ============ 代码块 wrapper（markdown.ts 注入的 header + body） ============ */
.markdown-body :deep(.code-block-wrapper) {
  @apply my-3 rounded-md overflow-hidden border border-border bg-code-block;
}
.markdown-body :deep(.code-block-header) {
  @apply flex items-center justify-between px-3 py-1 border-b border-border/50
    text-xs text-muted-foreground;
}
.markdown-body :deep(.code-block-copy) {
  @apply cursor-pointer hover:text-foreground transition-colors;
}
.markdown-body :deep(.code-block-body) {
  @apply overflow-x-auto;
}
.markdown-body :deep(.code-block-wrapper pre) {
  @apply my-0 p-3 rounded-none border-0 bg-transparent;
}

/* inline code（不在 pre 里的 `code`） */
.markdown-body :deep(:not(pre) > code) {
  @apply font-mono text-[13px] bg-muted px-1 py-0.5 rounded;
}

/* ============ 引用 / 分隔线 / 链接 / 图片 / 删除线 ============ */
.markdown-body :deep(blockquote) {
  @apply border-l-2 border-border pl-3 italic text-muted-foreground my-2;
}
.markdown-body :deep(hr) {
  @apply border-border my-4;
}
.markdown-body :deep(a) {
  @apply text-primary underline underline-offset-2;
}
.markdown-body :deep(img) {
  @apply max-w-full rounded-md my-2;
}
.markdown-body :deep(del) {
  @apply text-muted-foreground line-through;
}
</style>
