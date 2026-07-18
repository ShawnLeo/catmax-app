import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface TerminalInstance {
  id: string
  pid: number
  cwd: string
  createdAt: number
}

export const useTerminalStore = defineStore('terminal', () => {
  const terminals = ref<TerminalInstance[]>([])
  const activeId = ref<string | null>(null)

  async function create(cwd: string): Promise<TerminalInstance> {
    const handle = await window.api.pty.create({ cwd })
    const instance: TerminalInstance = {
      id: handle.id,
      pid: handle.pid,
      cwd,
      createdAt: Date.now(),
    }
    terminals.value.push(instance)
    activeId.value = handle.id
    return instance
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

  return { terminals, activeId, create, write, resize, kill, removeLocal, setActive }
})
