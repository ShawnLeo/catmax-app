/**
 * codex thread/read 返回的 turn/items → NormalizedMessage[]
 *
 * codex 的历史结构：
 *   thread.turns: Turn[]
 *     turn.items: Item[]（userMessage / agentMessage / command_execution / file_change / ...）
 *
 * 转换规则：
 *   - userMessage / user_message → role: 'user', textBlocks
 *   - agentMessage / agent_message → role: 'assistant', textBlocks
 *   - command_execution / file_change / mcp_tool_call → 单独的 role: 'tool' message（之后由
 *     mergeAssistantAndToolMessages 合并到上一个 assistant 的 toolBlocks）
 *   - reasoning → 归到上一个 assistant message 的 textBlocks（kind: 'reasoning'）
 *
 * 协议变化：
 *   - codex 0.93+ 把 item.type 从 snake_case（user_message）改成 camelCase（userMessage）
 *   - catmax 内部 schema 还是 snake_case。这里在解析时做归一化——两种命名都识别，
 *     统一成 snake_case 后再 switch。
 *
 * 注意：codexItemSchema 是 z.union 带 passthrough 兜底分支，switch(item.type) 不会收窄
 * item 字段，访问具体字段时需要 Extract + as cast（与 mapping.ts 一致）。
 */
import { randomUUID } from 'node:crypto'

import type { CodexActivityContentBlock, CodexUserInputContentBlock } from '@shared/backend/blocks'
import { contextBlocks as createContextBlocks } from '@shared/backend/blocks'
import { sharedContextTagExtractors } from '@shared/backend/context-tag-handlers'
import { extractContextTags } from '@shared/backend/context-tags'
import type { CodexItem } from '@shared/backend/schema'
import type { NormalizedMessage, ToolOutput } from '@shared/backend/types'

import {
  codexCommandToOutput,
  codexFileChangeToOutput,
  codexItemToActivityBlock,
  codexItemToContentBlock,
  codexItemToToolCallInfo,
} from './mapping'

// 显式 Extract 各变体（z.union 不收窄 item.type）
type CommandExecutionItem = Extract<CodexItem, { type: 'command_execution' }>
type FileChangeItem = Extract<CodexItem, { type: 'file_change' }>
type UserMessageItem = Extract<CodexItem, { type: 'user_message' }>
type AgentMessageItem = Extract<CodexItem, { type: 'agent_message' }>
type ReasoningItem = Extract<CodexItem, { type: 'reasoning' }>

/**
 * 把 codex 0.93+ 的 camelCase type 名归一化回 snake_case（catmax 内部用）。
 * - userMessage   → user_message
 * - agentMessage  → agent_message
 * - fileChange    → file_change
 * - commandExecution → command_execution
 * - mcpToolCall   → mcp_tool_call
 * - 其他原样返回
 */
function normalizeItemType(type: string): string {
  const camelMap: Record<string, string> = {
    userMessage: 'user_message',
    agentMessage: 'agent_message',
    fileChange: 'file_change',
    commandExecution: 'command_execution',
    mcpToolCall: 'mcp_tool_call',
  }
  return camelMap[type] ?? type
}

/** 从 thread.read 响应提取 turn 数组 */
export function extractTurns(readResult: unknown): unknown[] {
  const thread = (readResult as { thread?: { turns?: unknown[] } }).thread
  return thread?.turns ?? []
}

/** 从 turn 提取 items（用 codexItemSchema 校验每个 item；不合法的跳过） */
export function extractItems(turn: unknown): CodexItem[] {
  const items = (turn as { items?: unknown[] }).items ?? []
  return items.filter((item): item is CodexItem => {
    return typeof item === 'object' && item !== null && 'type' in item && 'id' in item
  })
}

/** 把多个 turn 的 items 展平 + 转成 NormalizedMessage[] */
export function codexTurnsToMessages(turns: unknown[]): NormalizedMessage[] {
  const messages: NormalizedMessage[] = []
  let currentAssistant: NormalizedMessage | null = null

  for (const turn of turns) {
    const turnId = (turn as { id?: string })?.id ?? randomUUID()
    const turnDurationMs = extractTurnDurationMs(turn)
    const items = extractItems(turn)
    let durationAssigned = false

    for (const item of items) {
      const isReasoning = normalizeItemType(item.type as string) === 'reasoning'
      const reasoningDurationMs = isReasoning && !durationAssigned ? turnDurationMs : undefined
      if (reasoningDurationMs !== undefined) durationAssigned = true
      const msg = mapItemToMessage(item, turnId, reasoningDurationMs)
      if (!msg) continue

      if (msg.role === 'assistant') {
        // 新 assistant message：先 flush 之前的 assistant
        if (currentAssistant) messages.push(currentAssistant)
        currentAssistant = msg
      } else if (msg.role === 'user') {
        // user message：先 flush 之前的 assistant
        if (currentAssistant) {
          messages.push(currentAssistant)
          currentAssistant = null
        }
        messages.push(msg)
      } else if (msg.role === 'tool') {
        // tool message：先 flush 当前的 assistant（不合并到它，后续 mergeAssistantAndToolMessages 处理）
        if (currentAssistant) {
          messages.push(currentAssistant)
          currentAssistant = null
        }
        messages.push(msg)
      }
    }
  }
  // flush 最后一个
  if (currentAssistant) messages.push(currentAssistant)

  return messages
}

