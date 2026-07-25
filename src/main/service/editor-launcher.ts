/**
 * 编辑器启动器 —— 5 个 IDE 的命令行启动。
 *
 * 每个 IDE 一个 launch 函数，统一签名：
 *   (workspacePath, relativePath, line?, column?) => Promise<{ launched, error? }>
 *
 * 启动用 child_process.spawn（detached，不阻塞、不等待退出）。
 * 找不到命令时不抛错，返回 launched: false + error 信息。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { EditorId } from '@shared/constants'

import { logger } from './logger'

const log = logger.domain('editor-launcher')

export interface LaunchOptions {
  workspacePath: string
  relativePath: string
  /** 工作区外文件的绝对路径；存在时优先使用，不走 workspacePath + relativePath 拼接。 */
  absolutePath?: string
  line?: number
  column?: number
}

export interface LaunchResult {
  launched: boolean
  editor: EditorId
  error?: string
}

const EDITOR_COMMANDS: Record<EditorId, string[]> = {
  vscode: ['code'],
  cursor: ['cursor'],
  intellij: ['idea'],
  webstorm: ['webstorm'],
  sublime: ['subl'],
}

const EDITOR_NAMES: Record<EditorId, string> = {
  vscode: 'VS Code',
  cursor: 'Cursor',
  intellij: 'IntelliJ IDEA',
  webstorm: 'WebStorm',
  sublime: 'Sublime Text',
}

/** 启动指定编辑器打开文件 */
export async function launchInEditor(editor: EditorId, opts: LaunchOptions): Promise<LaunchResult> {
  // 工作区外文件优先用 absolutePath；否则按工作区相对路径拼接。
  const absPath = opts.absolutePath ?? join(opts.workspacePath, opts.relativePath)
  if (!existsSync(absPath)) {
    return { launched: false, editor, error: `file does not exist: ${absPath}` }
  }

  const commands = EDITOR_COMMANDS[editor]
  if (!commands) {
    return { launched: false, editor, error: `unknown editor: ${editor}` }
  }

  // 构造命令行参数：file:line:column 或 file
  const positionSuffix =
    opts.line !== undefined
      ? opts.column !== undefined
        ? `:${opts.line}:${opts.column}`
        : `:${opts.line}`
      : ''
  const fileArg = `${absPath}${positionSuffix}`

  // 大多数编辑器接受 file:line:column 格式
  // IntelliJ/WebStorm 用 <line> <file> 格式
  let args: string[]
  switch (editor) {
    case 'intellij':
    case 'webstorm':
      args = opts.line !== undefined ? [`${opts.line}`, absPath] : [absPath]
      break
    case 'vscode':
    case 'cursor':
    case 'sublime':
    default:
      args = [fileArg]
      break
  }

  return new Promise((resolve) => {
    try {
      const child = spawn(commands[0]!, args, {
        detached: true,
        stdio: 'ignore',
        cwd: opts.workspacePath,
      })
      child.on('error', (err) => {
        const message =
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? `${EDITOR_NAMES[editor]} CLI 命令 '${commands[0]}' 未找到。请确认已安装且在 PATH 中。`
            : `启动失败: ${err.message}`
        log.warn('editor launch error:', message)
        resolve({ launched: false, editor, error: message })
      })
      child.on('spawn', () => {
        log.info('launched', editor, absPath)
        // 立即 resolve（不等退出）
        resolve({ launched: true, editor })
        child.unref()
      })
    } catch (e) {
      resolve({ launched: false, editor, error: String(e) })
    }
  })
}

/** 检测编辑器是否可用（命令在 PATH 中） */
export async function isEditorAvailable(editor: EditorId): Promise<boolean> {
  return new Promise((resolve) => {
    const cmd = EDITOR_COMMANDS[editor]
    if (!cmd) {
      resolve(false)
      return
    }
    try {
      const child = spawn('which', [cmd[0]!], { stdio: ['ignore', 'pipe', 'ignore'] })
      let output = ''
      child.stdout?.on('data', (chunk) => {
        output += chunk.toString()
      })
      child.on('close', (code) => {
        resolve(code === 0 && output.trim().length > 0)
      })
      child.on('error', () => resolve(false))
    } catch {
      resolve(false)
    }
  })
}
