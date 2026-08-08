import type { ClaudeToolGroupContentBlock, ContentBlock } from '@shared/backend/blocks'
import type { NormalizedMessage } from '@shared/backend/types'
import { describe, expect, test } from 'vitest'

// tests/ 归 tsconfig.node.json 管，那里没有 @renderer alias（跨层导入规则）——
// 与同目录的 markdown.test.ts 一样走相对路径。
import { foldClaudeToolGroups } from '../../src/renderer/src/components/chat/blocks/claude/fold-tool-groups'

function assistant(id: string, turnId: string, blocks: ContentBlock[]): NormalizedMessage {
  return { id, role: 'assistant', turnId, blocks, createdAt: 0 }
}

function user(id: string, turnId: string, text: string): NormalizedMessage {
  return {
    id,
    role: 'user',
    turnId,
    blocks: [{ id: `${id}-t`, type: 'text', text }],
    createdAt: 0,
  }
}

function tool(id: string, status: 'running' | 'completed' | 'failed' = 'completed'): ContentBlock {
  return {
    id,
    type: 'tool_call',
    info: { kind: 'shell_command', title: `Bash: ${id}` },
    status,
  }
}

function groups(messages: NormalizedMessage[]): ClaudeToolGroupContentBlock[] {
  return messages.flatMap((m) =>
    (m.blocks ?? []).filter(
      (b): b is ClaudeToolGroupContentBlock => b.type === 'claude_tool_group',
    ),
  )
}

