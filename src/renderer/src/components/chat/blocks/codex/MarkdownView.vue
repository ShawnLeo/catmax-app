<template>
  <!--
    Codex 专属 Markdown 渲染容器。

    - 仅服务于 Codex 后端（由 CodexTurn / PlanBlockView 调用）
    - 由 `@renderer/lib/markdown/codex` 的 codexMarkdown 引擎输出 HTML——
      独立的 markdown-it 实例、独立的插件链、独立的 LRU 缓存,与 base 互不影响
    - 当前实现与 base 等价（拆分第一阶段保证行为不变），后续 Codex 独有的
      排版/代码块样式/自定义语法都应在此处演化
    - 调用方典型用法：`<MarkdownView :text="block.text" compact />`
      （turn commentary 用 compact,final answer 不传）

    Base 实现见 `../base/MarkdownView.vue`（服务 Claude 及跨后端共用场景）。
  -->
  <div
    v-if="rendered === undefined"
    class="animate-pulse text-muted-foreground text-[length:var(--chat-text-u1)] select-none"
  >
    <!--
      同步渲染未命中（markdown 管线还在初始化）的极短占位。
      预热完成后几乎不会出现；出现也只是首启那一瞬，比空白好——告诉用户内容正在来。
    -->
    …
  </div>
  <div
    v-else
    ref="container"
    :class="['markdown-body', { 'markdown-body-compact': compact }]"
    @click="onClick"
    v-html="rendered"
  />
</template>

<script setup lang="ts">
import { looksLikeFileReference } from '@renderer/lib/file-reference'
import { renderCodexMarkdown, renderCodexMarkdownSync } from '@renderer/lib/markdown/codex'
import { useFilesStore } from '@renderer/stores/files'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { nextTick, ref, watch } from 'vue'

