<template>
  <div class="border-t border-border bg-composer">
    <!-- 附件区（FilePreview 选中的代码、粘贴的代码片段等） -->
    <AttachmentBar
      :attachments="chatInput.pendingAttachments"
      @remove="chatInput.removeAttachment"
    />

    <textarea
      ref="textarea"
      v-model="prompt"
      :placeholder="disabled ? '后端未连接...' : '发送消息...（Shift+Enter 换行）'"
      :disabled="disabled"
      rows="3"
      class="w-full bg-transparent font-chat text-[15px] text-foreground px-4 py-3 resize-none focus:outline-none disabled:opacity-50"
      @keydown="onKeyDown"
      @paste="onPaste"
    />
    <div class="flex items-center justify-between px-4 py-2 border-t border-composer-border">
      <span class="font-sans text-xs text-muted-foreground">Shift+Enter 换行</span>
      <div class="flex gap-2">
        <Button v-if="messageStore.isRunning" variant="destructive" size="sm" @click="onInterrupt">
          <SquareIcon class="w-3 h-3 mr-1" /> 停止
        </Button>
        <Button v-else size="sm" :disabled="!canSend" @click="onSend"> 发送 </Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AttachmentBar from '@renderer/components/chat/AttachmentBar.vue'
import { Button } from '@renderer/components/ui/button'
import { useChatInputStore } from '@renderer/stores/chat-input'
import { useMessageStore } from '@renderer/stores/message'
import { useSettingsStore } from '@renderer/stores/settings'
import type { ContextBlock } from '@shared/backend/types'
import { SquareIcon } from 'lucide-vue-next'
import { ref, computed } from 'vue'

const props = defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ send: [text: string, attachments: ContextBlock[]] }>()

const messageStore = useMessageStore()
const settingsStore = useSettingsStore()
const chatInput = useChatInputStore()
const prompt = ref('')

const canSend = computed(
  () =>
    (prompt.value.trim().length > 0 || chatInput.pendingAttachments.length > 0) &&
    !props.disabled,
)

function onKeyDown(e: KeyboardEvent): void {
  const sendOnEnter = settingsStore.settings?.sendOnEnter ?? true
  if (e.key === 'Enter') {
    if (e.shiftKey) {
      // 让默认换行行为发生
      return
    }
    if (sendOnEnter) {
      e.preventDefault()
      onSend()
    }
  }
}

function onSend(): void {
  if (!canSend.value) return
  const text = prompt.value.trim()
  const attachments = chatInput.drain()
  prompt.value = ''
  emit('send', text, attachments)
}

/**
 * 粘贴处理：剪贴板是"看起来像代码"的多行文本时，自动作为 ide_selection 附件，
 * 不进 textarea。启发式判断（保守）：至少 2 行 + 含明显代码符号。
 * 加 attachments 时若有重复内容直接跳过。
 */
function onPaste(e: ClipboardEvent): void {
  const text = e.clipboardData?.getData('text/plain')
  if (!text) return

  const lineCount = text.split('\n').length
  if (lineCount < 2) return

  // 多行 + 含代码符号才认作代码片段
  const codeIndicators = /[{};=>]|function |class |def |import |const |let |var |public |private /
  if (!codeIndicators.test(text)) return

  // 已有相同附件，避免重复
  const dup = chatInput.pendingAttachments.some(
    (a: ContextBlock) => a.tag === 'ide_selection' && (a.data as { code: string }).code === text,
  )
  if (dup) {
    e.preventDefault()
    return
  }

  e.preventDefault()
  chatInput.addAttachment({
    tag: 'ide_selection',
    data: {
      // 粘贴的代码没有原始文件路径，用占位
      filePath: '(pasted snippet)',
      startLine: 1,
      endLine: lineCount,
      code: text,
    },
  })
}

async function onInterrupt(): Promise<void> {
  if (messageStore.currentTurnId) {
    await window.api.backend.interruptTurn({ turnId: messageStore.currentTurnId })
  }
}
</script>
