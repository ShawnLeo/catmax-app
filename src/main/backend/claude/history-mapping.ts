/**
 * claude 重放消息 → NormalizedMessage[]
 *
 * claude --resume <id> 启动后（不写 stdin），stdout 会按时间顺序重放：
 *   1. system/init（启动握手）
 *   2. 多条 assistant + user（含 tool_use / tool_result）—— 历史回放
 *   3. result（结束）
 *
 * 转换规则：
 *   - assistant.message.content 里的 text → textBlocks (kind: 'text')
 *   - assistant.message.content 里的 thinking → textBlocks (kind: 'reasoning')
 *   - assistant.message.content 里的 tool_use → 当前 assistant 的 toolBlocks（status: running）
 *   - 后续 user.message.content 里的 tool_result → 把对应 tool_use 标为 completed/failed
 *   - 后续 user.message.content 里的 text → 新的 user message
 *
 * 最后扫一遍：仍为 running 的 tool（缺失配对的 tool_result）→ 标为 completed（历史不应有 running）。
 */
import { randomUUID } from 'node:crypto'

import type {
  AssistantMessage,
  ClaudeStreamMessage,
  TextContent,
  ThinkingContent,
  ToolResultContent,
  ToolUseContent,
  UserMessage,
} from '@shared/backend/claude-schema'
import { sharedContextTagExtractors } from '@shared/backend/context-tag-handlers'
import { extractContextTags } from '@shared/backend/context-tags'
import { matchInterruptMarker } from '@shared/backend/interrupt-marker'
import { upgradeMessageBlocks } from '@shared/backend/normalize-blocks'
import type { NormalizedMessage, ToolCallInfo } from '@shared/backend/types'

import { toolResultToOutput, toolUseResultToStats, toolUseToInfo } from './mapping'

// contentBlockSchema 是 z.union 带 passthrough 兜底——switch(block.type) 不会收窄字段，
// 访问具体字段时显式 Extract + as cast（与 mapping.ts 一致）。

/**
 * 检测 user 文本是否是 claude slash command 调用 sentinel，是则返回 command-name。
 *
 * claude 写入 jsonl 的命令调用形如：
 *   <command-message>init</command-message>
 *   <command-name>/init</command-name>
 *
 * 我们只展示 command-name（"/init"），隐藏丑陋的 sentinel 文本。
 * 不是命令则返回 null。
 */
function extractCommandName(text: string): string | null {
  // 必须同时含 command-message 和 command-name 才算命令调用 sentinel
  if (!text.includes('<command-message>')) return null
  const m = text.match(/<command-name>([^<]+)<\/command-name>/)
  const name = m?.[1]
  return name ? name.trim() : null
}

/**
 * 检测 user 文本是否是 /compact 生成的会话延续摘要，是则返回摘要原文。
 *
 * 摘要的特征：以固定前缀开头，内容极长（含 "Summary:" / 编号列表等）。
 * 这是 claude 在 /compact 后自动注入给下一轮 agent 的"上文总结"。
 * 用户希望展示在 /compact 消息后面（作为 /compact 的产物），而不是独立成一条。
 *
 * 注意：摘要在 jsonl 里的顺序在 /compact 命令调用**之前**——所以这里只提取原文，
 * 暂存到 pendingCompactSummary，等 /compact 命令到达时附加进去。
 */
function extractCompactSummary(text: string): string | null {
  if (text.startsWith('This session is being continued from a previous conversation')) {
    return text
  }
  return null
}

/**
 * 检测 user 文本是否是 claude 自动注入的系统 sentinel——这些不是用户真实输入，
 * UI 上应跳过（不展示成 user 消息）。
 *
 * 已知 sentinel：
 *   1. <local-command-caveat>...</local-command-caveat>
 *      slash command 执行时 claude 自动加的"以下消息由本地命令产生"声明
 *   2. <local-command-stdout>...</local-command-stdout>
 *      slash command 的 stdout（/compact 的 "Compacted Tip: ..." 等）
 *      注意：command-name 调用本身会设 lastWasCommandInvocation 标志，
 *      <local-command-stdout> 紧随其后会被标志跳过。但保险起见这里也显式跳过，
 *      防止 stdout 出现在 command 之前或其他顺序问题。
 *
 * compact 摘要（"This session is being continued..."）不在这里跳过——它由
 * extractCompactSummary 单独识别后暂存，附加到后续的 /compact 消息后面。
 */