const props = withDefaults(defineProps<{ text: string; compact?: boolean }>(), {
  compact: false,
})
const container = ref<HTMLElement | null>(null)
const filesStore = useFilesStore()
const workspaceStore = useWorkspaceStore()

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
    return renderCodexMarkdownSync(text)
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
      void nextTick(decorateFileReferences)
      return
    }
    // 同步未命中（管线还在初始化）→ 异步渲染
    void renderCodexMarkdown(text)
      .then((html) => {
        rendered.value = html
        void nextTick(decorateFileReferences)
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
  if (btn) {
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
    return
  }

  // External Link: 网络链接（http(s)/mailto）不留在 App 内导航——
  // 主进程只拦了 target="_blank" 的弹窗（setWindowOpenHandler），
  // 同标签页的 <a href="https://..."> 会把整个窗口导航走，必须这里拦下，
  // 唤起系统默认浏览器。其余协议（# 锚点、本地相对路径等）交给默认行为。
  const externalAnchor = target.closest('a') as HTMLAnchorElement | null
  const href = externalAnchor?.getAttribute('href') ?? ''
  if (/^(https?:|mailto:)/i.test(href)) {
    e.preventDefault()
    e.stopPropagation()
    void window.api.system.openExternal({ url: href })
    return
  }

  const fileTarget = target.closest('[data-file-reference]') as HTMLElement | null
  const reference = fileTarget?.dataset.fileReference
  const workspaceId = workspaceStore.currentWorkspace?.id
  if (!reference || !workspaceId) return
  e.preventDefault()
  e.stopPropagation()
  void filesStore.openFileReference(workspaceId, reference)
}

// Chat File Reference: 将 inline code 和非外链锚点标记为可点击文件，但跳过代码块。
function decorateFileReferences(): void {
  if (!container.value) return
  for (const code of container.value.querySelectorAll('code')) {
    if (code.closest('pre')) continue
    const reference = code.textContent?.trim() ?? ''
    if (looksLikeFileReference(reference)) markFileReference(code as HTMLElement, reference)
  }
  for (const anchor of container.value.querySelectorAll('a')) {
    const href = anchor.getAttribute('href') ?? ''
    if (!href || /^(https?:|mailto:|#)/i.test(href)) continue
    markFileReference(anchor as HTMLElement, href)
  }
}

function markFileReference(element: HTMLElement, reference: string): void {
  element.dataset.fileReference = reference
  element.classList.add('file-reference')
  element.title = `在文件面板中预览 ${reference}`
}
</script>

<style scoped>
@reference "../../../../assets/styles/main.css";

/* ============ 整体排版基准 ============ */
.markdown-body {
  @apply text-[length:var(--chat-text-u2)] leading-relaxed;
  overflow-wrap: anywhere;
}

/* File Preview Typography: 预览面板采用接近编辑器的紧凑行距，不改变聊天正文排版。 */
.markdown-body-compact {
  line-height: 1.45;
}

.markdown-body-compact :deep(p),
.markdown-body-compact :deep(ul),
.markdown-body-compact :deep(ol),
.markdown-body-compact :deep(blockquote) {
  margin-top: 0.375rem;
  margin-bottom: 0.375rem;
}

.markdown-body-compact :deep(li) {
  margin-top: 0;
  margin-bottom: 0;
}

.markdown-body-compact :deep(.code-block-wrapper pre) {
  line-height: 1.5;
}

/* ============ 标题层级（h1-h6 字号梯度） ============ */
.markdown-body :deep(h1) {
  @apply text-[length:var(--chat-text-u11)] font-semibold;
}

.markdown-body :deep(h2) {
  @apply text-[length:var(--chat-text-u7)] font-semibold;
}

.markdown-body :deep(h3) {
  @apply text-[length:var(--chat-text-u5)] font-semibold;
}

.markdown-body :deep(h4) {
  @apply text-[length:var(--chat-text-u3)] font-semibold;
}

.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  @apply text-[length:var(--chat-text-u1)] font-semibold text-muted-foreground;
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
  @apply my-3 w-full border-collapse text-[length:var(--chat-text-u1)] overflow-hidden;
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
  @apply flex items-center justify-between px-3 py-1 border-b border-border/50 text-[length:var(--chat-text-d1)] text-muted-foreground;
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
  /* 围栏代码块归**代码字号**（settings.theme.codeFontSize），不跟对话正文走：
     它和 ToolCallCard 的 pre、文件预览、diff 是同一类等宽内容，同一档才协调。
     行内 code 反而留在对话刻度上——它嵌在句子里，跟着周围文字才不突兀。 */
  @apply my-0 p-3 rounded-none border-0 text-[length:var(--code-text-d1)];
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
  @apply font-mono text-[length:var(--chat-text-base)] bg-muted px-1 py-0.5 rounded;
}

/* File Reference: 中性灰底胶囊，等宽字体，视觉与 inline code 同源；
 * 点击在文件面板预览。不使用 primary 色调——保持路径像一段普通代码，
 * 只靠 hover 的轻微背景抬升暗示可点（参考附件设计稿）。 */
.markdown-body :deep(.file-reference) {
  @apply cursor-pointer font-mono no-underline transition-colors rounded;
  padding: 0.05rem 0.3rem;
  color: inherit;
  background-color: var(--color-muted);
}

.markdown-body :deep(.file-reference:hover) {
  background-color: color-mix(in oklch, var(--color-muted), var(--color-foreground) 8%);
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
</style>

<style>
[data-theme='dark'] .markdown-body .shiki,
[data-theme='dark'] .markdown-body .shiki span {
  color: var(--shiki-dark) !important;
  background-color: var(--shiki-dark-bg) !important;
}

/* 行内 span 不需要背景，只在 <pre> 上设 bg 即可——避免每行都带深灰块 */
[data-theme='dark'] .markdown-body .shiki span {
  background-color: transparent !important;
}

/* header 用 Shiki 暗色背景的略浅版本（叠一层白 8%） */
[data-theme='dark'] .markdown-body .code-block-header {
  background-color: color-mix(in oklch, var(--shiki-dark-bg) 92%, white 8%);
  color: oklch(0.78 0.005 250);
  border-bottom-color: oklch(1 0 0 / 0.08);
}

/* Chat File Reference Contrast: 新的中性 muted 底已对齐主题，
 * 仅在 hover 时给一点更亮的抬升（暗色下叠 8% 前景更明显）。 */
[data-theme='dark'] .markdown-body .file-reference:hover {
  background-color: color-mix(in oklch, var(--color-muted), var(--color-foreground) 12%);
}
</style>
