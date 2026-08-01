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

  test('中断 sentinel 保留原文构造 user message（交给 renderer 特殊渲染）', () => {
    // Claude SDK 在用户中断回合后往 transcript 写 sentinel：
    //   `[Request interrupted by user]`
    //   `[Request interrupted by user for tool use]`
    // history-mapping 识别后仍 push 一条 role:'user' 消息，textBlocks[0].text
    // 保留 sentinel 原文——renderer（MessageItem.vue）识别后用 InterruptedHistoryEntry
    // 特殊胶囊样式渲染，绕过 user 气泡布局。
    const messages = claudeReplayToMessages([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '开始任务' }],
        },
      },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: '正在执行...' }],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user]' }],
        },
      },
    ])
    const userMsgs = messages.filter((m) => m.role === 'user')
    expect(userMsgs).toHaveLength(2)
    // 中断 sentinel 原样保留（让 renderer 能识别）
    expect(userMsgs[1]!.textBlocks?.[0]?.text).toBe('[Request interrupted by user]')
  })

  test('Same-Id Merge：同一条 API message 拆成多行 jsonl 时合并成一条', () => {
    // claude 把同一条 assistant API message 的内容按 content block 分多行写进 jsonl，
    // 共享同一个 message.id。之前每行都新建一条 NormalizedMessage → 同一条 API 消息
    // 变成多条 → UI 画出多个紧挨着的色点。修复后按 id 合并成一条。
    const messages = claudeReplayToMessages([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      // 同一个 id 'm1' 的三行——thinking / text / tool_use 各一行
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: '先想想' }],
        },
      },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: '我来执行' }],
        },
      },
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
    const assistantMsgs = messages.filter((m) => m.role === 'assistant')
    // 三行同 id 合并成一条 assistant 消息（不再是 3 条）
    expect(assistantMsgs).toHaveLength(1)
    // thinking + text 两个 textBlocks + 一个 toolBlock
    expect(assistantMsgs[0]!.textBlocks).toHaveLength(2)
    expect(assistantMsgs[0]!.textBlocks?.[0]?.kind).toBe('reasoning')
    expect(assistantMsgs[0]!.textBlocks?.[1]?.kind).toBe('text')
    expect(assistantMsgs[0]!.toolBlocks).toHaveLength(1)
  })

  test('Same-Id Merge：中间夹的 tool_result（user 行）不打断同 id 合并', () => {
    // 真实 jsonl 里同 id 的 assistant 行之间可能夹着 user tool_result 行
    // （服务端工具结果直接写进 assistant message 序列）。合并只看 assistant 行的 id，
    // 不被中间的 user 行打断。
    const messages = claudeReplayToMessages([
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: '查一下' }],
        },
      },
      // 中间夹一条 user tool_result（配对前一个 tool_use，这里只是模拟穿插）
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_prev', content: 'prev result' }],
        },
      },
      // 同 id m1 的后续行——应继续合并到第一条 m1
      {
        type: 'assistant',
        message: {
          id: 'm1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: '继续' }],
        },
      },
    ])
    const assistantMsgs = messages.filter((m) => m.role === 'assistant')
    expect(assistantMsgs).toHaveLength(1)
    expect(assistantMsgs[0]!.textBlocks).toHaveLength(2)
  })

  test('Empty Message Guard：只含 server_tool_use/tool_result 的 assistant 行不产空消息', () => {
    // claude 服务端工具（webReader 等）的 server_tool_use / tool_result 块本项目不渲染。
    // 若一条 assistant 行只含这些块，合并后该行不贡献任何可见 block；
    // 当它是独立 id 时不应产出空气泡（只画色点无内容）。
    const messages = claudeReplayToMessages([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '搜一下' }] },
      },
      // 这条只含 server_tool_use（passthrough 类型，不被处理）→ 不应产出空消息
      {
        type: 'assistant',
        message: {
          id: 'm-empty',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'server_tool_use', name: 'webReader', input: {} }],
        },
      },
      {
        type: 'assistant',
        message: {
          id: 'm-real',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: '搜到了' }],
        },
      },
    ])
    const assistantMsgs = messages.filter((m) => m.role === 'assistant')
    // 只剩 m-real 一条（m-empty 被丢弃，不产空气泡）
    expect(assistantMsgs).toHaveLength(1)
    expect(assistantMsgs[0]!.id).toBe('m-real')
  })

  describe('后台任务完成通知', () => {
    /** 复刻真实 jsonl：后台 Bash 启动 → 立即拿到 running 回执 → 几分钟后收到完成通知。 */
    function replayWithNotification(status: string, summary: string) {
      return claudeReplayToMessages([
        {
          type: 'assistant',
          message: {
            id: 'm1',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_89007',
                name: 'Bash',
                input: { command: 'pnpm dist:mac', run_in_background: true },
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
                type: 'tool_result',
                tool_use_id: 'call_89007',
                content: 'Command running in background with ID: b2d7h94fn.',
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
                text: `<task-notification>\n<task-id>b2d7h94fn</task-id>\n<tool-use-id>call_89007</tool-use-id>\n<output-file>/tmp/x/tasks/b2d7h94fn.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`,
              },
            ],
          },
        },
      ])
    }

    test('不产生 user 气泡，终态回填到发起它的工具卡片', () => {
      const messages = replayWithNotification('completed', 'Background command "打包" completed')

      // 通知本身是喂给模型的信封，不是用户说的话——历史里只应有那条 tool_result 的
      // user 消息被消费掉，不能多出一个装着 task-id/文件路径的气泡。
      const userTexts = messages
        .filter((m) => m.role === 'user')
        .flatMap((m) => m.textBlocks?.map((b) => b.text) ?? [])
      expect(userTexts.join('')).not.toContain('task-notification')
      expect(userTexts.join('')).not.toContain('b2d7h94fn')

      const tool = messages.find((m) => m.role === 'assistant')?.toolBlocks?.[0]
      expect(tool?.status).toBe('completed')
      expect(tool?.output?.ok).toBe(true)
      expect(tool?.output?.summary).toBe('Background command "打包" completed')
      expect(tool?.taskStats?.status).toBe('completed')
    })

    test('失败状态标红并保留 summary', () => {
      const messages = replayWithNotification('failed', 'exit code 1')
      const tool = messages.find((m) => m.role === 'assistant')?.toolBlocks?.[0]
      expect(tool?.status).toBe('failed')
      expect(tool?.output?.ok).toBe(false)
      expect(tool?.output?.summary).toBe('exit code 1')
      expect(tool?.taskStats?.status).toBe('failed')
    })

    test('长得像通知但缺 task-id 的普通文本仍按用户消息处理', () => {
      const messages = claudeReplayToMessages([
        {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '这段 <task-notification> 是我手打的' }],
          },
        },
      ])
      expect(messages).toHaveLength(1)
      expect(messages[0]!.textBlocks?.[0]?.text).toContain('我手打的')
    })
  })
})
