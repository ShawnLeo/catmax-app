/**
 * Markdown 引擎工厂。
 *
 * 背景：早期项目里 markdown 是「全局单例」——`lib/markdown.ts` 用模块级 `mdInstance`
 * 缓存唯一的 markdown-it 实例,所有渲染都共用一份插件链、一份 Shiki 主题、一份 256 条
 * LRU 缓存。这把不同后端（Codex / Claude）的 markdown 演化强行耦合在一起:
 * 改一处 fence 渲染规则、加一个插件、换一组 Shiki 主题,所有后端都被迫一起改。
 *
 * 现在按后端拆分:每个后端调用 `createMarkdownInstance()` 拿到一份独立的引擎实例,
 * 各自有独立的 markdown-it、插件链、缓存、预热状态。两边可以独立演进而互不影响。
 *
 * 新增后端时如何扩展：
 * 1. 新建 `lib/markdown/<backend>.ts`
 * 2. 调用 `createMarkdownInstance(options?)` 创建实例（可传不同的 Shiki 主题、
 *    代码块复制按钮文案、fence wrapper class 等）
 * 3. 如需独立样式，配套新建 `blocks/<backend>/MarkdownView.vue`
 * 4. 在 `main.ts` 启动时调用该实例的 `prewarmMarkdown()` 预热
 *
 * `MarkdownInstanceOptions` 当前仅预留扩展点,默认值与拆分前完全等价（行为不变）。
 */
import Shiki from '@shikijs/markdown-it'
import MarkdownIt from 'markdown-it'

import { taskListPlugin } from './markdown-task-lists'

/** 引擎实例对外暴露的渲染 API。每个后端各持一份独立实例。 */
export interface MarkdownInstance {
  /** 异步初始化并返回 markdown-it 实例（首次调用触发初始化） */
  getMarkdown: () => Promise<MarkdownIt>
  /** 渲染 markdown 为 HTML（首次调用会异步初始化） */
  renderMarkdown: (text: string) => Promise<string>
  /** 同步渲染——要求管线已初始化,未就绪时返回 undefined（调用方应回退到异步） */
  renderMarkdownSync: (text: string) => string | undefined
  /** 预热管线——在 app 启动时后台触发,消除首次会话的"空白→闪现" */
  prewarmMarkdown: () => void
  /** 测试专用：清空渲染缓存 */
  clearCacheForTest: () => void
}

/** 创建引擎实例的可选配置（预留扩展点,初版可不填用默认值）。 */
export interface MarkdownInstanceOptions {
  /** Shiki 双主题;默认与拆分前一致（github-dark-high-contrast / github-light） */
  shikiThemes?: { dark: string; light: string }
  /** 代码块复制按钮文案,默认 "复制" */
  codeBlockCopyLabel?: string
  /** 已复制状态的按钮文案,默认 "已复制" */
  codeBlockCopiedLabel?: string
}

const DEFAULT_SHIKI_THEMES = {
  dark: 'github-dark-high-contrast',
  light: 'github-light',
}

const MAX_CACHE_SIZE = 256

/**
 * 创建一份独立的 markdown 引擎实例。
 *
 * 每次调用都会新建闭包内的 `mdInstance` / `initPromise` / `renderCache`,
 * 互不共享——这正是按后端拆分的核心。
 */
export function createMarkdownInstance(options: MarkdownInstanceOptions = {}): MarkdownInstance {
  const shikiThemes = options.shikiThemes ?? DEFAULT_SHIKI_THEMES
  const copyLabel = options.codeBlockCopyLabel ?? '复制'
  const copiedLabel = options.codeBlockCopiedLabel ?? '已复制'

  let mdInstance: MarkdownIt | null = null
  let initPromise: Promise<MarkdownIt> | null = null

  // 渲染缓存:每个实例独立一份 LRU（256 条）。详见下方注释。
  const renderCache = new Map<string, string>()

  /** 异步初始化 markdown-it + Shiki */
  async function getMarkdown(): Promise<MarkdownIt> {
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
          themes: shikiThemes,
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
    <button type="button" class="code-block-copy" data-action="copy-code" data-copied-label="${md.utils.escapeHtml(
      copiedLabel,
    )}" title="${md.utils.escapeHtml(copyLabel)}" aria-label="${md.utils.escapeHtml(
      copyLabel,
    )}">${md.utils.escapeHtml(copyLabel)}</button>
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
   * 之后首次历史加载就能走同步渲染路径，避免空白→闪现的延迟。
   */
  function prewarmMarkdown(): void {
    void getMarkdown()
  }

  // ============ 渲染缓存 ============
  //
  // 历史加载时同一个文本块可能被多次渲染（组件卸载重挂、v-if 切换、多实例）。
  // md.render 是纯函数（无 side effect、无外部依赖），结果可安全缓存。
  // 用 Map 缓存 text → html，容量上限 256（LRU 语义用插入顺序近似，满了直接清空，
  // 避免内存膨胀；历史会话文本量有限，清空后下次重新渲染也无感知）。
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

  function clearCacheForTest(): void {
    renderCache.clear()
  }

  async function renderMarkdown(text: string): Promise<string> {
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
  function renderMarkdownSync(text: string): string | undefined {
    if (!mdInstance) return undefined
    const cached = cacheGet(text)
    if (cached !== undefined) return cached
    const html = mdInstance.render(text)
    cacheSet(text, html)
    return html
  }

  return {
    getMarkdown,
    renderMarkdown,
    renderMarkdownSync,
    prewarmMarkdown,
    clearCacheForTest,
  }
}
