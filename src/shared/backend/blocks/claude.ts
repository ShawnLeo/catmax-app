/**
 * Claude 专属 block 契约入口。
 *
 * 当前 Claude 的 Task/Web/PlanMode 仍使用基础 tool_call block；
 * 独有协议类型应在此文件声明。
 */
import type { BaseContentBlock, ToolCallContentBlock } from './base'

/**
 * 连续工具调用的折叠组——**渲染期合成的块，adapter 不产出它**。
 *
 * 所以它不在 CLAUDE_CAPABILITIES.chat.blockTypes 里：那份清单声明的是后端会通过
 * TurnEvent 发出的协议块，而这个块由 renderer 的 foldClaudeToolGroups 从相邻的
 * tool_call 现推。加进 capabilities 会让 manifest 校验去核对一个后端永远不会发的类型。
 *
 * 折叠只做展示分组，`tools` 里放的就是原来的 tool_call block 本体（同一批对象），
 * 展开后仍由 ToolCallBlockView 渲染，工具输出一个字节都不丢。
 */
export interface ClaudeToolGroupContentBlock extends BaseContentBlock {
  type: 'claude_tool_group'
  tools: ToolCallContentBlock[]
  /** 组内任一 running → running；任一失败 → failed；否则 completed。 */
  status: 'running' | 'completed' | 'failed'
}
