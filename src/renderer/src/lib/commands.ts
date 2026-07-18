/**
 * 默认命令注册。
 *
 * 在 main.ts 引入此文件即可触发注册（副作用模块）。
 * 各命令通过 pinia store 调用实际逻辑。
 */
import { commandRegistry } from './commandRegistry'

export async function registerDefaultCommands(): Promise<void> {
  // 动态 import 避免循环依赖
  const { useWorkspaceStore } = await import('@renderer/stores/workspace')
  const { useBackendStore } = await import('@renderer/stores/backend')
  const { useSessionStore } = await import('@renderer/stores/session')
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
    shortcut: '⌘,',
    action: () => {
      void router.push('/settings')
    },
  })

  commandRegistry.register({
    id: 'workspace.add',
    title: '添加工作区',
    category: 'Workspace',
    keywords: ['workspace', 'add', 'folder', 'open'],
    action: async () => {
      const ws = useWorkspaceStore()
      const result = await window.api.system.openDialog({
        title: '选择工作区文件夹',
        properties: ['openDirectory'],
      })
      if (!result.canceled && result.filePaths.length > 0) {
        await ws.add(result.filePaths[0]!)
        void router.push('/chat')
      }
    },
  })

  commandRegistry.register({
    id: 'session.new',
    title: '新建会话',
    category: 'Session',
    keywords: ['session', 'new', 'chat'],
    action: () => {
      const s = useSessionStore()
      s.setCurrent('')
      void router.push('/chat')
    },
  })

  commandRegistry.register({
    id: 'backend.switch-codex',
    title: '切换到 Codex 后端',
    category: 'Backend',
    keywords: ['backend', 'switch', 'codex', 'openai'],
    action: async () => {
      const b = useBackendStore()
      await b.switchTo('codex')
    },
  })

  commandRegistry.register({
    id: 'backend.switch-claude',
    title: '切换到 Claude 后端',
    category: 'Backend',
    keywords: ['backend', 'switch', 'claude', 'anthropic'],
    action: async () => {
      const b = useBackendStore()
      await b.switchTo('claude')
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
}

// 不立即调，由 main.ts 控制
export { commandRegistry }
