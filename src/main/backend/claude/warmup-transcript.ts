/**
 * Warmup Transcript: 识别 claude 缓存预热留下的 transcript 文件。
 *
 * 预热（见 ClaudeAdapter.runWarmup）会用一个独立 sessionId 跑一次最小 query 来
 * 提前写入 prompt cache，正常结束时在 finally 里把 transcript 删掉。但 finally
 * 只在进程还活着时才跑——应用被强杀（SIGKILL / 强制退出 / 崩溃）时预热的 jsonl
 * 就留在了 ~/.claude/projects/ 里，之后被 listClaudeSessionsFromDisk 扫成一条
 * 名叫 "Session warmup" 的历史会话混进侧边栏。
 *
 * 这个模块只提供"这份 transcript 是不是预热产物"的判据，供两处使用：
 *   - 扫描时跳过（列表里永远不出现，对已残留的文件同样生效）
 *   - 启动时清理（把残留文件真正删掉）
 *
 * 单独成文件是为了断开依赖环：adapter 要用 WARMUP_PROMPT 发起预热，jsonl-reader
 * 要用它做识别，而 adapter 本身 import jsonl-reader——常量放任何一边都会成环。
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

/**
 * 预热 prompt 里的自标记——识别的**首选**依据。
 *
 * 有它就不用拿整句 prompt 做字面匹配：措辞可以随便改，识别不会跟着失效。
 * 早期版本的 catmax 就是这么做的，中途改 prompt 时把标记弄丢了，结果磁盘上留下
 * 一份 "Readiness check warmup" 谁也认不出来——这个常量是把那个设计捡回来。
 *
 * 版本号别动：改了等于又造一批认不出的残留，除非同时把旧值加进
 * LEGACY_WARMUP_PROMPT_MARKERS。
 */
export const WARMUP_MARKER = '<!-- catmax:warmup:v1 -->'

/** 预热用的固定 prompt。首行的标记是给 isWarmupTranscript 认的，模型会忽略它。 */
export const WARMUP_PROMPT = `${WARMUP_MARKER}\nWarmup. Reply with exactly "ready" and do not use any tools.`

/**
 * 认得出但已经不再发送的历史预热 prompt——纯粹为了清理老残留。
 *
 * 这一代（标记丢失的那个版本）只能靠整句字面匹配，所以必须一字不差地抄在这里。
 * 带标记的那些代不需要登记，标记本身就认得出来。
 */
const LEGACY_WARMUP_PROMPTS = ['Warmup. Reply with exactly "ready" and do not use any tools.']

/** 一段 user 文本是不是预热 prompt（当前的或历史的） */
function isWarmupPrompt(text: string): boolean {
  return text.includes(WARMUP_MARKER) || LEGACY_WARMUP_PROMPTS.includes(text.trim())
}

/** 判据只看开头几行，预热 transcript 的首条 user 消息就在第 3 行左右 */
const MAX_LINES_TO_INSPECT = 20

/**
 * 判断一份 transcript 是不是预热产物。
 *
 * 判据：**第一条** user 消息带 WARMUP_MARKER，或整段等于某个历史预热 prompt。
 *
 * 为什么不用 ai-title（残留文件里是 "Session warmup" / "Readiness check warmup"）：
 * 那是模型生成的，换模型或换语言就变；标记则是我们自己写进去的。
 *
 * 为什么限定"第一条"：预热只有一轮对话，真实会话即便中间出现同样的文本也不会误伤
 * （讨论预热机制时把那句 prompt 贴进对话，是真会发生的事）。
 * 读不了 / 解析失败一律返回 false——宁可漏掉一个残留文件，也不能误删用户的会话。
 */
export async function isWarmupTranscript(filePath: string): Promise<boolean> {
  try {
    const stream = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    })
    let inspected = 0
    try {
      for await (const rawLine of stream) {
        const line = rawLine.trim()
        if (!line) continue
        if (++inspected > MAX_LINES_TO_INSPECT) return false
        if (!line.includes('"user"')) continue
        let parsed: { type?: string; message?: { content?: unknown } }
        try {
          parsed = JSON.parse(line) as typeof parsed
        } catch {
          continue // 半行 / 损坏行
        }
        if (parsed.type !== 'user') continue
        // 第一条 user 消息就是判据——不管它是不是预热，都不再往后看
        const text = extractUserText(parsed.message?.content)
        return text !== null && isWarmupPrompt(text)
      }
    } finally {
      stream.close()
    }
  } catch {
    // 文件不可读——当作普通会话，不删不跳
  }
  return false
}

/**
 * 取 user 消息的纯文本。
 *
 * jsonl 里 content 可能是 string，也可能是 [{type:'text',text}, ...] 数组
 * （见 jsonl-reader 顶部对这个格式差异的说明）。预热发的是单段纯文本，
 * 所以数组形态只认"恰好一个 text block"，多段的一律不算预热。
 */
function extractUserText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || content.length !== 1) return null
  const block = content[0] as { type?: string; text?: unknown }
  if (block?.type !== 'text' || typeof block.text !== 'string') return null
  return block.text
}
