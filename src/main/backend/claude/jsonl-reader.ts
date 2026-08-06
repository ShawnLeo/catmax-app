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
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { logger } from '@main/service/logger'
import type { ClaudeStreamMessage } from '@shared/backend/claude-schema'
import { sharedContextTagExtractors } from '@shared/backend/context-tag-handlers'
import { extractContextTags } from '@shared/backend/context-tags'
import type { NormalizedMessage } from '@shared/backend/types'

import { claudeReplayToMessages } from './history-mapping'
import { isWarmupTranscript } from './warmup-transcript'

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
 * 反向解码：把 claude projects 目录名还原成绝对 cwd 路径。
 * `-Users-shawn-foo` → `/Users/shawn/foo`。
 *
 * 注意歧义：路径里本身含 `-` 时（如 `/Users/shawn-foo`）编码后也是 `-Users-shawn-foo`，
 * 反推无法区分。所以本函数的返回值只是"候选 cwd"——上层应该用 workspace 路径正向编码
 * 比对来精确匹配（encodeCwdToProjectDir 是单射，不存在歧义）。
 */
export function decodeProjectDirToCwd(dir: string): string {
  return dir.replace(/-/g, '/')
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

/**
 * claude 磁盘会话扫描结果——比 SessionSummary 多了 cwd 和 sizeBytes。
 * 与 SessionSummary 的 cwd?/sizeBytes? 可选字段对齐，可作为它的超集使用。
 */
export interface ClaudeSessionOnDisk {
  backendThreadId: string
  title: string | null
  lastActiveAt: number
  model: string | null
  /** 反推的 cwd（项目目录名 decode 回来，可能歧义，上层用 workspace 正向匹配兜底） */
  cwd: string
  /** jsonl 文件大小（字节） */
  sizeBytes: number
}

/** 首条用户消息派生标题的长度上限——与 session.create 的 initialPrompt.slice(0, 50) 对齐 */
const DERIVED_TITLE_MAX_LENGTH = 50

/**
 * Session Title Fallback: 从一条 user 消息的 content 派生会话标题。
 *
 * 只有 claude CLI 自己会往 jsonl 里写 `ai-title` 行；catmax 经 SDK 跑出来的会话
 * 整个文件都没有那一行，于是 listSessions 的 title 一直是 null，reconcile 原样
 * 插入 db，侧边栏就只剩 "(新会话)"。这里用首条真实用户输入兜底。
 *
 * 返回 null 表示"这条不是用户说的话"，调用方应继续往下找：
 * - tool_result 回填（数组里混了 tool_result）
 * - claude 自动注入的信封（local-command-caveat / stdout、后台任务通知、compact 摘要）
 *
 * slash command 调用在 jsonl 里是 `<command-message>` + `<command-name>` sentinel，
 * 直接取命令名（"/init"）——与 history-mapping 展示给用户的形态一致。
 */
function deriveTitleFromUserContent(content: unknown): string | null {
  let raw: string | null = null
  if (typeof content === 'string') {
    raw = content
  } else if (Array.isArray(content)) {
    for (const block of content as Array<{ type?: string; text?: string }>) {
      // 工具回填不是用户输入——整条跳过，别把工具输出当成标题
      if (block?.type === 'tool_result') return null
      if (block?.type === 'text' && typeof block.text === 'string') {
        raw = block.text
        break
      }
    }
  }
  if (!raw) return null

  // slash command 调用 sentinel → 只取命令名
  if (raw.includes('<command-message>')) {
    const name = raw.match(/<command-name>([^<]+)<\/command-name>/)?.[1]
    return name ? name.trim() : null
  }
  // claude 自动注入的信封，不是用户说的话
  if (raw.includes('<local-command-caveat>')) return null
  if (raw.includes('<local-command-stdout>')) return null
  if (raw.includes('<task-notification>')) return null
  if (raw.startsWith('This session is being continued from a previous conversation')) return null

  // 剥掉 IDE 注入的 context tag（<ide_selection> / <ide_opened_file> / <environment_context>）
  // 和 <system-reminder>——它们排在用户输入前面时会整段占满 50 字符的标题
  const { text } = extractContextTags(raw, sharedContextTagExtractors)
  const cleaned = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return null
  return cleaned.slice(0, DERIVED_TITLE_MAX_LENGTH)
}

/**
 * 流式扫 jsonl 文件，同时拿 aiTitle、首条用户消息派生的兜底标题和 model。
 *
 * 为什么不用 readFileSync 头部 4KB：
 * - claude 通常先写 queue-operation / user message / 大体积 attachment（嵌入文件全文），
 *   再写 ai-title——实测 76/90 的会话 ai-title 偏移 > 4KB，中位 26KB，最大 284KB，
 *   4KB 截断会漏掉 99% 的 title（曾导致扫描导入 UI 看不到标题）。
 * - readFileSync 没有 length 参数，本来就是全量读，4KB 截断只省搜索不省 I/O，
 *   且 title/model 各读一遍又把 I/O 翻倍。
 *
 * 现在用 createReadStream + readline，遇到第一个 ai-title 和 assistant.model 就记下，
 * 两个都拿到 early break——大文件不全读，且只读一遍同时拿两个字段。
 *
 * 兜底标题不参与 break 条件：ai-title 优先，而它排在用户消息后面，提前停就永远
 * 拿不到真标题了。没有 ai-title 的文件本来就会被扫到底（break 要求 title && model），
 * 所以顺带解析首条用户消息不增加 I/O。
 *
 * 容错：读半行 / parse 失败 / 文件不可读 都返回 null，不抛。
 */
async function readTitleAndModel(
  filePath: string,
): Promise<{ title: string | null; model: string | null }> {
  let aiTitle: string | null = null
  let derivedTitle: string | null = null
  let model: string | null = null
  try {
    const stream = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    })
    for await (const rawLine of stream) {
      const line = rawLine.trim()
      if (!line) continue
      // JSON.parse 每行有成本——先粗筛，行里没有 "type" 字段的一律跳过
      // （queue-operation/user/assistant/ai-title 等都有 "type"）
      if (!line.includes('"type"')) continue
      try {
        const obj = JSON.parse(line) as {
          type?: string
          aiTitle?: string
          isMeta?: boolean
          message?: { model?: string; content?: unknown }
        }
        if (!aiTitle && obj.type === 'ai-title' && obj.aiTitle) {
          aiTitle = obj.aiTitle
        }
        if (!model && obj.type === 'assistant' && obj.message?.model) {
          model = obj.message.model
        }
        // isMeta 是 claude 替用户塞进去的展开内容（如 /init 的完整 prompt），不是用户输入
        if (!derivedTitle && obj.type === 'user' && !obj.isMeta) {
          derivedTitle = deriveTitleFromUserContent(obj.message?.content)
        }
        // ai-title + model 都拿到就停——后面几十万行不读了
        if (aiTitle && model) break
      } catch {
        // 半行 / 损坏行——继续扫下一行
      }
    }
  } catch {
    // 文件不可读——返回 null/null
  }
  return { title: aiTitle ?? derivedTitle, model }
}

