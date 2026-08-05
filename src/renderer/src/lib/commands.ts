/**
 * 默认命令注册。
 *
 * 在 main.ts 引入此文件即可触发注册（副作用模块）。
 * 各命令通过 pinia store 调用实际逻辑。
 */
import { commandRegistry } from './commandRegistry'

export async function registerDefaultCommands(): Promise<void> {
  // 动态 import 避免循环依赖
  const { useBackendStore } = await import('@renderer/stores/backend')
  const { useSessionStore } = await import('@renderer/stores/session')
  const { useUiStore } = await import('@renderer/stores/ui')
  const router = (await import('@renderer/router')).router

  // 这里不能用 useXxxStore（需要在 setup 内），改成在 action 里调
  commandRegistry.register({
    id: 'app.go-welcome',
    title: '回到首页',
    category: 'Navigation',
    keywords: ['home', 'welcome', 'back'],
    action: () => {
      void router.push('/')
    },
  })

  commandRegistry.register({
    id: 'app.go-settings',
    title: '打开设置',
    category: 'Navigation',
    keywords: ['settings', 'preference', 'config'],
    shortcut: 'mod+,',
    action: () => {
      void router.push('/settings')
    },
  })

  commandRegistry.register({
    id: 'workspace.add',
    title: '创建工作区',
    category: 'Workspace',
    keywords: ['workspace', 'add', 'folder', 'open'],
    action: () => {
      void router.push('/')
    },
  })

  commandRegistry.register({
    id: 'session.new',
    title: '新建会话',
    category: 'Session',
    keywords: ['session', 'new', 'chat'],
    shortcut: 'mod+n',
    action: async () => {
      // 三个 store 都要动，逻辑集中在 lib/new-session.ts（与侧边栏按钮共用一份）。
      const { startNewSession } = await import('@renderer/lib/new-session')
      await startNewSession()
      void router.push('/chat')
    },
  })

  commandRegistry.register({
    id: 'backend.refresh',
    title: '刷新后端状态',
    category: 'Backend',
    keywords: ['backend', 'refresh', 'status'],
    action: async () => {
      const b = useBackendStore()
      await b.refresh()
    },
  })

  commandRegistry.register({
    id: 'app.toggle-sidebar',
    title: '切换侧边栏',
    category: 'View',
    keywords: ['sidebar', 'toggle', 'hide'],
    shortcut: 'mod+b',
    action: () => {
      const u = useUiStore()
      u.toggleSidebar()
    },
  })

  commandRegistry.register({
    id: 'app.toggle-right-panel',
    title: '切换右栏面板',
    category: 'View',
    keywords: ['panel', 'right', 'toggle'],
    shortcut: 'mod+j',
    action: () => {
      const u = useUiStore()
      u.toggleRightPanel()
    },
  })

  commandRegistry.register({
    id: 'app.command-palette',
    title: '打开命令面板',
    category: 'App',
    keywords: ['palette', 'search', 'command'],
    shortcut: 'mod+k',
    action: () => {
      // 通过 uiStore 控制全局 commandPaletteVisible（App.vue 双向绑定）
      // toggle 让 mod+k 既能开也能关
      const u = useUiStore()
      u.toggleCommandPalette()
    },
  })

  // ⌘1-9 切换到最近的会话（最后一个 = 最近）
  for (let i = 1; i <= 9; i++) {
    const slot = i
    commandRegistry.register({
      id: `session.switch-${slot}`,
      title: `切换到会话 ${slot}`,
      category: 'Session',
      keywords: ['session', 'switch', `slot ${slot}`],
      shortcut: `mod+${slot}`,
      action: () => {
        const s = useSessionStore()
        const target = s.sessions[s.sessions.length - slot]
        if (target) {
          s.setCurrent(target.id)
          void s.loadHistory(target.id)
        }
      },
    })
  }
}

// 不立即调，由 main.ts 控制
export { commandRegistry }
