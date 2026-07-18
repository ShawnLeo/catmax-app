import { useTerminalStore } from '@renderer/stores/terminal'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { onMounted, onUnmounted, ref, watch, type Ref } from 'vue'

/**
 * 在指定 DOM 元素上挂载 xterm.js，连接到指定 terminal id。
 *
 * - 创建 Terminal + FitAddon + WebLinksAddon
 * - 订阅 pty:data（只处理本 id 的数据）
 * - 用户输入 → pty.write
 * - 容器 resize → fit + pty.resize
 *
 * 注：xterm 的 css 在 main.ts 全局引入（@xterm/xterm/css/xterm.css）。
 */
export function useTerminal(containerRef: Ref<HTMLElement | null>, terminalId: Ref<string | null>) {
  const term = ref<Terminal | null>(null)
  const fitAddon = ref<FitAddon | null>(null)
  let unsubData: (() => void) | null = null
  let unsubExit: (() => void) | null = null
  let resizeObserver: ResizeObserver | null = null

  const terminalStore = useTerminalStore()

  function init(): void {
    if (!containerRef.value || term.value) return

    const t = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'var(--font-mono), monospace',
      theme: {
        background: '#0a0a0c',
        foreground: '#e4e4e7',
        cursor: '#e4e4e7',
      },
    })
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.loadAddon(new WebLinksAddon())
    t.open(containerRef.value)
    try {
      fit.fit()
    } catch {
      // 容器还没布局好
    }

    // 用户输入 → pty
    const inputData = (data: string): void => {
      const id = terminalId.value
      if (id) void terminalStore.write(id, data)
    }
    t.onData(inputData)

    // resize 处理
    const handleResize = (): void => {
      try {
        fit.fit()
        const id = terminalId.value
        if (id) {
          void terminalStore.resize(id, t.cols, t.rows)
        }
      } catch {
        // ignore
      }
    }

    resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(containerRef.value)

    term.value = t
    fitAddon.value = fit

    // 订阅 pty 数据
    unsubData = window.api.pty.onData(({ id, data }) => {
      if (id === terminalId.value) {
        t.write(data)
      }
    })
    unsubExit = window.api.pty.onExit(({ id, exitCode }) => {
      if (id === terminalId.value) {
        t.write(`\r\n[process exited with code ${exitCode}]\r\n`)
        terminalStore.removeLocal(id)
      }
    })
  }

  function dispose(): void {
    resizeObserver?.disconnect()
    resizeObserver = null
    unsubData?.()
    unsubData = null
    unsubExit?.()
    unsubExit = null
    term.value?.dispose()
    term.value = null
    fitAddon.value = null
  }

  onMounted(() => {
    init()
  })

  onUnmounted(() => {
    dispose()
  })

  // terminalId 变化时重新初始化（保持同一个 xterm 实例，只切数据源）
  watch(terminalId, () => {
    // 不需要重新 init，因为 onData 用的是 ref，自动响应
  })

  return { term, fitAddon }
}
