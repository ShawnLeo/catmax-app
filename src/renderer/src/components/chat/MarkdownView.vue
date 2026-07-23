<template>
  <!--
    Markdown 渲染容器。

    - 由 markdown.ts 输出 HTML 通过 v-html 注入（GFM、代码块高亮、任务列表已在 render 阶段处理）
    - 代码块的"复制"按钮靠事件委托：markdown.ts 给每个 fence 包了 [data-action="copy-code"]，
      这里在容器上监听 click，向上找最近的 .code-block-wrapper，取其 pre code 文本写剪贴板
    - 任务列表的 checkbox 可点（本地状态，刷新会丢——临时检查清单语义）
  -->
  <div
    v-if="rendered === undefined"
    class="animate-pulse text-muted-foreground text-sm select-none"
  >
    <!--
      同步渲染未命中（markdown 管线还在初始化）的极短占位。
      预热完成后几乎不会出现；出现也只是首启那一瞬，比空白好——告诉用户内容正在来。
    -->
    …
  </div>
  <div v-else ref="container" class="markdown-body" @click="onClick" v-html="rendered" />
</template>

<script setup lang="ts">
import { renderMarkdown, renderMarkdownSync } from '@renderer/lib/markdown'
import { ref, watch } from 'vue'

const props = defineProps<{ text: string }>()
const container = ref<HTMLElement | null>(null)

/**
 * 渲染策略：优先同步（消除历史加载的"空白→闪现"），管线未就绪时回退异步。
 *
 * 历史加载性能关键路径：app 启动时 prewarmMarkdown() 已让 getMarkdown() 在后台
 * 完成（markdown-it + Shiki 初始化约几百毫秒）。到用户点开会话时管线多半已就绪，
 * renderMarkdownSync 能在 setup 阶段同步返回 HTML——组件挂载即有内容，
 * 不再有"先空白再闪出"的 1s 延迟。
 *
 * 同步路径未命中（冷启动极快、或用户瞬间点开会话）→ watch 回退到异步 renderMarkdown，
 * 此时 initPromise 已在跑，多个 MarkdownView 共享同一个 promise，一起 resolve。
 */
const rendered = ref<string | undefined>(tryRenderSync(props.text))

function tryRenderSync(text: string): string | undefined {
  // 同步路径：管线就绪 → 立即返回 HTML；未就绪 → 返回 undefined，让 watch 走异步
  try {
    return renderMarkdownSync(text)
  } catch {
    return undefined
  }
}

watch(
  () => props.text,
  (text) => {
    // 每次文本变化先试同步（预热完成后绝大多数命中）
    const sync = tryRenderSync(text)
    if (sync !== undefined) {
      rendered.value = sync
      return
    }
    // 同步未命中（管线还在初始化）→ 异步渲染
    void renderMarkdown(text)
      .then((html) => {
        rendered.value = html
      })
      .catch(() => {
        // fallback：直接显示转义后的纯文本
        rendered.value = `<p>${text.replace(/</g, '&lt;')}</p>`
      })
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

/* ============ 代码块 wrapper（markdown.ts 注入的 header + body） ============
 * Shiki 输出 <pre class="shiki"> 自带 inline style 背景，wrapper 背景给透明，
 * 让 Shiki 自己的背景（亮色 #fff / 暗色 --shiki-dark-bg）覆盖整个块，
 * header / body / pre 三者视觉融合，避免色差分层。
 */
.markdown-body :deep(.code-block-wrapper) {
  @apply my-3 rounded-md overflow-hidden border border-border;
  background-color: transparent;
}
.markdown-body :deep(.code-block-header) {
  @apply flex items-center justify-between px-3 py-1 border-b border-border/50
    text-xs text-muted-foreground;
  background-color: var(--code-block-background);
}
.markdown-body :deep(.code-block-copy) {
  @apply cursor-pointer hover:text-foreground transition-colors;
}
/* pre 自己负责横向滚动——长代码行在 pre 内部滚，不撑爆 wrapper。
 * macOS Chromium 默认 overlay scrollbar（不悬停不可见），用户看不到能滚；
 * 这里用 ::-webkit-scrollbar 强制常驻细滚动条，跟 VS Code 行为一致。
 */
.markdown-body :deep(.code-block-wrapper pre) {
  /* 字号对齐工具卡片（ToolCallCard 的 pre 也是 text-[12px]）——
     默认继承外层正文 15px 会让代码块看着比工具框代码大很多，不协调。 */
  @apply my-0 p-3 rounded-none border-0 text-[12px];
  overflow-x: auto;
}
.markdown-body :deep(.code-block-wrapper pre code) {
  display: block;
  /* 用 white-space: pre 而不是 min-width: max-content——后者会让 code 整块
   * 撑开到最长行宽度，scrollbar 一开始就出现在最右；pre 才对。
   * code 必须 block，否则 inline 会被 pre 宽度夹住导致换行。 */
  white-space: pre;
}
/* 代码块专属的细滚动条（覆盖全局 ::-webkit-scrollbar，让它常驻可见） */
.markdown-body :deep(.code-block-wrapper pre::-webkit-scrollbar) {
  height: 8px;
  width: 8px;
}
.markdown-body :deep(.code-block-wrapper pre::-webkit-scrollbar-thumb) {
  background-color: oklch(50% 0 0 / 0.35);
  border-radius: 4px;
}
.markdown-body :deep(.code-block-wrapper pre::-webkit-scrollbar-thumb:hover) {
  background-color: oklch(50% 0 0 / 0.55);
}
.markdown-body :deep(.code-block-wrapper pre::-webkit-scrollbar-track) {
  background: transparent;
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

/* ============ Shiki dual-theme：暗色模式激活 --shiki-dark* ============
 * Shiki 1.29 dual-theme 输出单 <pre>：
 *   - 亮色值走 inline style（background-color:#fff; color:#xxx）
 *   - 暗色值藏在 CSS 变量里（--shiki-dark-bg / --shiki-dark）
 * 必须靠 CSS 在暗色模式下把变量"激活"成真实 color/background-color。
 * 用 !important 是因为 inline style 优先级最高（Shiki 官方文档的写法）。
 * 切换由 <html data-theme="dark|light"> 触发，无需 JS 监听。
 *
 * 同时让 header / wrapper 边框 / 文字色协调到 shiki dark 系——
 * 整个代码块（header + pre）统一深灰，不出现亮色"盖头"。
 */
[data-theme='dark'] .markdown-body :deep(.shiki),
[data-theme='dark'] .markdown-body :deep(.shiki span) {
  color: var(--shiki-dark) !important;
  background-color: var(--shiki-dark-bg) !important;
}
/* 行内 span 不需要背景，只在 <pre> 上设 bg 即可——避免每行都带深灰块 */
[data-theme='dark'] .markdown-body :deep(.shiki span) {
  background-color: transparent !important;
}
/* header 用 Shiki 暗色背景的略浅版本（叠一层白 5%） */
[data-theme='dark'] .markdown-body :deep(.code-block-header) {
  background-color: color-mix(in oklch, var(--shiki-dark-bg) 92%, white 8%);
  color: oklch(0.7 0.005 250);
  border-bottom-color: oklch(1 0 0 / 0.08);
}
</style>
