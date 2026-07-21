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
      <!-- 圆角输入容器
           注意：不加 overflow-hidden——否则 DropdownMenu/ThinkingSlider 的弹层
           会被容器裁切（弹层在按钮上方时超出容器上边界）。内部子元素的圆角
           由各自的 rounded-* 控制，textarea/AttachmentBar 没有溢出元素，
           容器自身圆角不会露出直角。-->
      <div
        class="rounded-2xl border border-border bg-background focus-within:border-primary/50 transition-colors"
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
          <DropdownMenu
            :model-value="modelValue.model"
            :options="[
              { value: null as string | null, label: '(default)' },
              ...backendStore.models.map((m) => ({
                value: m.id as string | null,
                label: m.displayName,
              })),
            ]"
            placement="top"
            title="模型"
            @update:model-value="onModelSelect"
          />

          <!-- 刷新模型列表--清 main 端 cachedModelsPromise，重新拉一次 model/list -->
          <button
            type="button"
            class="text-secondary-foreground/60 hover:text-secondary-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            :disabled="refreshing"
            title="刷新模型列表"
            @click="onRefreshModels"
          >
            <RefreshCwIcon class="w-3 h-3" :class="refreshing ? 'animate-spin' : ''" />
          </button>

          <!-- 思考强度（合并了旧 effort select + thinking 开关到同一数轴）
               点击展开横向档位滑块；max 档启用紫色脉冲动画。 -->
          <ThinkingSlider
            :model-value="modelValue.effort ?? 'medium'"
            :supported="supportedEfforts"
            @update:model-value="onEffortSelect"
          />

          <!-- Permission Mode -->
          <DropdownMenu
            :model-value="modelValue.permissionMode"
            :options="
              supportedPermissionModes.map((m) => ({
                value: m,
                label: permissionLabel(m),
              }))
            "
            placement="top"
            title="权限模式"
            @update:model-value="onPermissionModeSelect"
          />

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
import ThinkingSlider from '@renderer/components/chat/ThinkingSlider.vue'
import { Button } from '@renderer/components/ui/button'
import { DropdownMenu } from '@renderer/components/ui/dropdown-menu'
import { useBackendStore } from '@renderer/stores/backend'
import { useChatInputStore } from '@renderer/stores/chat-input'
import { useMessageStore } from '@renderer/stores/message'
import { useSettingsStore } from '@renderer/stores/settings'
import type { ContextBlock, EffortLevel, PermissionMode } from '@shared/backend/types'
import { ArrowUpIcon, RefreshCwIcon, SquareIcon } from 'lucide-vue-next'
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

const refreshing = ref(false)
async function onRefreshModels(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await backendStore.refreshModels()
  } finally {
    refreshing.value = false
  }
}

const canSend = computed(
  () =>
    (prompt.value.trim().length > 0 || chatInput.pendingAttachments.length > 0) && !props.disabled,
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

function onModelSelect(value: string | null): void {
  emit('update:modelValue', { ...props.modelValue, model: value })
}

function onEffortSelect(value: EffortLevel): void {
  emit('update:modelValue', { ...props.modelValue, effort: value })
}

function onPermissionModeSelect(value: PermissionMode): void {
  emit('update:modelValue', { ...props.modelValue, permissionMode: value })
}
</script>