/** 单个 codex item → NormalizedMessage（或 null 跳过） */
function mapItemToMessage(
  item: CodexItem,
  turnId: string,
  turnDurationMs?: number,
): NormalizedMessage | null {
  const itemId = item.id
  // codex 0.93+ 把 type 改成了 camelCase，这里先归一化成 snake_case 走 switch
  const itemType = normalizeItemType(item.type as string)

  switch (itemType) {
    case 'user_message': {
      const content = (item as unknown as UserMessageItem).content
      const userContent = extractCodexUserContent(content, itemId)
      // 提取 context tag（codex 注入的 <environment_context> 等）
      const { text, blocks: contextTags } = extractContextTags(
        userContent.text,
        sharedContextTagExtractors,
      )
      if (!text && contextTags.length === 0 && userContent.blocks.length === 0) return null
      const blocks = [
        ...createContextBlocks(contextTags, itemId),
        ...userContent.blocks,
        ...(text ? [{ id: `${itemId}-text`, type: 'text' as const, text }] : []),
      ]
      return {
        id: itemId,
        role: 'user',
        turnId,
        blocks,
        textBlocks: text ? [{ id: `${itemId}-text`, text, kind: 'text' }] : [],
        ...(contextTags.length > 0 ? { contextBlocks: contextTags } : {}),
        createdAt: 0, // codex 不在 item 里返回 createdAt，UI 用 turns 的时间
      }
    }
    case 'agent_message': {
      const agentMessage = item as unknown as AgentMessageItem & {
        phase?: 'commentary' | 'final_answer' | null
      }
      const text = agentMessage.text ?? ''
      const phase = agentMessage.phase ?? undefined
      return {
        id: itemId,
        role: 'assistant',
        turnId,
        blocks: text
          ? [{ id: `${itemId}-text`, type: 'text', text, ...(phase ? { phase } : {}) }]
          : [],
        textBlocks: text ? [{ id: `${itemId}-text`, text, kind: 'text' }] : [],
        toolBlocks: [],
        createdAt: 0,
      }
    }
    case 'reasoning': {
      // reasoning 不单独成 message，会被合并到上一个 assistant 的 textBlocks（kind: reasoning）
      // 这里返回一个 assistant message，让 codexTurnsToMessages 当作 assistant 处理
      // —— 若 reasoning 单独出现（前面没有 assistant），就会作为一个 assistant 入列
      const summary = extractReasoningSummary((item as unknown as ReasoningItem).summary)
      return {
        id: itemId,
        role: 'assistant',
        turnId,
        blocks: summary
          ? [
              {
                id: `${itemId}-reasoning`,
                type: 'reasoning',
                text: summary,
                completedLabel: '已处理',
                defaultCollapsed: true,
                ...(turnDurationMs !== undefined ? { durationMs: turnDurationMs } : {}),
              },
            ]
          : [],
        textBlocks: summary
          ? [{ id: `${itemId}-reasoning`, text: summary, kind: 'reasoning' }]
          : [],
        toolBlocks: [],
        createdAt: 0,
      }
    }
    case 'command_execution':
    case 'file_change':
    case 'mcp_tool_call': {
      const activityBlock = codexItemToActivityBlock(item, { defaultCollapsed: true })
      if (activityBlock) {
        return {
          id: itemId,
          role: 'tool',
          turnId,
          blocks: [activityBlock],
          textBlocks: [],
          toolBlocks: [],
          createdAt: 0,
        }
      }
      // 单独成 role: 'tool' message（之后合并到上一个 assistant 的 toolBlocks）
      const toolInfo = codexItemToToolCallInfo(item)
      if (!toolInfo) return null
      let output: ToolOutput | undefined
      if (itemType === 'command_execution') {
        output = codexCommandToOutput(item as unknown as CommandExecutionItem)
      } else if (itemType === 'file_change') {
        output = codexFileChangeToOutput(item as unknown as FileChangeItem)
      }
      return {
        id: itemId,
        role: 'tool',
        turnId,
        textBlocks: [],
        toolBlocks: [
          {
            id: itemId,
            info: toolInfo,
            status: output?.ok === false ? 'failed' : 'completed',
            ...(output !== undefined ? { output } : {}),
          },
        ],
        createdAt: 0,
      }
    }
    default: {
      const block =
        codexItemToActivityBlock(item, { defaultCollapsed: true }) ?? codexItemToContentBlock(item)
      if (!block) return null
      return {
        id: itemId,
        role: 'assistant',
        turnId,
        blocks: [block],
        textBlocks: [],
        toolBlocks: [],
        createdAt: 0,
      }
    }
  }
}

