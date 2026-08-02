import { afterEach, describe, expect, it } from 'vitest'

import { registerSlashCommands, type SlashCommandSpec } from '../commands'
import { CLAUDE_FALLBACK_COMMANDS } from '../commands/claude'
import { CODEX_SLASH_COMMANDS } from '../commands/codex'
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

function spec(
  name: string,
  source: SlashCommandSpec['source'],
  extra: Partial<SlashCommandSpec> = {},
): SlashCommandSpec {
  return { name, description: `${name} 的说明`, source, ...extra }
}

afterEach(() => {
  // 每个用例可能替换过两个后端的表，恢复成兜底表免得互相污染。
  registerSlashCommands('claude', CLAUDE_FALLBACK_COMMANDS)
  registerSlashCommands('codex', CODEX_SLASH_COMMANDS)
})

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
   * 一条命令都没有的后端里 `/` 干脆不该是触发字符——否则该后端的用户每写一条以
   * `/` 开头的消息都会闪一下永远不可能有内容的空列表。第三方 backend plugin
   * 不注册命令表时走这条路。
   */
  it('后端没有任何斜杠命令时根本不触发', () => {
    registerSlashCommands('codex', [])
    expect(slashCommandProvider.detect('/comp', 5, codex)).toBeNull()
    expect(slashCommandProvider.detect('/', 1, codex)).toBeNull()
  })

  it('codex 有命令表时正常触发', () => {
    expect(slashCommandProvider.detect('/comp', 5, codex)).not.toBeNull()
  })

  it('后端未知时不触发', () => {
    expect(slashCommandProvider.detect('/comp', 5, { ...claude, backendId: undefined })).toBeNull()
  })
})

describe('slashCommandProvider.search — 匹配', () => {
  it('空 query 列出该后端的全部命令', async () => {
    expect(await names('')).toEqual(['compact', 'context', 'init'])
  })

  it('按命令名前缀匹配，大小写无关', async () => {
    expect(await names('co')).toEqual(['compact', 'context'])
    expect(await names('IN')).toEqual(['init'])
    expect(await names('zzz')).toEqual([])
  })

  it('按别名匹配', async () => {
    registerSlashCommands('claude', [spec('usage', 'builtin', { aliases: ['cost', 'stats'] })])
    expect(await names('cost')).toEqual(['usage'])
    expect(await names('stat')).toEqual(['usage'])
  })

  it('codex 有自己的一小张表，跟 claude 互不干扰', async () => {
    expect(await names('', codex)).toEqual(['compact'])
    registerSlashCommands('claude', [spec('other', 'builtin')])
    expect(await names('', codex)).toEqual(['compact'])
  })
})

describe('slashCommandProvider.search — 动作型命令', () => {
  /*
   * codex 的斜杠命令是动作（`/compact` → thread/compact/start），当文本发过去会被
   * 原样交给模型。带上 command 才能让 useAutocomplete 走派发而不是插入。
   */
  it('codex 的命令带 command，claude 的不带', async () => {
    const [codexCompact] = await slashCommandProvider.search(match('compact'), codex)
    expect(codexCompact!.command).toEqual({ id: 'compact' })

    const [claudeCompact] = await slashCommandProvider.search(match('compact'), claude)
    expect(claudeCompact!.command).toBeUndefined()
  })

  /*
   * insert 仍要填正常的命令文本：使用方没接 onCommand 时命令项退化成普通插入，
   * 用户至少还能自己回车（ChatView 的 codexCompactFallback 会兜住）。
   */
  it('动作型命令的 insert 仍是可发送的文本，不是空串', async () => {
    const [item] = await slashCommandProvider.search(match('compact'), codex)
    expect(item!.insert).toBe('/compact')
  })

  /*
   * 钉住「动作型命令拿不到参数」这个事实（SuggestionCommand 上有完整说明）：
   * 匹配是拿整个查询词做前缀匹配的，用户一开始打参数，候选当场消失。所以给
   * SuggestionCommand 加 args 字段是没用的——真要支持带参命令得先改这里。
   */
  it('开始打参数后候选就消失了——所以命令拿不到参数', async () => {
    registerSlashCommands('codex', [
      {
        name: 'review',
        description: '',
        source: 'builtin',
        argumentHint: '[范围]',
        commandId: 'review',
      },
    ])
    expect(await names('review', codex)).toEqual(['review'])
    expect(await names('review HEAD~1', codex)).toEqual([])
  })
})

describe('slashCommandProvider.search — 排序与分组', () => {
  /*
   * 用户 Skill 数量最多（本机实测 36 条，内置能放行的只有一部分），不压到后面的话
   * 敲 `/co` 先看到的是 `/cloudflare` 而不是 `/compact`。
   */
  it('内置 → 项目技能 → 用户技能，组内按名字', async () => {
    registerSlashCommands('claude', [
      spec('zebra-skill', 'user'),
      spec('alpha-skill', 'user'),
      spec('catmax-conventions', 'project'),
      spec('init', 'builtin'),
      spec('compact', 'builtin'),
    ])
    expect(await names('')).toEqual([
      'compact',
      'init',
      'catmax-conventions',
      'alpha-skill',
      'zebra-skill',
    ])
  })

  it('每条带中文分组标题，同组相邻', async () => {
    registerSlashCommands('claude', [
      spec('compact', 'builtin'),
      spec('catmax-conventions', 'project'),
      spec('lark-doc', 'user'),
    ])
    const items = await slashCommandProvider.search(match(''), claude)
    expect(items.map((i) => i.group)).toEqual(['内置命令', '项目技能', '用户技能'])
  })
})

describe('slashCommandProvider.search — 插入形态', () => {
  /*
   * 带参数的命令插入后补空格（用户接着打参数），不带参数的不补——那条消息已经
   * 完整，直接回车就该发出去。不补空格会让光标停在触发段里，靠
   * useAutocomplete.applyAt 的「刚插完不许再弹」兜住。
   */
  it('带参数的命令补尾随空格，不带参数的不补', async () => {
    const [compact, context, init] = await slashCommandProvider.search(match(''), claude)
    expect(compact!.insert).toBe('/compact ')
    expect(context!.insert).toBe('/context')
    expect(init!.insert).toBe('/init')
  })

  it('参数提示跟在命令名后面展示，说明放 detail', async () => {
    const [compact, , init] = await slashCommandProvider.search(match(''), claude)
    expect(compact!.label).toBe('/compact [保留重点]')
    expect(compact!.detail).toBe('压缩当前对话为摘要，腾出上下文')
    expect(init!.label).toBe('/init')
  })

  it('插入的就是发给后端的原文——claude CLI 自己拦截这行文本', async () => {
    const [compact] = await slashCommandProvider.search(match('compact'), claude)
    expect(compact!.insert.trim()).toBe('/compact')
  })

  /** 动态列表有几十条，逐条配图标不现实——按来源给默认图标即可。 */
  it('没指定图标时按来源补默认图标', async () => {
    registerSlashCommands('claude', [spec('lark-doc', 'user'), spec('conv', 'project')])
    const [user, project] = await slashCommandProvider.search(match(''), claude)
    expect(user!.icon).toBeDefined()
    expect(project!.icon).toBeDefined()
    expect(user!.icon).not.toEqual(project!.icon)
  })
})
