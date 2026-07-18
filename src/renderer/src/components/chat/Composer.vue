<template>
  <div class="border-t border-border bg-composer">
    <textarea
      ref="textarea"
      v-model="prompt"
      :placeholder="disabled ? '后端未连接...' : '发送消息...（Shift+Enter 换行）'"
      :disabled="disabled"
      rows="3"
      class="w-full bg-transparent font-chat text-[15px] text-foreground px-4 py-3 resize-none focus:outline-none disabled:opacity-50"
      @keydown="onKeyDown"
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
import { Button } from '@renderer/components/ui/button'
import { useMessageStore } from '@renderer/stores/message'
import { useSettingsStore } from '@renderer/stores/settings'
import { SquareIcon } from 'lucide-vue-next'
import { ref, computed } from 'vue'

const props = defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ send: [text: string] }>()

const messageStore = useMessageStore()
const settingsStore = useSettingsStore()
const prompt = ref('')

const canSend = computed(() => prompt.value.trim().length > 0 && !props.disabled)

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
  prompt.value = ''
  emit('send', text)
}

async function onInterrupt(): Promise<void> {
  if (messageStore.currentTurnId) {
    await window.api.backend.interruptTurn({ turnId: messageStore.currentTurnId })
  }
}
</script>
