/**
 * 跨组件的对话输入状态——文本本身 + 附件。
 *
 * 用 Pinia 是因为写它的人散布在整棵树上，彼此没有父子关系：
 * FilePreview（右栏）加选区附件、FileTree（右栏）右键加文件引用、
 * ChatView 的投放遮罩接住拖拽、Composer（底部）读取并发送。
 *
 * 两类附件走两条不同的路，这不是重复而是刻意的：
 * - 文件引用（`@路径`）活在 `text` 里，pill 由文本派生（见 lib/file-mention.ts）。
 *   文本是唯一真相，所以手删 token 和点 pill 的 ✕ 天然等价。
 * - 选区代码片段（ide_selection）带正文，文本里表达不出来，只能单独存在
 *   pendingAttachments 里。加新的带正文附件类型时扩下面的工厂函数。
 */
import {
  appendFileMention,
  type FileMention,
  parseFileMentions,
  removeFileMentionAt,
} from '@renderer/lib/file-mention'
import type { ContextBlock } from '@shared/backend/types'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export const useChatInputStore = defineStore('chat-input', () => {
  /** 输入框文本——Composer 用 v-model 绑它，其他组件通过下面的方法改写 */
  const text = ref('')

  /** 待发送附件列表——Composer 发送时读取，发送后清空 */
  const pendingAttachments = ref<ContextBlock[]>([])

  /**
   * 当前文本里的文件引用，按出现顺序去重。
   *
   * 派生量，没有 setter——想改就改 text。同一路径被引用多次时只保留第一处，
   * pill 列表不该出现两条一模一样的。
   */
  const fileMentions = computed<FileMention[]>(() => {
    const seen = new Set<string>()
    return parseFileMentions(text.value).filter((m) => {
      if (seen.has(m.path)) return false
      seen.add(m.path)
      return true
    })
  })

  /** 追加一条文件引用（拖放 / 右键「添加到对话」的统一入口）。已引用过则静默跳过。 */
  function addFileMention(path: string): void {
    text.value = appendFileMention(text.value, path)
  }

  /** 移除一条文件引用——从文本里删掉那一段，pill 随之消失。 */
  function removeFileMention(mention: FileMention): void {
    text.value = removeFileMentionAt(text.value, mention)
  }

  function addAttachment(att: ContextBlock): void {
    pendingAttachments.value.push(att)
  }

  function removeAttachment(index: number): void {
    pendingAttachments.value.splice(index, 1)
  }

  function clear(): void {
    pendingAttachments.value = []
  }

  /** 批量取走（Composer 发送时用，发送后自动清空） */
  function drain(): ContextBlock[] {
    const out = [...pendingAttachments.value]
    pendingAttachments.value = []
    return out
  }

  return {
    text,
    fileMentions,
    addFileMention,
    removeFileMention,
    pendingAttachments,
    addAttachment,
    removeAttachment,
    clear,
    drain,
  }
})

// ============ 附件工厂函数 ============

/** 从 FilePreview 选中的代码片段构造附件 */
export function ideSelectionAttachment(opts: {
  filePath: string
  startLine: number
  endLine: number
  code: string
}): ContextBlock {
  return {
    tag: 'ide_selection',
    data: {
      filePath: opts.filePath,
      startLine: opts.startLine,
      endLine: opts.endLine,
      code: opts.code,
    },
  }
}