/**
 * 扫磁盘枚举 claude 会话。
 *
 * - 传 cwd：只扫 encodeCwdToProjectDir(cwd) 对应子目录
 * - 不传 cwd：扫所有 ~/.claude/projects/* 子目录（全盘扫描，给「扫描导入」功能用）
 *
 * 跳过：非 `.jsonl` 文件、隐藏文件、stat 失败的文件。
 * title/model 用流式读——遇到首个 ai-title / assistant.model 就记下，两个都
 * 拿到 early break（见 readTitleAndModel 为什么不全量读）。
 * lastActiveAt 用文件 mtime（毫秒）。
 *
 * 单个文件出错不影响整个扫描——只跳过该文件。
 */
export async function listClaudeSessionsFromDisk(cwd?: string): Promise<ClaudeSessionOnDisk[]> {
  const results: ClaudeSessionOnDisk[] = []
  let warmupSkipped = 0
  for (const { filePath, sessionId, decodedCwd, mtimeMs, size } of iterateJsonlFiles(cwd)) {
    try {
      // Warmup Transcript: 预热残留不是用户会话，扫描层直接跳过。
      // 放在这里而不是只靠启动清理：清理删的是磁盘文件，而预热**正在进行中**时
      // 文件也在磁盘上，不跳过的话侧边栏会闪出一条 "Session warmup" 又消失。
      if (await isWarmupTranscript(filePath)) {
        warmupSkipped++
        continue
      }
      const { title, model } = await readTitleAndModel(filePath)
      results.push({
        backendThreadId: sessionId,
        cwd: decodedCwd,
        title,
        model,
        lastActiveAt: mtimeMs,
        sizeBytes: size,
      })
    } catch {
      // 单文件出错跳过
    }
  }

  log.info(
    'scan from disk',
    cwd ? `(cwd=${cwd})` : '(all projects)',
    '→',
    results.length,
    'sessions',
    warmupSkipped > 0 ? `(skipped ${warmupSkipped} warmup transcripts)` : '',
  )
  return results
}

/**
 * Warmup Transcript: 列出磁盘上残留的预热 transcript（供启动清理删除）。
 *
 * 与 listClaudeSessionsFromDisk 正好互补——那个跳过的就是这个收集的。
 */
export async function listWarmupTranscripts(
  cwd?: string,
): Promise<Array<{ sessionId: string; filePath: string }>> {
  const found: Array<{ sessionId: string; filePath: string }> = []
  for (const { filePath, sessionId } of iterateJsonlFiles(cwd)) {
    if (await isWarmupTranscript(filePath)) found.push({ sessionId, filePath })
  }
  return found
}

/** iterateJsonlFiles 吐出的单个会话文件 */
interface JsonlFileEntry {
  filePath: string
  /** 文件名去掉 .jsonl —— claude 的 session id */
  sessionId: string
  /** 该文件所属项目目录对应的 cwd（全盘模式下是反推的，可能歧义） */
  decodedCwd: string
  mtimeMs: number
  size: number
}

