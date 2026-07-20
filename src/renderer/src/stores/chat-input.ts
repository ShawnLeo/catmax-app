/**
 * 跨组件的对话输入附件状态——FilePreview 写入、Composer 读取。
 *
 * 用 Pinia 是因为 FilePreview（右栏）和 Composer（底部）是兄弟组件，没共同父级；
 * 用 eventBus / props emit 链路都更绕。
 *
 * 当前只支持 ide_selection 类附件（FilePreview 选行 / Composer 粘贴代码）。
 * 加新附件类型时直接扩 chatAttachmentFromXxx 工厂函数。
 */
import type { ContextBlock } from '@shared/backend/types'
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useChatInputStore = defineStore('chat-input', () => {
  /** 待发送附件列表——Composer 发送时读取，发送后清空 */
  const pendingAttachments = ref<ContextBlock[]>([])

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

  return { pendingAttachments, addAttachment, removeAttachment, clear, drain }
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
