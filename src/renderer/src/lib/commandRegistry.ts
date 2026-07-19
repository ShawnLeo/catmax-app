/**
 * 命令注册系统。
 *
 * 任意模块（store、view、组件）可以注册命令：
 *   commandRegistry.register({
 *     id: 'workspace.refresh',
 *     title: '刷新工作区',
 *     category: 'Workspace',
 *     keywords: ['workspace', 'refresh'],
 *     action: () => { ... },
 *   })
 *
 * CommandPalette 模糊搜索 title + keywords。
 */
import { reactive } from 'vue'

export interface Command {
  id: string
  title: string
  category?: string
  keywords?: string[]
  shortcut?: string // 显示用，如 '⌘K'
  action: () => void | Promise<void>
}

class CommandRegistry {
  private commands = reactive(new Map<string, Command>())

  register(cmd: Command): () => void {
    this.commands.set(cmd.id, cmd)
    let unbindShortcut: (() => void) | null = null
    if (cmd.shortcut) {
      unbindShortcut = this.bindShortcut(cmd.shortcut, () => void cmd.action())
    }
    return () => {
      this.commands.delete(cmd.id)
      unbindShortcut?.()
    }
  }

  unregister(id: string): void {
    this.commands.delete(id)
  }

  getAll(): Command[] {
    return Array.from(this.commands.values())
  }

  /** 模糊搜索（简单实现：title/keywords 包含 query 任意词） */
  search(query: string): Command[] {
    if (!query.trim()) {
      return this.getAll().sort((a, b) => a.title.localeCompare(b.title))
    }
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const scored = this.getAll()
      .map((cmd) => {
        const haystack = (
          cmd.title +
          ' ' +
          (cmd.category ?? '') +
          ' ' +
          (cmd.keywords ?? []).join(' ')
        ).toLowerCase()
        let score = 0
        for (const term of terms) {
          if (haystack.includes(term)) score += 1
          if (cmd.title.toLowerCase().startsWith(term)) score += 2
        }
        return { cmd, score }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
    return scored.map((x) => x.cmd)
  }

  /** 触发命令 */
  async run(id: string): Promise<void> {
    const cmd = this.commands.get(id)
    if (cmd) {
      await cmd.action()
    }
  }

  /**
   * 解析快捷键字符串（'mod+k' / 'ctrl+shift+p' / 'cmd+,'）并绑定到 window keydown。
   * 'mod' 在 macOS 等价于 cmd，在其他平台等价于 ctrl。
   * 返回 unbind 函数。
   */
  private bindShortcut(shortcut: string, callback: () => void): () => void {
    const parts = shortcut.toLowerCase().split('+')
    const wantMod = parts.includes('mod') || parts.includes('cmd') || parts.includes('ctrl')
    const wantShift = parts.includes('shift')
    const wantAlt = parts.includes('alt')
    const key = parts[parts.length - 1]!

    const handler = (e: KeyboardEvent): void => {
      const isMod = e.metaKey || e.ctrlKey
      if (wantMod !== isMod) return
      if (wantShift !== e.shiftKey) return
      if (wantAlt !== e.altKey) return
      if (e.key.toLowerCase() !== key) return
      e.preventDefault()
      callback()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }
}

export const commandRegistry = new CommandRegistry()