/**
 * 遍历 ~/.claude/projects 下的会话 jsonl 文件。
 *
 * - 传 cwd：只扫 encodeCwdToProjectDir(cwd) 对应子目录
 * - 不传 cwd：扫所有项目子目录（全盘模式，给「扫描导入」和启动清理用）
 *
 * 跳过非 .jsonl、隐藏文件、stat 失败的文件；子目录读不了就整个跳过。
 * 抽成独立 generator 是因为"扫会话"和"扫预热残留"要走完全一样的目录遍历，
 * 只有对每个文件的处理不同。
 */
function* iterateJsonlFiles(cwd?: string): Generator<JsonlFileEntry> {
  const projectsRoot = join(homedir(), '.claude', 'projects')

  type Target = { dirName: string; decodedCwd: string }
  let targets: Target[]
  if (cwd) {
    // 单目录模式——cwd 是精确的，无歧义
    targets = [{ dirName: encodeCwdToProjectDir(cwd), decodedCwd: cwd }]
  } else {
    // 全盘模式——枚举所有项目目录，cwd 是反推的（可能歧义）
    try {
      targets = readdirSync(projectsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({ dirName: e.name, decodedCwd: decodeProjectDirToCwd(e.name) }))
    } catch {
      // ~/.claude/projects 不存在（claude 从未运行过）
      log.info('projects root not found:', projectsRoot)
      return
    }
  }

  for (const { dirName, decodedCwd } of targets) {
    const dirPath = join(projectsRoot, dirName)
    let files: string[]
    try {
      files = readdirSync(dirPath)
    } catch {
      continue // 子目录读不了——跳过
    }
    for (const fileName of files) {
      if (!fileName.endsWith('.jsonl') || fileName.startsWith('.')) continue
      const filePath = join(dirPath, fileName)
      try {
        const stat = statSync(filePath)
        if (!stat.isFile()) continue
        yield {
          filePath,
          sessionId: fileName.slice(0, -'.jsonl'.length),
          decodedCwd,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        }
      } catch {
        // stat 失败——跳过这个文件
      }
    }
  }
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

/**
 * 推算子 Agent 的 jsonl 文件路径。
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/agent-<agentId>.jsonl
 *
 * claude CLI 把每个子 Agent（Task 工具调用）的完整会话写到这个文件，格式跟外层
 * session jsonl 一致（type: user/assistant，message.content 是 text/tool_use/tool_result）。
 * 调用方拿到后可以直接复用 claudeReplayToMessages 转 NormalizedMessage[]。
 *
 * 子 Agent 目录挂在**发起它的 session** 下，而调用方（工具卡片 / 后台面板）手上
 * 只有 agentId。agentId 全局唯一，所以这里扫一层 session 目录去找，而不是要求
 * 调用方一路把 sessionId 传下来。找不到时退回不带 sessionId 的老路径——早期
 * 版本用的就是那个布局。
 */
export function resolveSubagentJsonlPath(agentId: string, cwd: string): string {
  const projectDir = encodeCwdToProjectDir(cwd)
  const projectRoot = join(homedir(), '.claude', 'projects', projectDir)
  const fileName = `agent-${agentId}.jsonl`
  try {
    for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(projectRoot, entry.name, 'subagents', fileName)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // 项目目录不存在（该 cwd 还没跑过 claude）——落到下面的兜底路径，由调用方处理"文件不存在"
  }
  return join(projectRoot, 'subagents', fileName)
}

/**
 * 读子 Agent 的 jsonl 历史 -> NormalizedMessage[]。
 *
 * 用于 TaskCard 展开时拉取子 Agent 的完整会话过程（Read/Edit/Bash/文本等），
 * 把子 Agent 从黑盒变成可回放。复用 readClaudeSessionJsonl 的解析逻辑（格式相同）。
 *
 * 文件不存在或解析失败时返回空数组（不抛），UI 显示"子 Agent 过程不可用"。
 */
export async function readSubagentHistory(
  agentId: string,
  cwd: string,
): Promise<NormalizedMessage[]> {
  const filePath = resolveSubagentJsonlPath(agentId, cwd)
  if (!existsSync(filePath)) {
    log.warn('subagent jsonl not found:', filePath)
    return []
  }
  // 复用 readClaudeSessionJsonl 的流式读取 + normalize 逻辑--
  // 把 sessionId 参数当占位（函数内部只用它拼路径，subagent 路径不同，绕过 sessionId）。
  // 直接 inline 读取逻辑避免改 readClaudeSessionJsonl 签名影响其他调用方。
  const messages: ClaudeStreamMessage[] = []
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
      continue
    }
    if (obj.type === 'assistant' && obj.message) {
      messages.push(obj as unknown as ClaudeStreamMessage)
      continue
    }
    if (obj.type === 'user' && obj.message) {
      obj.message.content = normalizeUserContent(obj.message.content)
      messages.push(obj as unknown as ClaudeStreamMessage)
      continue
    }
  }
  log.info('subagent jsonl parsed', filePath, messages.length, 'msgs')
  return claudeReplayToMessages(messages)
}
