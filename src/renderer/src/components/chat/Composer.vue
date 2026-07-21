<template>
  <!--
    底部输入区——圆角输入框悬浮风格（对齐 Claude Code）。

    外层无边框无背景（透明），跟主体聊天区背景完全贯通，
    圆角输入框视觉上悬浮在底部。内层带 border + rounded 的容器把附件区 /
    textarea / 底部配置行包在一起。

    底部配置行：Model / Effort / PermissionMode 三个 select 跟发送按钮平齐。
    这三个之前在 RuntimeConfigBar 顶部，下沉到这里更接近"发消息时随手调"的场景。

    宽度：内层用跟 MessageList 一致的响应式 max-width + mx-auto 居中，
    保证输入框跟上方消息列表左右对齐。
  -->
  <div>
    <div class="mx-auto max-w-3xl lg:max-w-screen-lg xl:max-w-[1280px] 2xl:max-w-[1440px] p-3">
      <!-- 圆角输入容器 -->
      <div
        class="rounded-2xl border border-border bg-background overflow-hidden focus-within:border-primary/50 transition-colors"
      >
        <!-- 附件区 -->
        <AttachmentBar
          :attachments="chatInput.pendingAttachments"
          @remove="chatInput.removeAttachment"
        />

        <!-- textarea -->
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

        <!-- 底部配置行：Model / Effort / PermissionMode + 发送按钮 -->
        <div class="flex items-center gap-2 px-3 py-2">
          <!-- Model -->
          <select
            :value="modelValue.model"
            class="bg-secondary text-secondary-foreground text-xs px-2 py-1 rounded border-0 focus:outline-none max-w-[160px]"
            title="模型"
            @change="onModelChange"
          >
            <option :value="null">(default)</option>
            <option v-for="m in backendStore.models" :key="m.id" :value="m.id">
              {{ m.displayName }}
            </option>
          </select>

          <!-- Effort -->
          <select
            :value="modelValue.effort"
            class="bg-secondary text-secondary-foreground text-xs px-2 py-1 rounded border-0 focus:outline-none"
            title="推理强度"
            @change="onEffortChange"
          >
            <option :value="null">(default)</option>
            <option v-for="e in supportedEfforts" :key="e" :value="e">
              {{ e }}
            </option>
          </select>

          <!-- Permission Mode -->
          <select
            :value="modelValue.permissionMode"
            class="bg-secondary text-secondary-foreground text-xs px-2 py-1 rounded border-0 focus:outline-none"
            title="权限模式"
            @change="onPermissionModeChange"
          >
            <option v-for="m in supportedPermissionModes" :key="m" :value="m">
              {{ permissionLabel(m) }}
            </option>
          </select>

          <div class="flex-1" />

          <span class="font-sans text-[11px] text-muted-foreground hidden sm:inline">
            Shift+Enter 换行
          </span>

          <!-- 发送 / 停止按钮 -->
          <Button
            v-if="messageStore.isRunning"
            variant="destructive"
            size="icon"
            class="h-7 w-7 rounded-full"
            title="停止"
            @click="onInterrupt"
          >
            <SquareIcon class="w-3 h-3" />
          </Button>
          <Button
            v-else
            size="icon"
            class="h-7 w-7 rounded-full"
            :disabled="!canSend"
            title="发送 (Enter)"
            @click="onSend"
          >
            <ArrowUpIcon class="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AttachmentBar from '@renderer/components/chat/AttachmentBar.vue'
import { Button } from '@renderer/components/ui/button'
import { useChatInputStore } from '@renderer/stores/chat-input'
import { useBackendStore } from '@renderer/stores/backend'
import { useMessageStore } from '@renderer/stores/message'
import { useSettingsStore } from '@renderer/stores/settings'
import type { ContextBlock, EffortLevel, PermissionMode } from '@shared/backend/types'
import { ArrowUpIcon, SquareIcon } from 'lucide-vue-next'
import { ref, computed } from 'vue'

interface RuntimeConfigValue {
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode
}

const props = defineProps<{
  disabled?: boolean
  modelValue: RuntimeConfigValue
}>()
const emit = defineEmits<{
  send: [text: string, attachments: ContextBlock[]]
  'update:modelValue': [value: RuntimeConfigValue]
}>()

const messageStore = useMessageStore()
const settingsStore = useSettingsStore()
const backendStore = useBackendStore()
const chatInput = useChatInputStore()
const prompt = ref('')

const canSend = computed(
  () =>
    (prompt.value.trim().length > 0 || chatInput.pendingAttachments.length > 0) &&
    !props.disabled,
)

const supportedEfforts = computed<EffortLevel[]>(() => {
  return backendStore.current?.capabilities.supportedEfforts ?? ['low', 'medium', 'high']
})

const supportedPermissionModes = computed<PermissionMode[]>(() => {
  return (
    backendStore.current?.capabilities.supportedPermissionModes ?? [
      'default',
      'acceptEdits',
      'auto',
      'plan',
      'dontAsk',
      'bypassPermissions',
    ]
  )
})

function permissionLabel(m: PermissionMode): string {
  return {
    default: '每次问',
    acceptEdits: '自动接受编辑',
    auto: '自动',
    plan: '计划模式',
    dontAsk: '不问',
    bypassPermissions: '完全跳过权限',
  }[m]
}

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

function onModelChange(e: Event): void {
  const target = e.target as HTMLSelectElement
  const value = target.value === 'null' ? null : target.value
  emit('update:modelValue', { ...props.modelValue, model: value })
}

function onEffortChange(e: Event): void {
  const target = e.target as HTMLSelectElement
  const value = (target.value === 'null' ? null : target.value) as EffortLevel | null
  emit('update:modelValue', { ...props.modelValue, effort: value })
}

function onPermissionModeChange(e: Event): void {
  const target = e.target as HTMLSelectElement
  const value = target.value as PermissionMode
  emit('update:modelValue', { ...props.modelValue, permissionMode: value })
}
</script>