interface PendingImageMarker {
  name?: string
  path?: string
}

interface LegacyUserEnvelope {
  prompt: string
  attachments: Array<{ name?: string; path: string }>
}

const IMAGE_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'gif',
  'heic',
  'heif',
  'ico',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'webp',
])

/**
 * App Server UserInput → ordered CatMax blocks.
 *
 * Codex Desktop 的 rollout 还会把附件清单包进首个 text input，并在 image 前后插入
 * `<image ...>` 标记。这里一次性消化这些兼容形态，绝不把协议包装泄漏给 renderer。
 */
export function extractCodexUserContent(
  content: unknown,
  idPrefix = 'codex-user',
): { text: string; blocks: CodexUserInputContentBlock[] } {
  const inputs = Array.isArray(content) ? content : [content]
  const textParts: string[] = []
  const blocks: CodexUserInputContentBlock[] = []
  let pendingImage: PendingImageMarker | undefined

  const addInput = (
    input: Omit<CodexUserInputContentBlock, 'id' | 'type'>,
  ): CodexUserInputContentBlock => {
    const existing =
      (input.path ? blocks.find((block) => block.path === input.path) : undefined) ??
      (input.url ? blocks.find((block) => block.url === input.url) : undefined)
    if (existing) {
      Object.assign(existing, input)
      return existing
    }
    const block: CodexUserInputContentBlock = {
      id: `${idPrefix}-input-${blocks.length}`,
      type: 'codex_user_input',
      ...input,
    }
    blocks.push(block)
    return block
  }

  const addText = (value: string): void => {
    const imageMarker = parseImageMarker(value)
    if (imageMarker) {
      pendingImage = imageMarker
      if (imageMarker.path) {
        addInput({
          kind: isImageReference(imageMarker.path) ? 'image' : 'file',
          ...imageMarker,
        })
      }
      return
    }
    if (/^\s*<\/image>\s*$/.test(value)) {
      pendingImage = undefined
      return
    }

    const envelope = parseLegacyUserEnvelope(value)
    if (envelope) {
      for (const attachment of envelope.attachments) {
        addInput({
          kind: isImageReference(attachment.path) ? 'image' : 'file',
          ...attachment,
        })
      }
      if (envelope.prompt) textParts.push(envelope.prompt)
      return
    }
    if (value.trim()) textParts.push(value)
  }

  for (const input of inputs) {
    if (typeof input === 'string') {
      addText(input)
      continue
    }
    if (typeof input !== 'object' || input === null) continue

    const value = input as Record<string, unknown>
    const type = typeof value.type === 'string' ? value.type : ''
    if ((type === 'text' || type === 'input_text' || !type) && typeof value.text === 'string') {
      addText(value.text)
      continue
    }
    if ((type === 'image' || type === 'input_image') && pendingImage) {
      const url =
        typeof value.url === 'string'
          ? value.url
          : typeof value.image_url === 'string'
            ? value.image_url
            : undefined
      if (url) {
        addInput({
          kind: 'image',
          ...pendingImage,
          url,
          ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
        })
      }
      pendingImage = undefined
      continue
    }
    if (type === 'image' && typeof value.url === 'string') {
      addInput({
        kind: 'image',
        url: value.url,
        ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
      })
      continue
    }
    if (type === 'input_image' && typeof value.image_url === 'string') {
      addInput({
        kind: 'image',
        url: value.image_url,
        ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
      })
      continue
    }
    if (type === 'localImage' && typeof value.path === 'string') {
      addInput({
        kind: 'image',
        path: value.path,
        name: fileName(value.path),
        ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
      })
      continue
    }
    if (
      (type === 'skill' || type === 'mention') &&
      typeof value.name === 'string' &&
      typeof value.path === 'string'
    ) {
      addInput({ kind: type, name: value.name, path: value.path })
      continue
    }

    // 容忍旧桥接层只保留 text/image_url 而没有准确 type。
    if (typeof value.text === 'string') {
      addText(value.text)
    } else if (typeof value.image_url === 'string') {
      addInput({ kind: 'image', url: value.image_url })
    }
  }

  return {
    text: textParts.join('\n').trim(),
    blocks,
  }
}

function parseImageMarker(value: string): PendingImageMarker | null {
  const match = value
    .trim()
    .match(/^<image\s+name=\[([^\]]+)\]\s+path=(?:"([^"]+)"|'([^']+)')\s*>$/)
  if (!match) return null
  return {
    ...(match[1] ? { name: match[1] } : {}),
    ...(match[2] || match[3] ? { path: match[2] ?? match[3] } : {}),
  }
}

