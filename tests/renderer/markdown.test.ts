/**
 * markdown.ts 渲染回归测试。
 *
 * 之前 bug：default import CJS 包 markdown-it-task-lists 在 electron-vite 下解析失败，
 * 导致整个 markdown 实例初始化抛错，错误被 MarkdownView 的 try/catch 吞掉，
 * 所有 markdown（表格、代码块、列表）都退化为纯文本。
 * 这里直接跑 renderMarkdown，验证表格/代码块/任务列表都能正常输出 HTML。
 */
import { describe, expect, test } from 'vitest'

import { renderMarkdown } from '../../src/renderer/src/lib/markdown'

describe('renderMarkdown', () => {
  test('表格正常渲染为 <table>', async () => {
    const md = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    const html = await renderMarkdown(md)
    expect(html).toContain('<table>')
    expect(html).toContain('<th>')
    expect(html).toContain('<td>')
  })

  test('代码块走自定义 fence renderer，有 wrapper + 复制按钮 + 语言标签', async () => {
    const md = '```ts\nconst x = 1\n```'
    const html = await renderMarkdown(md)
    expect(html).toContain('code-block-wrapper')
    expect(html).toContain('data-language="ts"')
    expect(html).toContain('code-block-lang')
    expect(html).toContain('data-action="copy-code')
    expect(html).toContain('复制')
  })

  test('无语言代码块标签显示为 text', async () => {
    const md = '```\nplain\n```'
    const html = await renderMarkdown(md)
    expect(html).toContain('data-language="text"')
  })

  test('GFM 任务列表 - [ ] / - [x] 渲染为 checkbox', async () => {
    const md = '- [ ] todo\n- [x] done'
    const html = await renderMarkdown(md)
    expect(html).toContain('task-list-item')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('checked=""')
  })

  test('标题层级正常渲染', async () => {
    const html = await renderMarkdown('# H1\n## H2\n### H3')
    expect(html).toMatch(/<h1[^>]*>H1<\/h1>/)
    expect(html).toMatch(/<h2[^>]*>H2<\/h2>/)
    expect(html).toMatch(/<h3[^>]*>H3<\/h3>/)
  })

  test('inline code 渲染', async () => {
    const html = await renderMarkdown('this is `inline code`')
    expect(html).toContain('<code>inline code</code>')
  })

  test('引用块渲染', async () => {
    const html = await renderMarkdown('> quoted')
    expect(html).toContain('<blockquote>')
  })

  test('普通段落渲染（不应整体抛错退化成纯文本）', async () => {
    const html = await renderMarkdown('hello world')
    expect(html).toContain('<p>')
    expect(html).toContain('hello world')
  })
})