function isSystemSentinel(text: string): boolean {
  if (text.includes('<local-command-caveat>')) return true
  if (text.includes('<local-command-stdout>')) return true
  return false
}

const TASK_STATUS_FALLBACK: Record<'completed' | 'failed' | 'stopped', string> = {
  completed: '后台任务已完成',
  failed: '后台任务失败',
  stopped: '后台任务已停止',
}

/**
 * 在已产出的消息里按 tool_use_id 找工具块。
 *
 * 不能复用 pendingToolUseIds：后台任务的 Bash/Task 调用在启动那一刻就已经拿到
 * tool_result（"Command running in background with ID: ..."）并被移出 pending，
 * 而完成通知是几分钟后才到的。这里直接全量搜已产出的消息。
 */
function findToolBlock(
  messages: NormalizedMessage[],
  currentAssistant: NormalizedMessage | null,
  toolUseId: string,
): NonNullable<NormalizedMessage['toolBlocks']>[number] | undefined {
  for (const msg of currentAssistant ? [...messages, currentAssistant] : messages) {
    const found = msg.toolBlocks?.find((b) => b.id === toolUseId)
    if (found) return found
  }
  return undefined
}

/** <task-notification> 里被解析出来的字段。 */
interface TaskNotification {
  taskId: string
  toolUseId?: string
  status: 'completed' | 'failed' | 'stopped'
  summary?: string
}

function tagValue(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)
  return match?.[1]?.trim() || undefined
}

/**
 * 解析后台任务完成通知。
 *
 * SDK 用一条 role=user 的消息把后台任务的终态送回模型（jsonl 里 origin.kind
 * 是 'task-notification'），文本是一段 XML。它是喂给模型的信封，不是用户说的话——
 * 直接渲染就会在对话里冒出一个用户根本没发过的气泡，里面全是 task-id / 文件路径。
 *
 * SDK 自己的 skip_transcript 字段也写明这类消息"应从 inline transcript 隐藏，
 * 但可以出现在任务面板里"。所以这里把它解析成结构化终态，回填到发起它的那个
 * 工具卡片上（tool-use-id 正是为此而带），气泡本身丢弃。
 */
function parseTaskNotification(text: string): TaskNotification | null {
  if (!text.includes('<task-notification>')) return null
  const taskId = tagValue(text, 'task-id')
  if (!taskId) return null
  const rawStatus = tagValue(text, 'status')
  const status: TaskNotification['status'] =
    rawStatus === 'failed' ? 'failed' : rawStatus === 'stopped' ? 'stopped' : 'completed'
  const toolUseId = tagValue(text, 'tool-use-id')
  const summary = tagValue(text, 'summary')
  return {
    taskId,
    ...(toolUseId ? { toolUseId } : {}),
    status,
    ...(summary ? { summary } : {}),
  }
}

/**
 * 把一条 assistant jsonl 行的 content blocks 追加进目标 NormalizedMessage。
 *
 * 抽出独立函数服务 Same-Id Merge：同一条 API assistant message 被 claude 拆成
 * 多行写进 jsonl（每行含部分 content blocks），合并时需要对每行重复这套
 * text→textBlocks / thinking→textBlocks(reasoning) / tool_use→toolBlocks 的处理。
 *
 * 不处理的 block 类型（server_tool_use / 服务端 tool_result / 未知类型）直接跳过——
 * 它们是 claude 服务端工具（如 webReader）的内部块，本项目不渲染。调用方负责在
 * 合并完成后丢弃没有任何可见 block 的空消息。
 */
