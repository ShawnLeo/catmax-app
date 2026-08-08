/**
 * Open With: macOS「打开方式」的渲染层统一入口。
 *
 * 三个调用方共享同一份逻辑：
 * - 文件树右键菜单（FileTree.vue）：列出某文件能打开的应用，点击用它打开
 * - 聊天顶部全局选择器（RuntimeConfigBar.vue）：选一个全局默认应用
 * - Composer 引用 pill 图标（FileMentionPill.vue）：点击用全局选中应用打开
 *
 * 全部沿用 useAlwaysOnTop 的模块级单例模式：平台、选中应用是跨组件共享状态，
 * 任一处更新（如顶部选择器切换）其它处立即反映，无需各自重新读 IPC。
 */
import type { OpenWithApp } from '@shared/ipc/system'
import { ref } from 'vue'

/** 模块级单例——所有调用方共享同一份 platform / selectedApp */
const platform = ref<'darwin' | 'win32' | 'linux'>('darwin')
const selectedApp = ref<OpenWithApp | null>(null)
let initialized = false

export function useOpenWith() {
  /**
   * 首次调用时拉一次平台 + 选中应用；后续调用复用同一份 ref，不再重复 IPC。
   * 平台读不到就用默认 darwin 兜底（不影响菜单主体）。
   */
  async function initOpenWith(): Promise<void> {
    if (initialized) return
    initialized = true
    try {
      const info = await window.api.system.platformInfo()
      platform.value = info.platform
    } catch {
      /* 兜底 darwin */
    }
    try {
      selectedApp.value = await window.api.system.getOpenWithApp()
    } catch {
      selectedApp.value = null
    }
  }

  /** 查询能打开某文件的应用列表（仅 darwin 有意义，其它平台返回 []）。 */
  async function listApps(absPath: string): Promise<OpenWithApp[]> {
    if (!absPath) return []
    try {
      return await window.api.system.openWithApps({ path: absPath })
    } catch {
      return []
    }
  }

  /**
   * 列出系统已安装的应用（扫 /Applications，不依赖具体文件）。
   * 全局「打开方式」选择器用——dropdown 始终可用，可在添加引用前先选好应用。
   * 仅 darwin 返回非空。
   */
  async function listInstalledApps(): Promise<OpenWithApp[]> {
    try {
      return await window.api.system.listApplications()
    } catch {
      return []
    }
  }

  /**
   * 用指定应用打开文件；app 为空时用系统默认（openPath）。
   * 非 darwin 平台忽略 app 参数，始终走系统默认（openWithApp 仅 darwin 实现）。
   */
  async function openWith(
    absPath: string,
    app: OpenWithApp | null = selectedApp.value,
  ): Promise<void> {
    if (!absPath) return
    if (app && platform.value === 'darwin') {
      await window.api.system.openWithApp({ filePath: absPath, appPath: app.path })
    } else {
      await window.api.system.openPath({ path: absPath })
    }
  }

  /**
   * 持久化全局选中应用并同步单例 ref；传 null 清除（回到系统默认）。
   * 顶部选择器切换时调它，所有引用 pill 图标点击立即用新选择打开。
   */
  async function selectApp(app: OpenWithApp | null): Promise<void> {
    selectedApp.value = app
    try {
      await window.api.system.setOpenWithApp({ app })
    } catch {
      /* 落盘失败不回滚内存值——下次启动会重新读 */
    }
  }

  return {
    platform,
    selectedApp,
    initOpenWith,
    listApps,
    listInstalledApps,
    openWith,
    selectApp,
  }
}
