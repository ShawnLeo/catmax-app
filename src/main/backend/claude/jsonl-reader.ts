/**
 * 直接读 claude 的 ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl 文件
 * 来回放会话历史。
 *
 * 为什么不用 `claude --resume <id>`：
 * - `--resume` 是用来**继续**会话的，必须提供一个 prompt 才能跑
 * - 不带 stdin 时 claude 报 "No deferred tool marker found ... Provide a prompt to
 *   continue the conversation." 直接退出，不重放任何消息
 * - 即便提供 prompt 也会消耗 token
 *
 * jsonl 文件是 claude 自己的会话持久化格式，每行一个 JSON：
 *   {"type":"queue-operation", ...}  // 用户输入排队
 *   {"type":"user","message":{"role":"user","content":"..."}}  // 用户消息
 *   {"type":"assistant","message":{"role":"assistant","content":[...]}}  // 助手消息
 *   {"type":"ai-title","aiTitle":"..."}  // AI 生成的会话标题
 *   {"type":"attachment", ...}  // 各种附加信息（agent listing 等）
 *   {"type":"last-prompt", ...}
 *
 * 注意：jsonl 里 `user.message.content` 可能是 **string**（不是 array），
 * 和 stream-json 输出格式有差异。本模块处理这个差异。
 */
import { createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { logger } from '@main/service/logger'
import type { NormalizedMessage } from '@shared/backend/types'
import type { ClaudeStreamMessage } from '@shared/backend/claude-schema'

import { claudeReplayToMessages } from './history-mapping'

const log = logger.domain('claude-jsonl')

/**
 * 把绝对 cwd 路径转换成 claude 用的 projects 目录名。
 * claude 的规则：把绝对路径里的 `/` 全部替换成 `-`。
 * 例：/Users/shawn/foo → -Users-shawn-foo
 */
export function encodeCwdToProjectDir(cwd: string): string {
  // claude 源码里就是把所有 / 换成 -，开头如果以 / 开头会自动产生前导 -
  return cwd.replace(/\//g, '-')
}

/**
 * 推算 session 的 jsonl 文件路径。
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 */
export function resolveSessionJsonlPath(sessionId: string, cwd?: string): string {
  const baseCwd = cwd ?? process.cwd()
  const projectDir = encodeCwdToProjectDir(baseCwd)
  return join(homedir(), '.claude', 'projects', projectDir, `${sessionId}.jsonl`)
}

/** jsonl 文件里一行的解析结果（claudeReplayToMessages 需要的形态） */
interface JsonlLine {
  type: string
  aiTitle?: string
  message?: {
    role?: string
    content?: unknown // 可能 string / array
  }
}

/**
 * 把 jsonl 里 user 消息的 string content 转成 array form（stream-json 兼容）。
 */
function normalizeUserContent(content: unknown): unknown {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }]
  }
  return content
}

/**
 * 读 jsonl 文件，返回 ClaudeStreamMessage[]（assistant + user 子集）+ aiTitle。
 * 文件不存在时返回 null（让调用方决定怎么处理）。
 */
export async function readClaudeSessionJsonl(
  sessionId: string,
  cwd?: string,
): Promise<{ messages: ClaudeStreamMessage[]; aiTitle: string | null } | null> {
  const filePath = resolveSessionJsonlPath(sessionId, cwd)
  if (!existsSync(filePath)) {
    log.warn('jsonl not found:', filePath)
    return null
  }

  const messages: ClaudeStreamMessage[] = []
  let aiTitle: string | null = null

  // 用 readline 流式读取（大文件友好）
  const stream = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })

  for await (const rawLine of stream) {
    const line = rawLine.trim()
    if (!line) continue
    let obj: JsonlLine
    try {
      obj = JSON.parse(line) as JsonlLine
    } catch {
      // 跳过损坏行（claude 写入中途 crash 可能产生半行）
      continue
    }

    if (obj.type === 'ai-title' && obj.aiTitle) {
      aiTitle = obj.aiTitle
      continue
    }

    if (obj.type === 'assistant' && obj.message) {
      // 直接 cast——assistant content 已经是 array，schema 兼容
      messages.push(obj as unknown as ClaudeStreamMessage)
      continue
    }

    if (obj.type === 'user' && obj.message) {
      // user content 可能是 string——转成 array form
      obj.message.content = normalizeUserContent(obj.message.content)
      messages.push(obj as unknown as ClaudeStreamMessage)
      continue
    }
    // 其他 type（queue-operation / attachment / last-prompt 等）忽略
  }

  log.info('jsonl parsed', filePath, messages.length, 'msgs, title=', aiTitle)
  return { messages, aiTitle }
}

/**
 * 高层封装：读 jsonl → 转 NormalizedMessage[]。
 * 调用方拿到的 messages 顺序：user / assistant / user / assistant ...
 */
export async function readHistoryFromJsonl(
  sessionId: string,
  cwd?: string,
): Promise<{ messages: NormalizedMessage[]; aiTitle: string | null } | null> {
  const parsed = await readClaudeSessionJsonl(sessionId, cwd)
  if (!parsed) return null
  const normalized = claudeReplayToMessages(parsed.messages)
  return { messages: normalized, aiTitle: parsed.aiTitle }
}
