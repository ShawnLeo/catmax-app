import type {
  CompactDividerContentBlock,
  ContextContentBlock,
  ReasoningContentBlock,
  TextContentBlock,
  ToolCallContentBlock,
} from './base'
import type {
  CodexActivityContentBlock,
  CodexGeneratedImageContentBlock,
  CodexUserInputContentBlock,
  PlanContentBlock,
} from './codex'

export * from './base'
export * from './claude'
export * from './codex'

/** Backend packages extend this interface through TypeScript module augmentation. */
export interface ContentBlockMap {
  text: TextContentBlock
  reasoning: ReasoningContentBlock
  tool_call: ToolCallContentBlock
  context: ContextContentBlock
  compact_divider: CompactDividerContentBlock
  plan: PlanContentBlock
  codex_user_input: CodexUserInputContentBlock
  codex_generated_image: CodexGeneratedImageContentBlock
  codex_activity: CodexActivityContentBlock
}

export type BlockType = keyof ContentBlockMap
export type ContentBlock = ContentBlockMap[BlockType]
