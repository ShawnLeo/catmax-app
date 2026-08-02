import { normalizeSlashCommands, type RawSlashCommand } from '@main/backend/claude/slash-commands'
import { describe, expect, it } from 'vitest'

function raw(name: string, description = '', argumentHint = ''): RawSlashCommand {
  return { name, description, argumentHint }
}

function names(input: RawSlashCommand[]): string[] {
  return normalizeSlashCommands(input).map((c) => c.name)
}

describe('normalizeSlashCommands — 来源解析', () => {
  /*
   * SDK 把内置命令和 Skill 混在同一个数组里返回，来源只能从描述尾部的
   * `(user)` / `(project)` 反推。这是本机实测的真实形状。
   */
  it('从描述尾部识别 user / project skill，并把标记摘掉', () => {
    const [user, project, builtin] = normalizeSlashCommands([
      raw('lark-doc', '飞书云文档：读取和编辑飞书文档内容。 (user)'),
      raw('catmax-conventions', '项目约定与代码风格 (project)'),
      raw('compact', 'Free up context by summarizing the conversation so far'),
    ])

    expect(user).toMatchObject({
      source: 'user',
      description: '飞书云文档：读取和编辑飞书文档内容。',
    })
    expect(project).toMatchObject({ source: 'project', description: '项目约定与代码风格' })
    expect(builtin!.source).toBe('builtin')
  })

  /*
   * description 是自由文本，`(user)` 后缀是约定不是契约。claude 改了描述格式时
   * 应该退化成「全部当内置命令」，而不是整张表报废。
   */
  it('认不出来源时归到 builtin，而不是丢弃', () => {
    const [cmd] = normalizeSlashCommands([raw('x', '说明里带 (括号) 但不是来源标记')])
    expect(cmd).toMatchObject({ source: 'builtin', description: '说明里带 (括号) 但不是来源标记' })
  })
})

describe('normalizeSlashCommands — 过滤', () => {
  /*
   * 这几条会改 catmax 也在管的状态：model/effort 每个 turn 都由 StartTurnArgs 传，
   * SDK 侧改完下一轮就被覆盖（用户看到「改了没生效」）；/clear 换 session_id，
   * backend_thread_id 映射当场断掉，会话再也发不出消息。
   */
  it('剔掉与 catmax 状态管理冲突的命令', () => {
    expect(names([raw('model'), raw('effort'), raw('fast'), raw('clear'), raw('config')])).toEqual(
      [],
    )
  })

  it('剔掉终端专属命令', () => {
    expect(names([raw('color'), raw('mcp'), raw('vim'), raw('login'), raw('doctor')])).toEqual([])
  })

  /** `__remote-workflow` 这类内部命令按前缀挡，新增同类的不必等着补名单。 */
  it('按 __ 前缀剔掉内部命令', () => {
    expect(names([raw('__remote-workflow'), raw('__future-internal')])).toEqual([])
  })

  /*
   * 跟「会出事」那组分开：/batch 会开 5–30 个 worktree agent 各开一个 PR，
   * 不是会坏，是代价大到不该手滑触发。
   */
  it('剔掉代价过大的命令', () => {
    expect(names([raw('batch'), raw('deep-research'), raw('loop')])).toEqual([])
  })

  it('放行常用命令', () => {
    const input = [
      raw('compact'),
      raw('init'),
      raw('context'),
      raw('usage'),
      raw('review'),
      raw('security-review'),
      raw('code-review'),
      raw('simplify'),
    ]
    expect(names(input)).toEqual(input.map((c) => c.name))
  })

  /*
   * denylist 而不是 allowlist：claude 新版本加的命令自动可用。这条钉住这个取舍——
   * 改成白名单会让这个测试失败。
   */
  it('未知的新命令默认放行', () => {
    expect(names([raw('some-future-command')])).toEqual(['some-future-command'])
  })

  it('丢弃没有名字的条目', () => {
    expect(names([raw(''), raw('   '), raw('ok')])).toEqual(['ok'])
  })
})

describe('normalizeSlashCommands — 描述归一化', () => {
  /** Skill 的 description 动辄 500+ 字符，弹层里只占一行。 */
  it('超长描述截断并加省略号', () => {
    const [cmd] = normalizeSlashCommands([raw('x', 'a'.repeat(300))])
    expect(cmd!.description.length).toBe(120)
    expect(cmd!.description.endsWith('…')).toBe(true)
  })

  /** Skill 的触发条件常常分行写，多行挤进一行会带一串空白。 */
  it('把换行和连续空白压成单个空格', () => {
    const [cmd] = normalizeSlashCommands([raw('x', '第一行\n\n  第二行   第三行  ')])
    expect(cmd!.description).toBe('第一行 第二行 第三行')
  })

  it('保留 argumentHint 和 aliases，空 aliases 不带出来', () => {
    const [withAlias, plain] = normalizeSlashCommands([
      { name: 'usage', description: '', argumentHint: '', aliases: ['cost', 'stats'] },
      { name: 'compact', description: '', argumentHint: '<custom instructions>', aliases: [] },
    ])
    expect(withAlias!.aliases).toEqual(['cost', 'stats'])
    expect(plain!.aliases).toBeUndefined()
    expect(plain!.argumentHint).toBe('<custom instructions>')
  })
})