function appendAssistantBlocks(
  target: NormalizedMessage,
  assistantMsg: AssistantMessage,
  pendingToolUseIds: Map<string, { info: ToolCallInfo; messageId: string }>,
): void {
  for (const block of assistantMsg.message.content) {
    if (block.type === 'text') {
      const text = (block as TextContent).text
      if (text) {
        target.textBlocks!.push({ id: randomUUID(), text, kind: 'text' })
      }
    } else if (block.type === 'thinking') {
      const text = (block as ThinkingContent).thinking
      if (text) {
        target.textBlocks!.push({ id: randomUUID(), text, kind: 'reasoning' })
      }
    } else if (block.type === 'tool_use') {
      const tu = block as ToolUseContent
      const info = toolUseToInfo(tu)
      target.toolBlocks!.push({
        id: tu.id,
        info,
        status: 'running', // 等 tool_result 改成 completed/failed
        // 历史回放没有精确 startedAt，但 UI 可以从 taskStats.totalDurationMs 反推（非必须）
      })
      // 即使 target 还没 flush，也按 id 索引——后面在 result 里查找
      pendingToolUseIds.set(tu.id, { info, messageId: target.id })
    }
    // 其他 block 类型（server_tool_use / 服务端 tool_result / 未知）跳过
  }
}

