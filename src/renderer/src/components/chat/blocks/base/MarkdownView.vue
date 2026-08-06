<template>
  <!--
    Base Markdown 渲染容器（默认/兜底实现）。

    - 服务于 Claude 后端，以及所有跨后端共用场景（FilePreview / ThinkingBlock /
      ToolCallCard / WebCard / ExitPlanModeCard）
    - 由 `@renderer/lib/markdown/base` 的 baseMarkdown 引擎输出 HTML（markdown-it + Shiki
      双主题 + 自实现 task-list 插件），通过 v-html 注入
    - 代码块的"复制"按钮靠事件委托：baseMarkdown 给每个 fence 包了 [data-action="copy-code"]，
      这里在容器上监听 click，向上找最近的 .code-block-wrapper，取其 pre code 文本写剪贴板
    - 任务列表的 checkbox 可点（本地状态，刷新会丢——临时检查清单语义）

    Codex 后端的专属实现见 `../codex/MarkdownView.vue`（初始等价，可独立演化）。
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
import { decorateFileReferences as decorateFileReferencesIn } from '@renderer/lib/file-reference-dom'
import { renderMarkdown, renderMarkdownSync } from '@renderer/lib/markdown'
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
      void nextTick(decorateFileReferences)
      return
    }
    // 同步未命中（管线还在初始化）→ 异步渲染
    void renderMarkdown(text)
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

// Chat File Reference: inline code / 非外链锚点 / 正文纯文本三类来源统一走
// lib/file-reference-dom（规则必须与 codex 版 MarkdownView 一致，故不在组件里各写一份）。
function decorateFileReferences(): void {
  if (!container.value) return
  decorateFileReferencesIn(container.value)
}
</script>

<style scoped>
@reference "../../../../assets/styles/main.css";

/* ============ 整体排版基准 ============ */
/* 聊天正文采用紧凑排版（接近编辑器/终端密度），不是文档那种松散呼吸空间。 */
.markdown-body {
  @apply text-[length:var(--chat-text-u1)] leading-snug;
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

/* ============ 标题层级（h1-h6 字号梯度） ============
 * 标题上方 margin 压到 8-12px——聊天回复里标题作为分节符,
 * 不需要文档那么大的呼吸空间,否则模块之间看着像断开了 */
.markdown-body :deep(h1) {
  @apply text-[length:var(--chat-text-u7)] font-semibold;
}

.markdown-body :deep(h2) {
  @apply text-[length:var(--chat-text-u5)] font-semibold;
}

.markdown-body :deep(h3) {
  @apply text-[length:var(--chat-text-u3)] font-semibold;
}

.markdown-body :deep(h4) {
  @apply text-[length:var(--chat-text-u2)] font-semibold;
}

.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  @apply text-[length:var(--chat-text-u1)] font-semibold text-muted-foreground;
}

/* ============ 段落 / 首尾间距归零 ============ */
/* 段落间距 8px——聊天多段文字紧凑成流，又留出可分辨的呼吸（与 codex 版一致）。 */
.markdown-body :deep(p) {
  @apply my-2;
}

.markdown-body :deep(:first-child) {
  @apply mt-0;
}

.markdown-body :deep(:last-child) {
  @apply mb-0;
}

/* ============ 列表 ============
 * MarkdownView 外层没有 white-space: pre-wrap，因此 markdown-it 输出的标签间换行会
 * 按普通 HTML 空白折叠，不会生成额外行框。让列表保持正常行高，兼容 tight list 的
 * 纯文本 li 与 loose list 的 li > p，避免用负 margin 补偿时把首项抬到前一段上。 */
.markdown-body :deep(ul) {
  @apply my-1 list-disc pl-6;
}

.markdown-body :deep(ol) {
  @apply my-1 list-decimal pl-6;
}

.markdown-body :deep(li) {
  @apply my-px leading-[1.4];
}

/* loose list 的段落由 li 间距统一控制，避免全局 p 的纵向 margin 放大列表间距。 */
.markdown-body :deep(li > p) {
  margin-top: 0 !important;
  margin-bottom: 0 !important;
}

/* li 内嵌套的子列表留一点间距 */
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
  @apply my-2 w-full border-collapse text-[length:var(--chat-text-u1)] overflow-hidden;
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

/* inline code（不在 pre 里的 `code`）
 * padding 压到 1px——inline code 常出现在列表/段落行内,上下 padding 大了
 * 会撑高整行 line-height,让密集含 code 的列表显得松散。 */
.markdown-body :deep(:not(pre) > code) {
  @apply font-mono text-[length:var(--chat-text-base)] bg-muted px-1 py-px rounded;
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

/* Chat File Reference（正文变体）：正文里的文件名不做成 inline code 那样的灰底胶囊——
 * 一段回复里常出现三五个文件名，全胶囊化整段就花了；中英混排下切等宽字体还会让行内
 * 字宽跳动。这里只留一条虚下划线暗示可点，hover 才浮出底色。
 * 明确写的 `code` 引用仍走上面的胶囊样式，两种写法保持可区分。 */
.markdown-body :deep(.file-reference-text) {
  padding: 0;
  font-family: inherit;
  background-color: transparent;
  text-decoration: underline dotted;
  text-underline-offset: 0.2em;
  text-decoration-color: color-mix(in oklch, currentColor, transparent 55%);
}

.markdown-body :deep(.file-reference-text:hover) {
  background-color: var(--color-muted);
  text-decoration-color: currentColor;
}

/* ============ 引用 / 分隔线 / 链接 / 图片 / 删除线 ============ */
.markdown-body :deep(blockquote) {
  @apply border-l-2 border-border pl-3 italic text-muted-foreground my-1.5;
}

.markdown-body :deep(hr) {
  @apply border-border my-3;
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
