import {
  codexTurnsToMessages,
  mergeAssistantAndToolMessages,
} from '@main/backend/codex/history-mapping'
import type { NormalizedMessage } from '@shared/backend/types'
import { describe, expect, test } from 'vitest'

describe('codex history mapping', () => {
  test('user_message + agent_message 转 user/assistant', () => {
    const turns = [
      {
        id: 'turn_1',
        items: [
          { type: 'user_message', id: 'u1', content: [{ type: 'text', text: 'hello' }] },
          { type: 'agent_message', id: 'a1', text: 'hi there' },
        ],
      },
    ]
    const messages = codexTurnsToMessages(turns)
    expect(messages).toHaveLength(2)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.textBlocks?.[0]?.text).toBe('hello')
    expect(messages[1]!.role).toBe('assistant')
    expect(messages[1]!.textBlocks?.[0]?.text).toBe('hi there')
  })

  test('当前 App Server userMessage 保留图片、文件提及、skill 和 mention', () => {
    const messages = codexTurnsToMessages([
      {
        id: 'turn_inputs',
        items: [
          {
            type: 'userMessage',
            id: 'u-inputs',
            content: [
              {
                type: 'text',
                text: '检查这些输入',
                text_elements: [{ byteRange: { start: 0, end: 6 }, placeholder: '检查这些输入' }],
              },
              { type: 'image', url: 'https://example.com/design.png', detail: 'high' },
              { type: 'localImage', path: '/tmp/screenshot.png' },
              { type: 'skill', name: 'openai-docs', path: '/tmp/openai-docs/SKILL.md' },
              { type: 'mention', name: 'design.md', path: '/repo/docs/design.md' },
            ],
          },
        ],
      },
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]?.textBlocks?.[0]?.text).toBe('检查这些输入')
    expect(messages[0]?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'codex_user_input',
          kind: 'image',
          url: 'https://example.com/design.png',
          detail: 'high',
        }),
        expect.objectContaining({
          type: 'codex_user_input',
          kind: 'image',
          path: '/tmp/screenshot.png',
        }),
        expect.objectContaining({
          type: 'codex_user_input',
          kind: 'skill',
          name: 'openai-docs',
        }),
        expect.objectContaining({
          type: 'codex_user_input',
          kind: 'mention',
          path: '/repo/docs/design.md',
        }),
      ]),
    )
  })

  test('Codex Desktop 附件 envelope 只显示真实提问，并合并内嵌图片数据', () => {
    const imagePath = '/tmp/codex-clipboard-example.png'
    const messages = codexTurnsToMessages([
      {
        id: 'turn_envelope',
        items: [
          {
            type: 'userMessage',
            id: 'u-envelope',
            content: [
              {
                type: 'input_text',
                text: [
                  '',
                  '# Files mentioned by the user:',
                  '',
                  `## codex-clipboard-example.png: ${imagePath}`,
                  '',
                  '## My request for Codex:',
                  '只在气泡里显示这一句',
                ].join('\n'),
              },
              {
                type: 'input_text',
                text: `<image name=[Image #1] path="${imagePath}">`,
              },
              { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' },
              { type: 'input_text', text: '</image>' },
            ],
          },
        ],
      },
    ])

    const message = messages[0]!
    expect(message.textBlocks?.[0]?.text).toBe('只在气泡里显示这一句')
    expect(message.textBlocks?.[0]?.text).not.toContain('Files mentioned')
    expect(message.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'codex_user_input',
          kind: 'image',
          path: imagePath,
          url: 'data:image/png;base64,AAAA',
        }),
      ]),
    )
    expect(message.blocks?.filter((block) => block.type === 'codex_user_input')).toHaveLength(1)
  })

  test('旧 envelope 兼容下一行路径、非图片文件与纯附件消息', () => {
    const messages = codexTurnsToMessages([
      {
        id: 'turn_file',
        items: [
          {
            type: 'user_message',
            id: 'u-file',
            content: [
              {
                type: 'text',
                text: [
                  '# Files mentioned by the user:',
                  '',
                  '## design.md:',
                  'docs/design.md',
                  '',
                  '## My request for Codex:',
                ].join('\n'),
              },
            ],
          },
        ],
      },
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]?.textBlocks).toEqual([])
    expect(messages[0]?.blocks).toEqual([
      expect.objectContaining({
        type: 'codex_user_input',
        kind: 'file',
        name: 'design.md',
        path: 'docs/design.md',
      }),
    ])
  })

  test('command_execution 转为 Codex activity tool message', () => {
    const turns = [
      {
        id: 'turn_1',
        items: [
          { type: 'user_message', id: 'u1', content: 'list files' },
          { type: 'agent_message', id: 'a1', text: '' },
          {
            type: 'command_execution',
            id: 'c1',
            command: 'ls',
            status: 'completed',
            exitCode: 0,
            aggregatedOutput: 'file1\nfile2',
          },
        ],
      },
    ]
    const messages = codexTurnsToMessages(turns)
    // user + assistant（空文本）+ tool
    expect(messages.some((m) => m.role === 'tool')).toBe(true)
    const tool = messages.find((m) => m.role === 'tool')!
    expect(tool.blocks?.[0]?.type).toBe('codex_activity')
    if (tool.blocks?.[0]?.type === 'codex_activity') {
      expect(tool.blocks[0].activities[0]?.kind).toBe('command')
    }
  })

  test('mergeAssistantAndToolMessages 把 tool 合并到 assistant', () => {
    const messages: NormalizedMessage[] = [
      { id: 'u1', role: 'user', turnId: 't1', textBlocks: [], createdAt: 0 },
      {
        id: 'a1',
        role: 'assistant',
        turnId: 't1',
        textBlocks: [],
        toolBlocks: [],
        createdAt: 0,
      },
      {
        id: 'c1',
        role: 'tool',
        turnId: 't1',
        textBlocks: [],
        toolBlocks: [
          {
            id: 'c1',
            info: { kind: 'shell_command', title: 'ls' },
            status: 'completed',
          },
        ],
        createdAt: 0,
      },
    ]
    const merged = mergeAssistantAndToolMessages(messages)
    expect(merged).toHaveLength(2) // user + assistant（含 tool）
    expect(merged[1]!.toolBlocks).toHaveLength(1)
  })

  test('空 turns 返回空数组', () => {
    expect(codexTurnsToMessages([])).toEqual([])
  })

  test('未知 item 类型跳过', () => {
    const turns = [
      {
        id: 't1',
        items: [
          { type: 'unknown_future_type', id: 'x1', customField: 'whatever' },
          { type: 'agent_message', id: 'a1', text: 'kept' },
        ],
      },
    ]
    const messages = codexTurnsToMessages(turns)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.textBlocks?.[0]?.text).toBe('kept')
  })

  test('reasoning + agent_message 合并到同一个 assistant', () => {
    const turns = [
      {
        id: 't1',
        items: [
          {
            type: 'reasoning',
            id: 'r1',
            summary: [{ type: 'summary_text', text: 'thinking...' }],
          },
          { type: 'agent_message', id: 'a1', text: 'answer' },
        ],
      },
    ]
    const messages = codexTurnsToMessages(turns)
    // reasoning 先成为 assistant，agent_message 再 flush reasoning + 自成 assistant
    expect(messages).toHaveLength(2)
    expect(messages[0]!.textBlocks?.[0]?.kind).toBe('reasoning')
    expect(messages[1]!.textBlocks?.[0]?.text).toBe('answer')
  })

  test('camelCase 历史活动按相邻区段聚合并默认折叠', () => {
    const turns = [
      {
        id: 't1',
        durationMs: 159_000,
        items: [
          {
            type: 'reasoning',
            id: 'r1',
            summary: ['checking the implementation'],
            content: [],
          },
          { type: 'agentMessage', id: 'a1', text: '我先检查一下。', phase: 'commentary' },
          {
            type: 'commandExecution',
            id: 'c1',
            command: 'sed -n 1,20p src/a.ts',
            cwd: '/repo',
            status: 'completed',
            commandActions: [
              {
                type: 'read',
                command: 'sed -n 1,20p src/a.ts',
                name: 'a.ts',
                path: '/repo/src/a.ts',
              },
            ],
            aggregatedOutput: '...',
            exitCode: 0,
            durationMs: 50,
          },
          {
            type: 'fileChange',
            id: 'f1',
            status: 'completed',
            changes: [
              {
                path: '/repo/src/a.ts',
                kind: { type: 'update', move_path: null },
                diff: '@@ -1 +1 @@\n-old\n+new',
              },
            ],
          },
        ],
      },
    ]

    const merged = mergeAssistantAndToolMessages(codexTurnsToMessages(turns))
    const reasoning = merged
      .flatMap((message) => message.blocks ?? [])
      .find((block) => block.type === 'reasoning')
    const activity = merged
      .flatMap((message) => message.blocks ?? [])
      .find((block) => block.type === 'codex_activity')
    const commentary = merged
      .flatMap((message) => message.blocks ?? [])
      .find((block) => block.type === 'text')

    expect(reasoning).toMatchObject({
      type: 'reasoning',
      completedLabel: '已处理',
      durationMs: 159_000,
      defaultCollapsed: true,
    })
    expect(activity).toMatchObject({
      type: 'codex_activity',
      defaultCollapsed: true,
      status: 'completed',
    })
    expect(commentary).toMatchObject({ type: 'text', text: '我先检查一下。' })
    expect(commentary).toMatchObject({ phase: 'commentary' })
    if (activity?.type === 'codex_activity') {
      expect(activity.activities.map((item) => item.kind)).toEqual(['file_read', 'file_change'])
      expect(activity.activities[1]).toMatchObject({
        changes: [{ stats: { additions: 1, deletions: 1 } }],
      })
    }
  })

  test('中断 sentinel 保留原文构造 user message（防御性，与 claude 一致）', () => {
    // codex rollout 实际不会产生这种文本，但命中时仍构造标记消息——
    // renderer 识别后用 InterruptedHistoryEntry 特殊样式渲染，绕过 user 气泡布局。
    const messages = codexTurnsToMessages([
      {
        id: 'turn_interrupt',
        items: [
          {
            type: 'user_message',
            id: 'u-interrupt',
            content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }],
          },
        ],
      },
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.textBlocks?.[0]?.text).toBe('[Request interrupted by user for tool use]')
  })
})
