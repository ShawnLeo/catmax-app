/**
 * Unified Skill Center: SKILL.md 的 YAML frontmatter 里只有两个字段是我们要的。
 *
 * 为什么手写而不是加一个 YAML 依赖：需要的就是 `name` 和 `description` 两个标量，
 * 而 frontmatter 是**第三方内容**（用户/安装器写的技能），解析失败必须退化成
 * "用目录名"而不是让整个技能列表崩掉。手写这几十行比引一个会抛异常的解析器更好控。
 *
 * 支持的写法（覆盖 codex / claude 两边现有技能的全部形态）：
 *   name: foo
 *   name: "foo"            单双引号都剥
 *   description: >-        折叠块，后续缩进行拼成一行
 *     一段很长的描述
 *   description: |         字面块，保留换行
 *     第一行
 *     第二行
 *
 * 不支持嵌套结构——frontmatter 里出现嵌套时那一项直接跳过，不猜。
 */

export interface SkillFrontmatter {
  name: string | null
  description: string | null
}

const EMPTY: SkillFrontmatter = { name: null, description: null }

/** 只认文件开头的 `---`；中间出现的 `---` 是正文里的分隔线，不是 frontmatter。 */
function extractBlock(source: string): string | null {
  // 先剥 BOM——带 BOM 的 SKILL.md 会让开头的 `---` 匹配不上，整份 frontmatter 被当成不存在。
  const text = source.replace(/^\uFEFF/, '')
  if (!/^---[ \t]*\r?\n/.test(text)) return null
  const end = /\r?\n---[ \t]*(\r?\n|$)/.exec(text.slice(3))
  if (!end) return null
  return text.slice(3, 3 + end.index)
}

function unquote(value: string): string {
  const trimmed = value.trim()
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if (trimmed.length >= 2 && (first === '"' || first === "'") && first === last) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function parseSkillFrontmatter(source: string): SkillFrontmatter {
  const block = extractBlock(source)
  if (block === null) return EMPTY

  const lines = block.split(/\r?\n/)
  const out: SkillFrontmatter = { name: null, description: null }

  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i] ?? '')
    if (!match) continue
    const key = match[1]
    if (key !== 'name' && key !== 'description') continue

    const raw = match[2] ?? ''
    const blockStyle = /^([|>])[+-]?\s*$/.exec(raw.trim())
    if (blockStyle) {
      // 块标量：吃掉后面所有缩进行。缩进量以第一条非空行为准。
      const body: string[] = []
      let indent: number | null = null
      let j = i + 1
      for (; j < lines.length; j++) {
        const line = lines[j] ?? ''
        if (line.trim() === '') {
          body.push('')
          continue
        }
        const lead = line.length - line.trimStart().length
        if (indent === null) indent = lead
        if (lead < indent || lead === 0) break
        body.push(line.slice(indent))
      }
      i = j - 1
      while (body.length > 0 && body[body.length - 1] === '') body.pop()
      const joined = blockStyle[1] === '|' ? body.join('\n') : body.join(' ').replace(/\s+/g, ' ')
      out[key] = joined.trim() || null
      continue
    }

    const value = unquote(raw)
    out[key] = value === '' ? null : value
  }

  return out
}
