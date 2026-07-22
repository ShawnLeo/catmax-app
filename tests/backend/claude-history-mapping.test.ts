import { claudeReplayToMessages } from '@main/backend/claude/history-mapping'
import { describe, expect, test } from 'vitest'

describe('claude history mapping', () => {
  test('assistant + user 文本转消息', () => {
    const messages = claudeReplayToMessages([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
        },
      },
    ])
    expect(messages).toHaveLength(2)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.textBlocks?.[0]?.text).toBe('hi')
    expect(messages[1]!.role).toBe('assistant')
    expect(messages[1]!.textBlocks?.[0]?.text).toBe('hello')
  })

  test('tool_use + tool_result 配对', () => {
    const messages = claudeReplayToMessages([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'text', text: 'running' },
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file1' }],
        },
      },
    ])
    expect(messages).toHaveLength(1) // assistant 含 tool
    expect(messages[0]!.toolBlocks?.[0]?.status).toBe('completed')
    expect(messages[0]!.toolBlocks?.[0]?.output?.output).toBe('file1')
  })

  test('未配对的 tool_use 标为 completed（带默认 output）', () => {
    const messages = claudeReplayToMessages([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }],
        },
      },
    ])
    expect(messages[0]!.toolBlocks?.[0]?.status).toBe('completed')
    expect(messages[0]!.toolBlocks?.[0]?.output?.summary).toContain('no result')
  })

  test('thinking 块归 reasoning', () => {
    const messages = claudeReplayToMessages([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hmm let me think' },
            { type: 'text', text: 'answer' },
          ],
        },
      },
    ])
    expect(messages[0]!.textBlocks).toHaveLength(2)
    expect(messages[0]!.textBlocks?.[0]?.kind).toBe('reasoning')
    expect(messages[0]!.textBlocks?.[1]?.kind).toBe('text')
  })

  test('空输入返回空数组', () => {
    expect(claudeReplayToMessages([])).toEqual([])
  })

  test('system + result 消息被忽略', () => {
    const messages = claudeReplayToMessages([
      { type: 'system', subtype: 'init', session_id: 's1' },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
        },
      },
      { type: 'result', subtype: 'success', is_error: false },
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('assistant')
  })

  test('slash command 调用合并：sentinel + 展开文本只展示 command-name', () => {
    // claude 写 jsonl 时 slash command 会写两条 user 消息：
    //   1. sentinel 文本（<command-message>X</command-message><command-name>/X</command-name>）
    //   2. claude 自己注入的长 prompt 展开（isMeta:true）让 agent 知道怎么执行
    // UI 上只展示一条（command-name "/init"），长 prompt 隐藏。
    const messages = claudeReplayToMessages([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<command-message>init</command-message>\n<command-name>/init</command-name>',
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Please analyze this codebase and create a CLAUDE.md file, which will be given to future instances of Claude Code to operate in this repository.\n\nWhat to add:\n1. Commands that will be commonly used...',
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
      },
    ])
    // 只展示一条 user 消息（sentinel 解析后的 "/init"），展开 prompt 被跳过
    const userMsgs = messages.filter((m) => m.role === 'user')
    expect(userMsgs).toHaveLength(1)
    expect(userMsgs[0]!.textBlocks?.[0]?.text).toBe('/init')
  })

  test('slash command 后跟 assistant，flag 不误清', () => {
    // 边界：command sentinel 后没有展开 prompt，直接是 assistant 回复——
    // 这种情况下 command 调用本身应正常展示，不会被跳过
    const messages = claudeReplayToMessages([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<command-message>clear</command-message>\n<command-name>/clear</command-name>',
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'cleared' }],
        },
      },
    ])
    expect(messages).toHaveLength(2)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.textBlocks?.[0]?.text).toBe('/clear')
    expect(messages[1]!.role).toBe('assistant')
  })

  test('同一 user message 多个 text block 合并成一条（IDE 标签 + prompt）', () => {
    // claude 把 IDE 附件（<ide_selection>）和实际 prompt 拆成两个 text block
    // 存在同一条 user message 的 content 数组里。必须拼接后统一提取，才能让
    // 标签进 contextBlocks、剩余 prompt 留 textBlocks，UI 上合成一条消息。
    // 之前 bug：每个 text block 独立 push 一条 user message → 历史里看到两条。
    const messages = claudeReplayToMessages([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<ide_selection>The user selected the lines 41 to 41 from /path/Composer.vue:\nModel\nThis may or may not be related to the current task.</ide_selection>',
            },
            {
              type: 'text',
              text: '把刷新按钮移动到 Composer 里',
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
      },
    ])
    // 只应有一条 user 消息：ide_selection 进 contextBlocks，prompt 留 textBlocks
    const userMsgs = messages.filter((m) => m.role === 'user')
    expect(userMsgs).toHaveLength(1)
    expect(userMsgs[0]!.textBlocks?.[0]?.text).toBe('把刷新按钮移动到 Composer 里')
    expect(userMsgs[0]!.contextBlocks).toHaveLength(1)
    expect(userMsgs[0]!.contextBlocks?.[0]?.tag).toBe('ide_selection')
  })

  test('只有 IDE 标签没实际 prompt 时仍展示 chip（不空气泡）', () => {
    const messages = claudeReplayToMessages([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<ide_opened_file>The user opened the file /path/foo.vue in the IDE. This may or may not be related to the current task.</ide_opened_file>',
            },
          ],
        },
      },
    ])
    const userMsgs = messages.filter((m) => m.role === 'user')
    expect(userMsgs).toHaveLength(1)
    expect(userMsgs[0]!.contextBlocks).toHaveLength(1)
    expect(userMsgs[0]!.contextBlocks?.[0]?.tag).toBe('ide_opened_file')
    // 无 prompt 文本时 textBlocks 为空数组（UI 上只展示 chip）
    expect(userMsgs[0]!.textBlocks).toHaveLength(0)
  })

  test('/compact 场景：4 条系统注入消息只展示 /compact 一条，摘要附加其后', () => {
    // /compact 执行后 claude 写入 jsonl 4 条特殊 user 消息（都是 string content，
    // jsonl-reader 会转成 array）：
    //   L1: "This session is being continued..." (compact 摘要，极长)
    //   L2: "<local-command-caveat>...</local-command-caveat>" (系统声明)
    //   L3: "<command-name>/compact</command-name> <command-message>compact</command-message>..." (命令调用)
    //   L4: "<local-command-stdout>Compacted Tip: ...</local-command-stdout>" (命令 stdout)
    //
    // UI 上只展示 L3 解析出的 /compact，compact 摘要作为 /compact 的产物附加在其后
    // （textBlocks[1]），L2 L4 都是系统注入跳过。
    const messages = claudeReplayToMessages([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request...',
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly makes a request.</local-command-caveat>',
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>',
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<local-command-stdout>Compacted Tip: You have access to Sonnet 1M with 5x more context</local-command-stdout>',
            },
          ],
        },
      },
    ])
    const userMsgs = messages.filter((m) => m.role === 'user')
    expect(userMsgs).toHaveLength(1)
    // textBlocks[0] 是 /compact 命令名
    expect(userMsgs[0]!.textBlocks?.[0]?.text).toBe('/compact')
    // textBlocks[1] 是附加的 compact 摘要
    expect(userMsgs[0]!.textBlocks).toHaveLength(2)
    expect(userMsgs[0]!.textBlocks?.[1]?.text).toContain('This session is being continued')
  })
})
