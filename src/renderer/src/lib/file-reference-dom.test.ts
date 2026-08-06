import { describe, expect, test } from 'vitest'

import { decorateFileReferences, findFileReferences } from './file-reference-dom'

// File Reference DOM Decoration: 正文纯文本扫描要在自由文本里"猜"文件名，
// 误标的代价是用户点了以后打开一个不存在的文件——所以宁可漏判，不可错标。
describe('findFileReferences - 正文里应识别出的文件引用', () => {
  test('中文语境（无空格分词）', () => {
    expect(findFileReferences('根目录的CLAUDE.md写了规范')).toEqual([
      { start: 4, end: 13, reference: 'CLAUDE.md' },
    ])
  })

  test('中文标点作为边界', () => {
    const hits = findFileReferences('先改 create-markdown.ts，再看 MarkdownView.vue。')
    expect(hits.map((h) => h.reference)).toEqual(['create-markdown.ts', 'MarkdownView.vue'])
  })

  test('英文句尾的句号被剥离', () => {
    const hits = findFileReferences('see README.md.')
    expect(hits.map((h) => h.reference)).toEqual(['README.md'])
  })

  test('带目录的相对路径', () => {
    const hits = findFileReferences('入口在 src/main/index.ts 这里')
    expect(hits.map((h) => h.reference)).toEqual(['src/main/index.ts'])
  })

  test('保留行号后缀（文件面板靠它定位行）', () => {
    expect(findFileReferences('见 foo.ts:42 这一行').map((h) => h.reference)).toEqual(['foo.ts:42'])
    expect(findFileReferences('见 foo.ts:42:').map((h) => h.reference)).toEqual(['foo.ts:42'])
  })

  test('一句话里的多个文件按出现顺序返回', () => {
    const hits = findFileReferences('package.json 和 pnpm-lock.yaml 都要改')
    expect(hits.map((h) => h.reference)).toEqual(['package.json', 'pnpm-lock.yaml'])
    expect(hits[0]!.start).toBe(0)
    expect(hits[1]!.start).toBeGreaterThan(hits[0]!.end)
  })

  test('偏移量能精确切回原文', () => {
    const text = '改 CLAUDE.md 就行'
    const hit = findFileReferences(text)[0]!
    expect(text.slice(hit.start, hit.end)).toBe('CLAUDE.md')
  })
})

describe('findFileReferences - 不应误标的正文', () => {
  test('普通中英文句子', () => {
    expect(findFileReferences('这是一段普通的说明文字')).toEqual([])
    expect(findFileReferences('let me explain how it works')).toEqual([])
  })

  test('技术名不是文件（Node.js / Next.js）', () => {
    expect(findFileReferences('用 Node.js 跑')).toEqual([])
    expect(findFileReferences('基于 Next.js 构建')).toEqual([])
    // 带目录时仍然是真路径
    expect(findFileReferences('见 src/node.js').map((h) => h.reference)).toEqual(['src/node.js'])
  })

  test('域名 / URL 不是文件', () => {
    expect(findFileReferences('打开 example.com 看看')).toEqual([])
    expect(findFileReferences('访问 https://www.catmax.cn 即可')).toEqual([])
    expect(findFileReferences('设 ANTHROPIC_BASE_URL=https://www.catmax.cn')).toEqual([])
  })

  test('英文缩写与版本号', () => {
    expect(findFileReferences('e.g. 这样写')).toEqual([])
    expect(findFileReferences('升级到 v1.2.3 版本')).toEqual([])
    expect(findFileReferences('大约 1.5MB 左右')).toEqual([])
  })

  test('属性访问', () => {
    expect(findFileReferences('读 config.value.type 字段')).toEqual([])
    expect(findFileReferences('取 workspaceStore.currentWorkspace 的值')).toEqual([])
  })
})

describe('findFileReferences - 与 inline code 整串判定的刻意差异', () => {
  // 正文扫描是分词的：括号是候选边界，所以括号里的文件名会被单独识别出来
  // （它确实指向一个文件）。而 inline code 走 looksLikeFileReference 的整串判定，
  // `foo(bar.ts)` 整体不像路径 → 不标。两条路径语境不同，差异是刻意的。
  test('括号内的文件名在正文里会被识别', () => {
    expect(findFileReferences('调用 foo(bar.ts) 时').map((h) => h.reference)).toEqual(['bar.ts'])
  })
})

describe('decorateFileReferences - DOM 装饰', () => {
  function render(html: string): HTMLElement {
    const el = document.createElement('div')
    el.innerHTML = html
    decorateFileReferences(el)
    return el
  }

  test('正文纯文本被包成可点击 span，原文完整保留', () => {
    const el = render('<p>根目录的 CLAUDE.md 写了规范</p>')
    const span = el.querySelector('[data-file-reference]') as HTMLElement
    expect(span.tagName).toBe('SPAN')
    expect(span.dataset.fileReference).toBe('CLAUDE.md')
    expect(span.classList.contains('file-reference-text')).toBe(true)
    expect(el.textContent).toBe('根目录的 CLAUDE.md 写了规范')
  })

  test('inline code 仍走胶囊样式（不带正文变体 class）', () => {
    const el = render('<p>看 <code>src/foo.ts</code></p>')
    const marked = el.querySelector('[data-file-reference]') as HTMLElement
    expect(marked.tagName).toBe('CODE')
    expect(marked.classList.contains('file-reference-text')).toBe(false)
  })

  test('非外链锚点用 href 作为引用', () => {
    const el = render('<p><a href="CLAUDE.md">规范</a></p>')
    expect((el.querySelector('a') as HTMLElement).dataset.fileReference).toBe('CLAUDE.md')
  })

  test('代码块内不装饰', () => {
    const el = render('<pre><code>import foo from "./foo.ts"</code></pre>')
    expect(el.querySelector('[data-file-reference]')).toBeNull()
  })

  test('外链锚点内的文本不装饰', () => {
    const el = render('<p><a href="https://example.com">见 README.md</a></p>')
    expect(el.querySelector('[data-file-reference]')).toBeNull()
  })

  test('重复装饰同一份 DOM 不会嵌套包裹', () => {
    const el = render('<p>改 CLAUDE.md 即可</p>')
    decorateFileReferences(el)
    decorateFileReferences(el)
    expect(el.querySelectorAll('[data-file-reference]')).toHaveLength(1)
    expect(el.textContent).toBe('改 CLAUDE.md 即可')
  })
})
