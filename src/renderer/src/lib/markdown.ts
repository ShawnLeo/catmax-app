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

    // Shiki 代码高亮（双主题，跟着 data-theme 切）
    md.use(
      await Shiki({
        themes: {
          dark: 'github-dark-dimmed',
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

/** 渲染 markdown 为 HTML（首次调用会异步初始化） */
export async function renderMarkdown(text: string): Promise<string> {
  const md = await getMarkdown()
  return md.render(text)
}
