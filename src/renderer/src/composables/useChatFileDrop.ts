/**
 * File Mention: 把文件拖进会话。
 *
 * 两件事，一件是必须做的，一件是想做的：
 *
 * 1. 必须——全窗口拦截 dragover/drop。Chromium 对没有 preventDefault 的文件投放的
 *    默认行为是「导航到那个 file:// URL」，在 Electron 里就是整个应用白屏，且没有
 *    任何返回路径。所以拦截必须挂在 window 上覆盖每一寸像素，不能只挂在投放区。
 * 2. 想做——拖拽过程中亮起投放遮罩。用户不必精确瞄准输入框，拖到聊天区任意位置
 *    松手即可。
 *
 * 生效边界 = 视觉边界：遮罩画在主聊天列上，也只有落在遮罩上的投放才会被引用。
 * 落在侧栏、右栏、终端上的投放被静默吞掉（已经 preventDefault 了，只是不处理）——
 * 那几处各有自己的语义，把它们也当成引用会让人猜不到会发生什么。
 */
import { dragHasFiles, readDraggedFiles } from '@renderer/lib/drag-file-paths'
import { mentionPathFor } from '@renderer/lib/mention-path'
import { useChatInputStore } from '@renderer/stores/chat-input'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { onBeforeUnmount, onMounted, type Ref, ref } from 'vue'

/**
 * 没有 dragover 心跳超过这么久就认为拖拽已经离开窗口。
 *
 * 兜底，不是优化：把文件从窗口里拖回访达时，Chromium 有时不发 dragleave，
 * 只是单纯不再发 dragover——少了这个超时，遮罩会一直亮着盖住整个聊天区，
 * 且再也没有事件能把它关掉。
 */
const DRAG_HEARTBEAT_TIMEOUT_MS = 300

export function useChatFileDrop(): {
  dragActive: Ref<boolean>
  onDrop: (event: DragEvent) => Promise<void>
} {
  const chatInput = useChatInputStore()
  const workspaceStore = useWorkspaceStore()

  const dragActive = ref(false)

  /**
   * dragenter/dragleave 的深度计数。
   *
   * 指针从父元素移到子元素时，浏览器先发子元素的 dragenter 再发父元素的
   * dragleave——只看单个事件的话遮罩会在整个聊天区里疯狂闪烁。计数归零才算
   * 真正离开。不用 relatedTarget 判断是因为 Chromium 在跨越 shadow/iframe
   * 边界时会把它置空。
   */
  let depth = 0
  let heartbeat: ReturnType<typeof setTimeout> | null = null

  function deactivate(): void {
    depth = 0
    dragActive.value = false
    if (heartbeat) {
      clearTimeout(heartbeat)
      heartbeat = null
    }
  }

  function onDragEnter(e: DragEvent): void {
    if (!dragHasFiles(e.dataTransfer)) return
    depth += 1
    dragActive.value = true
  }

  function onDragOver(e: DragEvent): void {
    if (!dragHasFiles(e.dataTransfer)) return
    // 这两句都不能省：preventDefault 关掉默认导航，dropEffect 决定光标形态，
    // 而 drop 事件只有在 dragover 被 preventDefault 过之后才会触发。
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    dragActive.value = true
    if (heartbeat) clearTimeout(heartbeat)
    heartbeat = setTimeout(deactivate, DRAG_HEARTBEAT_TIMEOUT_MS)
  }

  function onDragLeave(e: DragEvent): void {
    if (!dragHasFiles(e.dataTransfer)) return
    depth -= 1
    if (depth <= 0) deactivate()
  }

  /** 窗口级兜底：落在投放区之外的文件投放也要吞掉，否则一样会触发导航。 */
  function onWindowDrop(e: DragEvent): void {
    e.preventDefault()
    deactivate()
  }

  onMounted(() => {
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onWindowDrop)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('dragenter', onDragEnter)
    window.removeEventListener('dragover', onDragOver)
    window.removeEventListener('dragleave', onDragLeave)
    window.removeEventListener('drop', onWindowDrop)
    if (heartbeat) clearTimeout(heartbeat)
  })

  /** 投放区自己的 drop——真正把文件变成引用。 */
  async function onDrop(event: DragEvent): Promise<void> {
    event.preventDefault()
    event.stopPropagation()
    const files = readDraggedFiles(event.dataTransfer)
    deactivate()
    if (files.length === 0) {
      // 遮罩亮了说明 dragHasFiles 认了这次拖拽，却一个文件都解析不出来——要么是
      // 拖了个网页链接（预期内），要么是某个来源用了 readDraggedFiles 还不认识的
      // 通道。把类型名打出来，否则这种「拖进去没反应」除了逐个试没有别的查法。
      console.warn(
        '[file-drop] 接住了拖放但没解析出文件，dataTransfer.types =',
        Array.from(event.dataTransfer?.types ?? []),
      )
      return
    }

    const workspaceId = workspaceStore.currentWorkspace?.id
    for (const file of files) {
      // 应用内文件树拖过来的已经是工作区相对路径，不用再解析一遍。
      if (file.relativePath) {
        chatInput.addFileMention(file.relativePath)
        continue
      }
      if (!file.absolutePath) continue
      chatInput.addFileMention(await mentionPathFor(workspaceId, file.absolutePath))
    }
  }

  return { dragActive, onDrop }
}
