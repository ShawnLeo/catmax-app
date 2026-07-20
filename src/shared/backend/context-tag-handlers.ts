/**
 * 内置 context tag 的提取逻辑（纯函数版，不带 Vue component）。
 *
 * 双层用法：
 * - main 进程（history-mapping）：直接用本文件导出的 sharedExtractors
 * - renderer 进程：用 context-tag-handlers.ts（在 shared 版基础上 register component）
 *
 * 提取逻辑必须放这里（shared 层）——renderer 和 main 都能 import。
 * component 字段只在 renderer 注册时加。
 */
import type {
  ContextTagExtractor,
  ContextTagMatch,
  EnvironmentContextData,
  IdeOpenedFileData,
  IdeSelectionData,
} from './context-tag-types'

// ============ ide_selection ============
// 格式（Claude Code 注入）：
//   <ide_selection>The user selected the lines 76 to 82 from /path/file.java:
//   <代码内容>
//   This may or may not be related to the current task.</ide_selection>

const IDE_SELECTION_RE =
  /<ide_selection>The user selected the (?:lines?|line) (\d+)(?:\s+to\s+(\d+))? from (.+?):\n([\s\S]*?)\nThis may or may not be related to the current task\.<\/ide_selection>/g

function extractIdeSelection(text: string): ContextTagMatch<IdeSelectionData>[] {
  const out: ContextTagMatch<IdeSelectionData>[] = []
  IDE_SELECTION_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IDE_SELECTION_RE.exec(text)) !== null) {
    const startLine = parseInt(m[1]!, 10)
    const endLine = m[2] ? parseInt(m[2], 10) : startLine
    const filePath = m[3]!.trim()
    const code = m[4]!
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      data: { filePath, startLine, endLine, code },
    })
  }
  return out
}

// ============ ide_opened_file ============
// 格式：
//   <ide_opened_file>The user opened the file /path/file.vue in the IDE. This may or may not be related to the current task.</ide_opened_file>

const IDE_OPENED_FILE_RE =
  /<ide_opened_file>The user opened the file (.+?) in the IDE\. This may or may not be related to the current task\.<\/ide_opened_file>/g

function extractIdeOpenedFile(text: string): ContextTagMatch<IdeOpenedFileData>[] {
  const out: ContextTagMatch<IdeOpenedFileData>[] = []
  IDE_OPENED_FILE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IDE_OPENED_FILE_RE.exec(text)) !== null) {
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      data: { filePath: m[1]!.trim() },
    })
  }
  return out
}

// ============ environment_context ============
// 格式（codex 注入）：
//   <environment_context>
//     <cwd>/Users/me/project</cwd>
//     <shell>zsh</shell>
//     ...
//   </environment_context>
//
// 子元素不固定（cwd / shell / model / date / timezone 等），所以只抓 raw 文本。

const ENVIRONMENT_CONTEXT_RE = /<environment_context>([\s\S]*?)<\/environment_context>/g

function extractEnvironmentContext(text: string): ContextTagMatch<EnvironmentContextData>[] {
  const out: ContextTagMatch<EnvironmentContextData>[] = []
  ENVIRONMENT_CONTEXT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ENVIRONMENT_CONTEXT_RE.exec(text)) !== null) {
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      data: { raw: m[1]! },
    })
  }
  return out
}

// ============ 默认 extractors 集合 ============
// main 进程直接 import 这个数组用；renderer 在它基础上 register component。

export const sharedContextTagExtractors: ContextTagExtractor[] = [
  {
    tag: 'ide_selection',
    extract: extractIdeSelection,
  },
  {
    tag: 'ide_opened_file',
    extract: extractIdeOpenedFile,
  },
  {
    tag: 'environment_context',
    extract: extractEnvironmentContext,
  },
]