/** 把重放的 claude 消息流转成 NormalizedMessage[] */
export function claudeReplayToMessages(messages: ClaudeStreamMessage[]): NormalizedMessage[] {
  const result: NormalizedMessage[] = []
  let currentAssistant: NormalizedMessage | null = null
  // tool_use_id → 它所在的 assistant message（已 push 到 result）
  const pendingToolUseIds = new Map<string, { info: ToolCallInfo; messageId: string }>()
  // 上一条 user 是命令调用（<command-message>）时置为 true——
  // 紧跟的下一条 user 文本消息是 claude 自己注入的 command 展开 prompt（isMeta:true），
  // 应跳过，避免历史里出现两条用户消息（command 调用 + 长 prompt 文本）。
  let lastWasCommandInvocation = false
  // 暂存的 /compact 摘要原文——compact 摘要在 jsonl 里出现在 /compact 命令调用
  // **之前**，但 UI 上希望展示在 /compact 后面。先暂存，等 /compact 命令到达时附加。
  // 如果 /compact 命令一直没来（异常情况），flushAssistant 兜底丢弃。
  let pendingCompactSummary: string | null = null

  function flushAssistant(): void {
    if (currentAssistant) {
      // Empty Message Guard: 合并后仍无任何可见 block 的 assistant 消息不 push——
      // 历史里只含 server_tool_use / 服务端 tool_result / 空文本的行（claude 服务端
      // 工具的内部块，本项目不渲染）会产出空气泡：UI 画色点但消息体为空。丢弃它们。
      const hasText = (currentAssistant.textBlocks?.length ?? 0) > 0
      const hasTool = (currentAssistant.toolBlocks?.length ?? 0) > 0
      const hasOtherBlocks = (currentAssistant.blocks?.length ?? 0) > 0
      if (hasText || hasTool || hasOtherBlocks) {
        result.push(currentAssistant)
      }
      currentAssistant = null
    }
  }

  for (const msg of messages) {
    if (msg.type === 'assistant') {
      const assistantMsg = msg as AssistantMessage
      // 命令展开标志只在"紧接的下一条 user 文本"生效；遇到 assistant 自动清掉
      // （说明这条 user 不是命令的展开 prompt，而是新一轮真实输入）
      lastWasCommandInvocation = false
      // Same-Id Merge: claude 把同一条 API assistant message 的内容按 content block
      // 分多行写进 jsonl（thinking 一行、text 一行、tool_use 一行……共享同一个
      // message.id）。若每行都新建一条 NormalizedMessage，同一条 API 消息会被拆成
      // 多条 → UI 上画出多个紧挨着的色点，其中只含 server_tool_use / tool_result 等
      // 未渲染类型的行还变成空消息（只画点没内容）。
      //
      // 合并目标有两个：尚未 flush 的 currentAssistant，以及已被 flush 进 result 的
      // 同 id 消息。后者必须处理——后台任务 summary 场景里，同一条 API message 被
      // 拆成多行、中间夹着一条带文本的 user 行（任务完成通知 / 下一轮 prompt），
      // user 文本会触发 flushAssistant() 把 currentAssistant 推进 result 并清空，
      // 之后到来的同 id assistant 行若只对照 currentAssistant 会判失败 → 新建一条
      // 同 id 消息 → result 里两条相同 id → renderer MessageList :key 报 Duplicate keys。
      if (currentAssistant && currentAssistant.id === assistantMsg.message.id) {
        appendAssistantBlocks(currentAssistant, assistantMsg, pendingToolUseIds)
        continue
      }
      const flushedSameId = result.find((m) => m.id === assistantMsg.message.id)
      if (flushedSameId) {
        appendAssistantBlocks(flushedSameId, assistantMsg, pendingToolUseIds)
        continue
      }
      // 新 assistant message——先 flush 上一个
      flushAssistant()
      const assistant: NormalizedMessage = {
        id: assistantMsg.message.id,
        role: 'assistant',
        turnId: 'history',
        textBlocks: [],
        toolBlocks: [],
        createdAt: 0,
      }
      appendAssistantBlocks(assistant, assistantMsg, pendingToolUseIds)
      currentAssistant = assistant
    } else if (msg.type === 'user') {
      // user message 可能含 tool_result（配对之前 assistant 的 tool_use）
      // 或含 text（用户真实输入，可能多个 text block：IDE 标签 + 实际 prompt）。
      //
      // ⚠️ 关键：同一条 user message 里的所有 text block 是**同一次输入**——
      // claude 把 IDE 附件（<ide_selection> / <ide_opened_file>）和用户实际 prompt
      // 拆成两个 text block 存到同一个 content 数组里。必须先把它们拼接成完整字符串，
      // 再走 extractContextTags，才能让标签被正确抽到 contextBlocks、剩余文本留 textBlocks，
      // UI 上合成一条消息。否则会被拆成两条 user message（一条只有 chip，一条只有文本）。
      const userMsg = msg as UserMessage
      const content = userMsg.message.content
      const collectedText: string[] = []
      for (const block of content) {
        if (block.type === 'tool_result') {
          const tr = block as ToolResultContent
          // tool_result 不是命令展开文本——清掉标志
          lastWasCommandInvocation = false
          const output = toolResultToOutput(tr)
          // 在已 push 的 assistant（包括还没 flush 的 currentAssistant）里找
          const target =
            result.find((m) => pendingToolUseIds.get(tr.tool_use_id)?.messageId === m.id) ??
            (currentAssistant !== null &&
            pendingToolUseIds.get(tr.tool_use_id)?.messageId === currentAssistant.id
              ? currentAssistant
              : null)
          if (target?.toolBlocks) {
            const tb = target.toolBlocks.find((b) => b.id === tr.tool_use_id)
            if (tb) {
              tb.status = output.ok ? 'completed' : 'failed'
              tb.output = output
              // Task（子 Agent）完成统计--jsonl 的 user 消息带顶层 tool_use_result 字段
              const stats = toolUseResultToStats(userMsg.tool_use_result)
              if (stats !== undefined) tb.taskStats = stats
            }
          }
          pendingToolUseIds.delete(tr.tool_use_id)
        } else if (block.type === 'text') {
          // 收集 text block——先不处理，等本 message 所有 block 走完后统一拼接
          collectedText.push((block as TextContent).text)
        }
        // 其他 block 类型跳过
      }

      // 本条 user message 的所有 text block 收集完——拼接 + 命令检测 + 提取 IDE 标签
      if (collectedText.length > 0) {
        flushAssistant()
        const rawText = collectedText.join('\n\n')

        // /compact 摘要暂存——它在 jsonl 里出现在 /compact 命令**之前**，
        // 但 UI 上希望展示在 /compact 后面，所以先暂存等命令到达时附加。
        const compactSummary = extractCompactSummary(rawText)
        if (compactSummary !== null) {
          pendingCompactSummary = compactSummary
          continue
        }

        // 后台任务完成通知：不是用户输入，不能成气泡。终态回填到发起它的工具卡片，
        // 这样历史回放和实时流（background_task_updated 事件）看到的是同一个结果。
        const notification = parseTaskNotification(rawText)
        if (notification) {
          lastWasCommandInvocation = false
          if (notification.toolUseId) {
            const tb = findToolBlock(result, currentAssistant, notification.toolUseId)
            if (tb) {
              tb.status = notification.status === 'completed' ? 'completed' : 'failed'
              tb.output = {
                ok: notification.status === 'completed',
                summary: notification.summary ?? TASK_STATUS_FALLBACK[notification.status],
              }
              tb.taskStats = {
                ...(tb.taskStats ?? {}),
                status: notification.status,
                ...(notification.summary ? { progressSummary: notification.summary } : {}),
              }
            }
          }
          continue
        }

        // 系统 sentinel 跳过——这些是 claude 自动注入的（caveat 声明、
        // local-command-stdout），不是用户真实输入，UI 上不应展示成 user 消息。
        if (isSystemSentinel(rawText)) {
          // 不清 lastWasCommandInvocation——caveat/stdout 可能跟在 command 后，
          // 标志逻辑会处理。
          continue
        }

        // 中断标记：Claude SDK 在用户中断回合后写入的 sentinel
        // （`[Request interrupted by user]` / `... for tool use]`）。
        // 仍 push 一条 user message，但 textBlocks[0].text 保留 sentinel 原文——
        // renderer（MessageItem.vue）在 <article> 外层识别后交给
        // InterruptedHistoryEntry.vue 用特殊胶囊样式渲染，绕过 user 气泡布局。
        // （复刻 /compact 的拦截渲染模式。）命中后清掉命令展开标志并跳过后续分支。
        if (matchInterruptMarker(rawText)) {
          lastWasCommandInvocation = false
          result.push({
            id: randomUUID(),
            role: 'user',
            turnId: 'history',
            textBlocks: [{ id: randomUUID(), text: rawText.trim(), kind: 'text' }],
            createdAt: 0,
          })
          continue
        }

        // 命令调用检测：claude slash command（/init /compact /clear 等）会写两条
        // user 消息——第一条是 sentinel 文本（<command-message>X</command-message>
        // <command-name>/X</command-name>），第二条是 claude 自己注入的长 prompt
        // 展开（isMeta:true，让 agent 知道怎么执行该命令）。
        //
        // UI 上只展示一条：把 sentinel 解析出 command-name（"/init"），并标记
        // "下一条 user 文本是这次命令的展开"，跳过它，避免历史里出现两条。
        //
        // 特例：如果是 /compact 且前面暂存了 compact 摘要，把摘要作为第二个
        // textBlock 附加进来——摘要展示在 /compact 命令后面，作为它的产物。
        const cmdName = extractCommandName(rawText)
        if (cmdName) {
          const textBlocks: { id: string; text: string; kind: 'text' | 'reasoning' }[] = [
            { id: randomUUID(), text: cmdName, kind: 'text' },
          ]
          if (cmdName === '/compact' && pendingCompactSummary) {
            textBlocks.push({
              id: randomUUID(),
              text: pendingCompactSummary,
              kind: 'text',
            })
          }
          pendingCompactSummary = null
          result.push({
            id: randomUUID(),
            role: 'user',
            turnId: 'history',
            textBlocks,
            createdAt: 0,
          })
          lastWasCommandInvocation = true
        } else if (lastWasCommandInvocation) {
          // 上一条是命令调用 + 这条是紧随的 user 文本 → 视为 command 展开 prompt，跳过
          lastWasCommandInvocation = false
        } else {
          // 提取 IDE context tag（<ide_selection> / <ide_opened_file> / <environment_context>）。
          // 提取后 textBlocks 存去掉 tag 的纯 prompt，contextBlocks 存结构化 tag。
          const { text, blocks } = extractContextTags(rawText, sharedContextTagExtractors)
          // text 为空（只有 IDE 标签没实际 prompt）且无 contextBlocks 时不 push——
          // 避免历史里出现空气泡
          if (text.trim() || blocks.length > 0) {
            result.push({
              id: randomUUID(),
              role: 'user',
              turnId: 'history',
              textBlocks: text.trim() ? [{ id: randomUUID(), text, kind: 'text' }] : [],
              ...(blocks.length > 0 ? { contextBlocks: blocks } : {}),
              createdAt: 0,
            })
          }
        }
      }
    }
    // system / result 不在这里处理
  }
  flushAssistant()

  // 历史不应有 running 状态的 tool——把没配对 tool_result 的标为 completed
  for (const msg of result) {
    if (msg.toolBlocks) {
      for (const tb of msg.toolBlocks) {
        if (tb.status === 'running') {
          tb.status = 'completed'
          tb.output = { ok: true, summary: '(no result recorded)' }
        }
      }
    }
  }

  return result.map(upgradeMessageBlocks)
}
