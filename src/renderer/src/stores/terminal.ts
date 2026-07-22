import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface TerminalInstance {
  id: string
  pid: number
  cwd: string
  name: string
  createdAt: number
}

/**
 * 生成终端 tab 名——优先用 workspaceName，同名终端数字递增。
 *
 * 规则：
 *   catmax-app → catmax-app → catmax-app-2 → catmax-app-3 ...
 * workspaceName 为空时降级为 terminal / terminal-2 ...
 *
 * 通过遍历已存在的 terminal.name，收集已占用的序号，算出下一个可用序号。
 */
function nextTerminalName(existing: TerminalInstance[], workspaceName?: string): string {
  const base = workspaceName?.trim() || 'terminal'
  // 收集已占用序号：纯 base 占用 1，base-N 占用 N
  const used = new Set<number>()
  for (const t of existing) {
    if (t.name === base) {
      used.add(1)
      continue
    }
    const m = t.name.match(/^([\s\S]+)-(\d+)$/)
    if (m && m[1] === base) {
      used.add(Number(m[2]))
    }
  }
  // 找最小可用序号
  let n = 1
  while (used.has(n)) n++
  return n === 1 ? base : `${base}-${n}`
}

export const useTerminalStore = defineStore('terminal', () => {
  const terminals = ref<TerminalInstance[]>([])
  const activeId = ref<string | null>(null)

  /**
   * 创建终端。name 由 workspaceName 自动生成（同名递增）。
   * 第二参数可选，兼容旧调用（不传则降级为 terminal / terminal-2）。
   */
  async function create(cwd: string, workspaceName?: string): Promise<TerminalInstance> {
    const handle = await window.api.pty.create({ cwd })
    const instance: TerminalInstance = {
      id: handle.id,
      pid: handle.pid,
      cwd,
      name: nextTerminalName(terminals.value, workspaceName),
      createdAt: Date.now(),
    }
    terminals.value.push(instance)
    activeId.value = handle.id
    return instance
  }

  /** 重命名终端 tab。空名忽略。 */
  function rename(id: string, name: string): void {
    const trimmed = name.trim()
    if (!trimmed) return
    const target = terminals.value.find((t) => t.id === id)
    if (target) target.name = trimmed
  }

  async function write(id: string, data: string): Promise<void> {
    await window.api.pty.write({ id, data })
  }

  async function resize(id: string, cols: number, rows: number): Promise<void> {
    await window.api.pty.resize({ id, cols, rows })
  }

  async function kill(id: string): Promise<void> {
    await window.api.pty.kill({ id })
    removeLocal(id)
  }

  function removeLocal(id: string): void {
    terminals.value = terminals.value.filter((t) => t.id !== id)
    if (activeId.value === id) {
      activeId.value = terminals.value[0]?.id ?? null
    }
  }

  function setActive(id: string): void {
    activeId.value = id
  }

  return { terminals, activeId, create, write, resize, kill, removeLocal, setActive, rename }
})
