/**
 * 「新建会话」的唯一实现。
 *
 * 存在的理由是它有四个入口——侧边栏按钮、命令面板、⌘N、托盘右键菜单——而这件事
 * 需要同时动三个 store，漏掉任何一个都会得到一个"看起来新建了、其实没有"的状态：
 *
 * - sessionStore.setCurrent('')：清掉选中态，onSend 才会走延迟创建流程；
 * - messageStore.setCurrentSession(null)：清掉主聊天窗口的消息。两个 store 各持一份
 *   currentSessionId，只清前者的话侧边栏取消了高亮、主窗口却还停在旧会话的消息上，
 *   用户以为没生效（这正是托盘/⌘N 之前的表现——commands.ts 里少了这一行）；
 * - backendStore.switchTo(默认后端)：onSend 用当前 adapter 建会话，刚浏览过 claude
 *   会话就点新建的话，会以 claude 起线程，但默认后端可能是 codex，建出来的会话
 *   backend 对不上。默认后端不可用时静默跳过，沿用当前 adapter，至少能发消息。
 */
import { toPlainWorkspaceFolders } from '@renderer/lib/workspace-folder-context'
import { useBackendStore } from '@renderer/stores/backend'
import { useMessageStore } from '@renderer/stores/message'
import { useSessionStore } from '@renderer/stores/session'
import { useSettingsStore } from '@renderer/stores/settings'
import { useWorkspaceStore } from '@renderer/stores/workspace'

/**
 * 清空当前会话，让下一条消息建出一个新的。
 *
 * Claude 会在清空后异步预热共享 prompt cache——预热用独立临时 session，
 * 不提前创建 Catmax 用户会话；用户发送首条真实消息时仍走原来的延迟创建流程。
 */
export async function startNewSession(): Promise<void> {
  const settingsStore = useSettingsStore()
  const backendStore = useBackendStore()
  const sessionStore = useSessionStore()
  const messageStore = useMessageStore()
  const workspaceStore = useWorkspaceStore()

  const isAvailable = (id: string): boolean =>
    backendStore.statuses.find((s) => s.id === id)?.available ?? false

  const def = settingsStore.settings?.defaultBackend
  if (def && def !== backendStore.currentId && isAvailable(def)) {
    await backendStore.switchTo(def)
  }

  sessionStore.setCurrent('')
  messageStore.setCurrentSession(null)

  const workspace = workspaceStore.currentWorkspace
  if (backendStore.currentId !== 'claude' || !workspace) return

  // 使用最近一次 Claude 运行配置，使 Warmup 的 model/effort 尽量匹配随后发送的首条消息。
  // fire-and-forget：点击新建后 UI 立即可输入，预热失败也不影响真实会话。
  void (async () => {
    try {
      const last = await window.api.session.getLastRuntimeConfig()
      const config: Parameters<typeof window.api.backend.warmup>[0]['config'] = {
        cwd: workspace.path,
        workspaceFolders: toPlainWorkspaceFolders(workspace.folders),
      }
      if (last?.backend === 'claude' && last.model) config.model = last.model
      if (last?.backend === 'claude' && last.effort) config.effort = last.effort
      await window.api.backend.warmup({ id: 'claude', config })
    } catch (error) {
      console.warn('[new-session] Claude warmup failed:', error)
    }
  })()
}
