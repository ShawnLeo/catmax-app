import Shiki from '@shikijs/markdown-it'
import MarkdownIt from 'markdown-it'

import { taskListPlugin } from './markdown-task-lists'

let mdInstance: MarkdownIt | null = null
let initPromise: Promise<MarkdownIt> | null = null

/** 异步初始化 markdown-it + Shiki */
export async function getMarkdown(): Promise<MarkdownIt> {
  if (mdInstance) return mdInstance
  if (initPromise) return initPromise

  initPromise = (async () => {
    const md = new MarkdownIt({
      html: false,
      linkify: true,
      typographer: true,
      breaks: false,
    })

    // File Preview Contrast: 高对比暗色主题同时供聊天代码块和文件预览复用。
    md.use(
      await Shiki({
        themes: {
          dark: 'github-dark-high-contrast',
          light: 'github-light',
        },
      }),
    )

    // GFM 任务列表：`- [ ]` / `- [x]` → <li class="task-list-item"><input type="checkbox">
    // 用本地实现的 taskListPlugin（不引外部包——CJS default 在 electron-vite 下有歧义）
    md.use(taskListPlugin, { enabled: true })

    // 自定义 fence 渲染：在 <pre> 外面包一层 wrapper，加语言标签 + 复制按钮
    // 复制按钮的点击靠 MarkdownView.vue 里的事件委托处理（[data-action="copy-code"]）
    const defaultFence =
      md.renderer.rules.fence ??
      ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
    md.renderer.rules.fence = (tokens, idx, options, env, self) => {
      const token = tokens[idx]
      const lang = (token?.info ?? '').trim().split(/\s+/)[0] ?? ''
      const rendered = defaultFence(tokens, idx, options, env, self)
      const langLabel = lang || 'text'
      const escapedLang = md.utils.escapeHtml(langLabel)
      return `<div class="code-block-wrapper" data-language="${escapedLang}">
  <div class="code-block-header">
    <span class="code-block-lang">${escapedLang}</span>
    <button type="button" class="code-block-copy" data-action="copy-code" title="复制代码" aria-label="复制代码">复制</button>
  </div>
  <div class="code-block-body">${rendered}</div>
</div>`
    }

    mdInstance = md
    return md
  })()

  return initPromise
}

/**
 * 预热 markdown 管线——在 app 启动时调用，让 markdown-it + Shiki 的初始化
 *（动态 import + 语法/主题注册，约几百毫秒）在用户点开第一个会话前就完成。
 * 之后首次历史加载就能走同步渲染路径，避免空白→闪现的 1s 延迟。
 */
export function prewarmMarkdown(): void {
  void getMarkdown()
}

// ============ 渲染缓存 ============
//
// 历史加载时同一个文本块可能被多次渲染（组件卸载重挂、v-if 切换、多实例）。
// md.render 是纯函数（无 side effect、无外部依赖），结果可安全缓存。
// 用 Map 缓存 text → html，容量上限 256（LRU 语义用插入顺序近似，满了直接清空，
// 避免内存膨胀；历史会话文本量有限，清空后下次重新渲染也无感知）。
const MAX_CACHE_SIZE = 256
const renderCache = new Map<string, string>()

function cacheGet(text: string): string | undefined {
  const hit = renderCache.get(text)
  // LRU：命中则移到末尾（最近使用）
  if (hit !== undefined) {
    renderCache.delete(text)
    renderCache.set(text, hit)
  }
  return hit
}

function cacheSet(text: string, html: string): void {
  if (renderCache.size >= MAX_CACHE_SIZE) {
    // 淘汰最老（第一个）条目
    const oldest = renderCache.keys().next().value
    if (oldest !== undefined) renderCache.delete(oldest)
  }
  renderCache.set(text, html)
}

/** 渲染 markdown 为 HTML（首次调用会异步初始化） */
export async function renderMarkdown(text: string): Promise<string> {
  const cached = cacheGet(text)
  if (cached !== undefined) return cached
  const md = await getMarkdown()
  const html = md.render(text)
  cacheSet(text, html)
  return html
}

/**
 * 同步渲染 markdown——要求管线已初始化（getMarkdown 已 resolve）。
 * 未初始化时返回 undefined，调用方应回退到异步 renderMarkdown。
 *
 * 这是消除历史加载"空白→闪现"的关键：预热完成后，MarkdownView 可在 setup
 * 阶段同步拿到 HTML，组件挂载即有内容，不存在空白帧。
 */
export function renderMarkdownSync(text: string): string | undefined {
  if (!mdInstance) return undefined
  const cached = cacheGet(text)
  if (cached !== undefined) return cached
  const html = mdInstance.render(text)
  cacheSet(text, html)
  return html
}
