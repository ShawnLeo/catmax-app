import { describe, expect, it } from 'vitest'

import type { SuggestionContext, TriggerMatch } from '../types'

import { slashCommandProvider } from './slash-command'

const claude: SuggestionContext = { workspaceId: 'ws-1', backendId: 'claude' }
const codex: SuggestionContext = { workspaceId: 'ws-1', backendId: 'codex' }

function match(query: string): TriggerMatch {
  return { char: '/', start: 0, end: query.length + 1, query }
}

/** 命令名（= item.id），过滤逻辑的断言用它，免得被 label 里的参数提示干扰。 */
async function names(query: string, ctx = claude): Promise<string[]> {
  const items = await slashCommandProvider.search(match(query), ctx)
  return items.map((i) => i.id)
}

describe('slashCommandProvider.detect', () => {
  it('只在整段文本最开头触发——句中的斜杠不是命令', () => {
    expect(slashCommandProvider.detect('/comp', 5, claude)).not.toBeNull()
    expect(slashCommandProvider.detect('用 and/or 连接', 8, claude)).toBeNull()
    expect(slashCommandProvider.detect(' /compact', 9, claude)).toBeNull()
  })

  it('多段路径不会误触发——第二个斜杠不在开头', () => {
    expect(slashCommandProvider.detect('/Users/shawn', 12, claude)).toBeNull()
  })

  /*
   * codex 的 app-server 没有斜杠命令这一层（详见 commands/codex.ts），一条命令
   * 都没有的后端里 `/` 干脆不该是触发字符——否则 codex 用户每写一条以 `/` 开头
   * 的消息都会闪一下永远不可能有内容的空列表。
   */
  it('后端没有任何斜杠命令时（codex）根本不触发', () => {
    expect(slashCommandProvider.detect('/comp', 5, codex)).toBeNull()
    expect(slashCommandProvider.detect('/', 1, codex)).toBeNull()
  })

  it('后端未知时不触发', () => {
    expect(slashCommandProvider.detect('/comp', 5, { ...claude, backendId: undefined })).toBeNull()
  })
})

describe('slashCommandProvider.search', () => {
  it('空 query 列出该后端的全部命令', async () => {
    expect(await names('')).toEqual(['compact', 'init', 'context'])
  })

  it('按命令名前缀匹配，大小写无关', async () => {
    expect(await names('co')).toEqual(['compact', 'context'])
    expect(await names('IN')).toEqual(['init'])
    expect(await names('zzz')).toEqual([])
  })

  it('codex 会话下没有任何命令', async () => {
    expect(await names('', codex)).toEqual([])
  })

  it('参数提示跟在命令名后面展示，说明放 detail', async () => {
    const [compact, init] = await slashCommandProvider.search(match(''), claude)
    expect(compact!.label).toBe('/compact [保留重点]')
    expect(compact!.detail).toBe('压缩当前对话为摘要，腾出上下文')
    expect(init!.label).toBe('/init')
  })

  /*
   * 带参数的命令插入后补空格（用户接着打参数），不带参数的不补——那条消息已经
   * 完整，直接回车就该发出去。不补空格会让光标停在触发段里，靠
   * useAutocomplete.applyAt 的「刚插完不许再弹」兜住。
   */
  it('带参数的命令补尾随空格，不带参数的不补', async () => {
    const [compact, init, context] = await slashCommandProvider.search(match(''), claude)
    expect(compact!.insert).toBe('/compact ')
    expect(init!.insert).toBe('/init')
    expect(context!.insert).toBe('/context')
  })

  it('插入的就是发给后端的原文——claude CLI 自己拦截这行文本', async () => {
    const [compact] = await slashCommandProvider.search(match('compact'), claude)
    expect(compact!.insert.trim()).toBe('/compact')
  })
})