/**
 * 只识别 Codex Desktop 自己生成的完整双标记 envelope，避免误删普通 Markdown。
 * 支持 `## name: /path` 与 path 位于下一行两种历史形态。
 */
function parseLegacyUserEnvelope(value: string): LegacyUserEnvelope | null {
  const normalized = value.replace(/\r\n/g, '\n')
  const header = normalized.match(/^\s*# Files mentioned by the user:\s*$/m)
  const request = normalized.match(/^## My request for Codex:\s*$/m)
  if (!header || header.index === undefined || !request || request.index === undefined) return null
  if (normalized.slice(0, header.index).trim()) return null
  if (request.index <= header.index) return null

  const attachmentSection = normalized.slice(header.index + header[0].length, request.index)
  const lines = attachmentSection.split('\n')
  const attachments: LegacyUserEnvelope['attachments'] = []
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]!.match(/^##\s+(.+?):(?:\s+(.*))?$/)
    if (!match) continue
    let path = match[2]?.trim()
    if (!path) {
      const next = lines.slice(index + 1).find((line) => line.trim())
      if (next && !next.trim().startsWith('#') && !next.trim().startsWith('<')) {
        path = next.trim()
      }
    }
    if (!path) continue
    attachments.push({ ...(match[1] ? { name: match[1].trim() } : {}), path })
  }

  return {
    attachments,
    prompt: normalized.slice(request.index + request[0].length).trim(),
  }
}

function isImageReference(reference: string): boolean {
  if (reference.startsWith('data:image/')) return true
  const clean = reference.split(/[?#]/, 1)[0]!
  const extension = clean.includes('.') ? clean.slice(clean.lastIndexOf('.') + 1).toLowerCase() : ''
  return IMAGE_EXTENSIONS.has(extension)
}

function fileName(reference: string): string {
  const clean = reference.replace(/[/\\]+$/, '')
  return clean.slice(Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')) + 1) || reference
}

function extractReasoningSummary(summary: unknown): string {
  if (typeof summary === 'string') return summary
  if (!Array.isArray(summary)) return ''
  return summary
    .map((s) => {
      if (typeof s === 'string') return s
      if (typeof s === 'object' && s !== null && 'text' in s) {
        return String((s as { text: unknown }).text)
      }
      return ''
    })
    .join('\n')
    .trim()
}

/**
 * 合并相邻的 assistant + tool 消息（让 tool_blocks 归属 assistant message）。
 * codex 历史里 assistant message 之后通常跟着 command_execution/file_change，
 * 让它们在 UI 上以 assistant message 的 tool 卡片展示。
 */
export function mergeAssistantAndToolMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  const result: NormalizedMessage[] = []
  for (const msg of messages) {
    if (msg.role === 'tool') {
      const last = result[result.length - 1]!
      if (last?.role === 'assistant' && last.turnId === msg.turnId) {
        // 合并到上一个 assistant
        if (!last.toolBlocks) last.toolBlocks = []
        last.toolBlocks.push(...(msg.toolBlocks ?? []))
        mergeCodexActivityBlocks(last, msg)
        continue
      }
      if ((msg.blocks ?? []).some((block) => block.type === 'codex_activity')) {
        result.push({ ...msg, role: 'assistant' })
        continue
      }
    }
    result.push(msg)
  }
  return result
}

function mergeCodexActivityBlocks(target: NormalizedMessage, source: NormalizedMessage): void {
  const incoming = (source.blocks ?? []).filter(
    (block): block is CodexActivityContentBlock => block.type === 'codex_activity',
  )
  if (incoming.length === 0) return
  if (!target.blocks) target.blocks = []

  for (const block of incoming) {
    const last = target.blocks[target.blocks.length - 1]
    if (last?.type === 'codex_activity') {
      last.activities.push(...block.activities)
      last.status =
        last.status === 'failed' || block.status === 'failed'
          ? 'failed'
          : last.status === 'running' || block.status === 'running'
            ? 'running'
            : 'completed'
      last.durationMs = (last.durationMs ?? 0) + (block.durationMs ?? 0)
    } else {
      target.blocks.push(block)
    }
  }
}

function extractTurnDurationMs(turn: unknown): number | undefined {
  if (typeof turn !== 'object' || turn === null) return undefined
  const raw = turn as { durationMs?: unknown; startedAt?: unknown; completedAt?: unknown }
  if (typeof raw.durationMs === 'number') return raw.durationMs
  if (typeof raw.startedAt === 'number' && typeof raw.completedAt === 'number') {
    return Math.max(0, (raw.completedAt - raw.startedAt) * 1000)
  }
  return undefined
}
