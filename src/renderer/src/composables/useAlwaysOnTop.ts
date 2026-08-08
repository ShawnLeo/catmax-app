import { ref } from 'vue'

/**
 * Always-on-Top Sync: 窗口置顶状态在渲染层的单一来源。
 *
 * 主进程才是真正的真相来源（window.ts 里跨重启持久化），但渲染层若每个页面各存一份
 * 本地 ref，切换页面时就会各读各的初值——聊天页点亮的置顶，到了设置页/欢迎页可能
 * 显示成未置顶，反之亦然。这里用一个模块级单例 ref，让欢迎页、设置页、聊天运行时栏
 * 三处的按钮始终指向同一份状态：任一处 toggle，其它处下次渲染立即反映，无需重新挂载。
 */
const isAlwaysOnTop = ref(false)
let initialized = false

export function useAlwaysOnTop() {
  /**
   * 首次调用时从主进程读一次真值；后续调用复用同一份 ref，不再重复 IPC。
   * 主进程在窗口创建时即恢复持久化的 alwaysOnTop，渲染层挂载时它已就绪。
   */
  async function initAlwaysOnTop(): Promise<void> {
    if (initialized) return
    initialized = true
    isAlwaysOnTop.value = await window.api.system.windowIsAlwaysOnTop()
  }

  /** 切换置顶：主进程返回切换后的状态，直接写回单例 ref，所有引用处同步更新。 */
  async function toggleAlwaysOnTop(): Promise<void> {
    isAlwaysOnTop.value = await window.api.system.windowToggleAlwaysOnTop()
  }

  return { isAlwaysOnTop, initAlwaysOnTop, toggleAlwaysOnTop }
}