describe('foldClaudeToolGroups', () => {
  test('跨消息的相邻工具合并成一组，被掏空的消息不再单独成条', () => {
    const folded = foldClaudeToolGroups([
      assistant('m1', 't1', [tool('a')]),
      assistant('m2', 't1', [tool('b')]),
      assistant('m3', 't1', [tool('c')]),
    ])

    // 三条单工具消息 → 一条消息、一个组，时间轴上只剩一个色点
    expect(folded).toHaveLength(1)
    const all = groups(folded)
    expect(all).toHaveLength(1)
    expect(all[0]!.tools.map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  test('正文打断连续性，前后各自成组', () => {
    const folded = foldClaudeToolGroups([
      assistant('m1', 't1', [tool('a'), tool('b')]),
      assistant('m2', 't1', [{ id: 'x', type: 'text', text: '说明一下' }]),
      assistant('m3', 't1', [tool('c'), tool('d')]),
    ])

    const all = groups(folded)
    expect(all).toHaveLength(2)
    expect(all[0]!.tools.map((t) => t.id)).toEqual(['a', 'b'])
    expect(all[1]!.tools.map((t) => t.id)).toEqual(['c', 'd'])
  })

  test('正文之后落单的工具不并进前一组', () => {
    const folded = foldClaudeToolGroups([
      assistant('m1', 't1', [tool('a'), tool('b')]),
      assistant('m2', 't1', [{ id: 'x', type: 'text', text: '说明一下' }]),
      assistant('m3', 't1', [tool('c')]),
    ])

    const all = groups(folded)
    expect(all).toHaveLength(1)
    expect(all[0]!.tools.map((t) => t.id)).toEqual(['a', 'b'])
    expect(folded.at(-1)!.blocks?.map((b) => b.type)).toEqual(['tool_call'])
  })

  test('user 消息打断连续性', () => {
    const folded = foldClaudeToolGroups([
      assistant('m1', 't1', [tool('a'), tool('a2')]),
      user('u1', 't2', '再来一次'),
      assistant('m2', 't2', [tool('b'), tool('b2')]),
    ])

    const all = groups(folded)
    expect(all).toHaveLength(2)
    expect(all[0]!.tools.map((t) => t.id)).toEqual(['a', 'a2'])
    expect(all[1]!.tools.map((t) => t.id)).toEqual(['b', 'b2'])
  })

  test('落单的工具不成组，直接以 tool_call 渲染（否则要点两次才看到输出）', () => {
    const folded = foldClaudeToolGroups([
      assistant('m1', 't1', [tool('solo')]),
      assistant('m2', 't1', [{ id: 'x', type: 'text', text: '说明' }]),
    ])

    expect(groups(folded)).toHaveLength(0)
    expect(folded[0]!.blocks?.map((b) => b.type)).toEqual(['tool_call'])
    expect(folded[0]!.blocks?.[0]!.id).toBe('solo')
  })

  test('非工具内容原样保留，顺序不变（工具够数才成组）', () => {
    const folded = foldClaudeToolGroups([
      assistant('m1', 't1', [
        { id: 'r', type: 'reasoning', text: '想' },
        { id: 'x', type: 'text', text: '答' },
        tool('a'),
        tool('b'),
      ]),
    ])
    expect(folded[0]!.blocks?.map((b) => b.type)).toEqual([
      'reasoning',
      'text',
      'claude_tool_group',
    ])
  })

  test('组状态：任一 running → running，任一失败 → failed', () => {
    const running = groups(
      foldClaudeToolGroups([assistant('m1', 't1', [tool('a'), tool('b', 'running')])]),
    )
    expect(running[0]!.status).toBe('running')

    const failed = groups(
      foldClaudeToolGroups([assistant('m1', 't1', [tool('a'), tool('b', 'failed')])]),
    )
    expect(failed[0]!.status).toBe('failed')

    const done = groups(foldClaudeToolGroups([assistant('m1', 't1', [tool('a'), tool('b')])]))
    expect(done[0]!.status).toBe('completed')
  })

  test('跨消息生长时状态仍按全组结算，而不是停在第一条消息的中间态', () => {
    const all = groups(
      foldClaudeToolGroups([
        assistant('m1', 't1', [tool('a')]),
        assistant('m2', 't1', [tool('b', 'running')]),
      ]),
    )
    expect(all).toHaveLength(1)
    expect(all[0]!.status).toBe('running')
  })

  test('组 id 绑定首个工具，后续工具并入不会改变组身份', () => {
    const two = groups(
      foldClaudeToolGroups([
        assistant('m1', 't1', [tool('a')]),
        assistant('m2', 't1', [tool('b')]),
      ]),
    )
    const three = groups(
      foldClaudeToolGroups([
        assistant('m1', 't1', [tool('a')]),
        assistant('m2', 't1', [tool('b')]),
        assistant('m3', 't1', [tool('c')]),
      ]),
    )
    // 流式过程中工具不断并进来，组的 key 必须稳定，否则展开态会被重建掉
    expect(three[0]!.id).toBe(two[0]!.id)
  })

  test('没有工具的对话原样返回', () => {
    const input = [
      user('u1', 't1', 'hi'),
      assistant('m1', 't1', [{ id: 'x', type: 'text', text: 'yo' }]),
    ]
    const folded = foldClaudeToolGroups(input)
    expect(folded).toHaveLength(2)
    expect(groups(folded)).toHaveLength(0)
  })

  test('不写回入参消息——它跑在 computed 里，改 store 就是改自己的依赖', () => {
    // 这个函数是 MessageList 里 renderMessages computed 的全部内容，而 messages 是
    // message store 里的 reactive 对象。往回写一笔就构成「reactive effect 改自己的
    // 依赖」，Vue 会一轮轮重渲染：dev 下撞 Maximum recursive updates exceeded，打包后
    // 没有这道刹车，渲染进程直接转死（窗口自绘，连关闭按钮都点不动）。
    const input = [
      user('u1', 't1', 'hi'),
      assistant('m1', 't1', [tool('a')]),
      assistant('m2', 't1', [tool('b')]),
    ]
    const snapshot = input.map((message) => ({ message, blocks: message.blocks }))

    foldClaudeToolGroups(input)

    for (const { message, blocks } of snapshot) {
      // 数组本体必须是同一个引用——重新赋一个内容相同的新数组同样会触发 reactivity
      expect(message.blocks).toBe(blocks)
    }
    expect(input.map((m) => m.blocks!.map((b) => b.type))).toEqual([
      ['text'],
      ['tool_call'],
      ['tool_call'],
    ])
  })
})
