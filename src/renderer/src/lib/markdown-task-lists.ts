/**
 * 自实现的 markdown-it task list 插件（GFM `- [ ]` / `- [x]`）。
 *
 * 为什么不用 markdown-it-task-lists：
 * 该包是纯 CJS（`module.exports = function`），在 electron-vite 的 ESM 环境下
 * default import 解析存在歧义——某些 bundler 配置下会拿到 `{ default: fn }` 包装对象，
 * 导致 md.use(plugin) 抛 "plugin is not a function"，
 * 错误被上游 MarkdownView 的 try/catch 吞掉，整个 markdown 渲染退化为纯文本。
 *
 * 这里直接内联相同逻辑（~60 行），消除 import 形状歧义，零外部依赖。
 *
 * 渲染输出：
 * - <ul class="contains-task-list">
 * - <li class="task-list-item">
 * - 段首 inline token 前 unshift 一个 <input type="checkbox">
 * - enabled=true 时 checkbox 不带 disabled，可点击（本地状态，刷新会丢）
 */
import type MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

interface Options {
  /** true 时 checkbox 不带 disabled 属性（可点） */
  enabled?: boolean
}

export function taskListPlugin(md: MarkdownIt, options?: Options): void {
  const disableCheckboxes = !options?.enabled

  md.core.ruler.after('inline', 'github-task-lists', (state) => {
    const tokens = state.tokens
    for (let i = 2; i < tokens.length; i++) {
      if (isTodoItem(tokens, i)) {
        todoify(tokens[i]!, state.Token)
        attrSet(tokens[i - 2]!, 'class', 'task-list-item')
        const parentIdx = parentToken(tokens, i - 2)
        if (parentIdx >= 0) attrSet(tokens[parentIdx]!, 'class', 'contains-task-list')
      }
    }
  })

  function attrSet(token: Token, name: string, value: string): void {
    const index = token.attrIndex(name)
    const attr: [string, string] = [name, value]
    if (index < 0) {
      token.attrPush(attr)
    } else {
      token.attrs![index] = attr
    }
  }

  function parentToken(tokens: Token[], index: number): number {
    const targetLevel = tokens[index]!.level - 1
    for (let i = index - 1; i >= 0; i--) {
      if (tokens[i]!.level === targetLevel) return i
    }
    return -1
  }

  function isTodoItem(tokens: Token[], index: number): boolean {
    return (
      tokens[index]!.type === 'inline' &&
      tokens[index - 1]?.type === 'paragraph_open' &&
      tokens[index - 2]?.type === 'list_item_open' &&
      startsWithTodoMarkdown(tokens[index]!)
    )
  }

  function startsWithTodoMarkdown(token: Token): boolean {
    return (
      token.content.startsWith('[ ] ') ||
      token.content.startsWith('[x] ') ||
      token.content.startsWith('[X] ')
    )
  }

  function todoify(token: Token, TokenCtor: typeof Token): void {
    token.children!.unshift(makeCheckbox(token, TokenCtor))
    // 移除 "[ ] " / "[x] " 前缀（4 字符）——第二个 child 是 text token 持有这 4 字符
    // 注意：unshift 后第一个是刚插入的 checkbox，第二个才是原 text token
    const secondChild = token.children![1]
    if (secondChild) secondChild.content = secondChild.content.slice(3)
    token.content = token.content.slice(3)
  }

  function makeCheckbox(token: Token, TokenCtor: typeof Token): Token {
    const checkbox = new TokenCtor('html_inline', '', 0)
    const disabledAttr = disableCheckboxes ? ' disabled=""' : ''
    if (token.content.startsWith('[ ] ')) {
      checkbox.content = `<input class="task-list-item-checkbox"${disabledAttr} type="checkbox">`
    } else {
      // [x] 或 [X]
      checkbox.content = `<input class="task-list-item-checkbox" checked=""${disabledAttr} type="checkbox">`
    }
    return checkbox
  }
}
