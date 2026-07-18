import Shiki from '@shikijs/markdown-it'
import MarkdownIt from 'markdown-it'

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

    // Shiki 代码高亮
    md.use(
      await Shiki({
        themes: {
          dark: 'github-dark-dimmed',
          light: 'github-light',
        },
      }),
    )

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
