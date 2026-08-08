import type {
  ClaudeToolGroupContentBlock,
  ContentBlock,
  ToolCallContentBlock,
} from '@shared/backend/blocks'
import { messageBlocks } from '@shared/backend/normalize-blocks'
import type { NormalizedMessage } from '@shared/backend/types'

/**
 * Claude Tool Folding: 把相邻的工具调用折叠成一行可展开的摘要。
 *
 * 为什么在消息数组这一层做，而不是在 MessageItem 里做：连续的工具调用**跨消息**。
 * 归组之后一条 NormalizedMessage = 一条 API 消息，而实测 346 条 API 消息里 301 条
 * 只带一个 tool_use——真正让对话读起来冗长的是「一轮里连着几十次单工具调用」，
 * 那是消息与消息之间的事，单条消息内部看不到。
 *
 * 折叠是纯展示重组：`tools` 里放的就是原来的 tool_call 对象本体，展开后照常由
 * ToolCallBlockView 渲染。实时流和历史回放调的是同一个函数，所以「跑完的样子」和
 * 「重新打开的样子」是同一段代码算出来的，不需要把任何折叠状态持久化。
 *
 * 合并边界：正文 / 思考 / 任何非工具块都会打断一组，user 消息同样打断——
 * 与 Claude 自己的做法一致，中间说过话就不该再算作「连着干的一串活」。
 */
export function foldClaudeToolGroups(messages: NormalizedMessage[]): NormalizedMessage[] {
  const result: NormalizedMessage[] = []
  // 当前敞开的组：后续相邻工具直接并进来。null 表示连续性已被打断。
  let openGroup: ClaudeToolGroupContentBlock | null = null

  for (const message of messages) {
    if (message.role !== 'assistant') {
      openGroup = null
      result.push(message)
      continue
    }

    const blocks = messageBlocks(message)
    const folded: ContentBlock[] = []

    for (const block of blocks) {
      if (block.type !== 'tool_call') {
        openGroup = null
        folded.push(block)
        continue
      }
      const tool = block as ToolCallContentBlock
      if (openGroup) {
        openGroup.tools.push(tool)
        continue
      }
      openGroup = {
        // 用组内首个工具的 id 派生，组的身份就稳定绑在那个工具上——
        // 流式过程中后面的工具不断并进来，key 不会变，展开态不会被重建掉。
        id: `claude-tool-group-${tool.id}`,
        type: 'claude_tool_group',
        tools: [tool],
        status: 'running',
      }
      folded.push(openGroup)
    }

    // 整条消息的工具都并进了前一组 → 这条消息没有自己的内容，不再单独成条
    //（否则时间轴上会留下一个空的色点）。
    if (folded.length === 0) continue

    result.push({ ...message, blocks: folded })
  }

  // 组是跨消息生长的，只有装配完成后才知道它最终多大——状态结算和"够不够格成组"
  // 都必须等到这里，边生长边判会拿到中间态。
  for (const message of result) {
    if (!message.blocks) continue
    message.blocks = message.blocks.map((block) => {
      if (block.type !== 'claude_tool_group') return block
      // 只有一个工具就不套这层壳：摘要行显示的本来就是这个工具的标题，套上去
      // 只是让用户多点一次（先展开组、再展开卡片）才能看到输出。
      if (block.tools.length === 1) return block.tools[0]!
      block.status = groupStatus(block.tools)
      return block
    })
  }

  return result
}

function groupStatus(tools: ToolCallContentBlock[]): ClaudeToolGroupContentBlock['status'] {
  if (tools.some((tool) => tool.status === 'running')) return 'running'
  if (tools.some((tool) => tool.status === 'failed' || tool.output?.ok === false)) return 'failed'
  return 'completed'
}
