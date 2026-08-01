<template>
  <!--
    agent 问题面板——直接覆盖 Composer 的位置（同 PermissionPanel 的覆盖模式），
    让聊天记录始终可见，用户能边看上下文边回答。

    驱动：messageStore.pendingAgentQuestion（由 backend 推 agent_question 事件设置，
    即 claude 调用自定义 ask_user MCP 工具）。
    回答通过 window.api.backend.respondQuestion 回传 → adapter resolve handler
    → 答案作为 tool_result 回流给模型，模型基于答案继续。

    交互：
    - 选项按钮（单选/多选），选中高亮
    - 自由文本输入框（用户可不选任何选项，直接打字表达）
    - 提交：组装 AgentAnswer → respondQuestion → 清 pending
    - Esc / 跳过：空答案回传（告诉模型用户跳过，模型可换问法或自行判断）

    ask_user 一次只问一个问题（不像旧 AskUserQuestion 批量），所以这里无需分页。
  -->
  <div>
    <div :class="[chatContentWidthClass(navRailVisible), 'p-3']">
      <div class="rounded-2xl border border-border bg-background transition-colors overflow-hidden">
        <!-- header -->
        <div class="px-4 pt-3 pb-2 flex items-center gap-2">
          <MessageCircleQuestionIcon class="w-5 h-5 flex-shrink-0 text-primary" />
          <span
            v-if="question.header"
            class="text-[length:var(--chat-text-d3)] font-mono uppercase tracking-wide text-muted-foreground bg-muted px-1.5 py-0.5 rounded whitespace-nowrap"
          >
            {{ question.header }}
          </span>
          <span
            v-if="question.multiSelect"
            class="text-[length:var(--chat-text-d3)] text-muted-foreground italic"
          >
            可多选
          </span>
          <div class="flex-1" />
          <span class="text-[length:var(--chat-text-d1)] text-muted-foreground whitespace-nowrap"
            >Claude 想问你</span
          >
        </div>

        <!-- 问题文本 -->
        <div class="px-4 pb-2">
          <p class="text-[length:var(--chat-text-u1)] font-medium text-foreground">
            {{ question.question }}
          </p>
        </div>

        <!-- 选项 -->
        <div v-if="options.length > 0" class="px-4 pb-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            v-for="opt in options"
            :key="opt.label"
            type="button"
            :class="[
              'text-left rounded-md border px-3 py-2 transition-colors cursor-pointer',
              isSelected(opt.label)
                ? 'border-primary bg-primary/10'
                : 'border-border hover:border-primary/50 hover:bg-muted/50',
            ]"
            @click="onToggleOption(opt.label)"
          >
            <div class="flex items-start gap-1.5">
              <CheckIcon
                v-if="isSelected(opt.label)"
                class="w-3.5 h-3.5 text-primary flex-shrink-0 mt-0.5"
              />
              <div v-else class="w-3.5 h-3.5 flex-shrink-0 mt-0.5"></div>
              <div class="flex-1 min-w-0">
                <div class="text-[length:var(--chat-text-base)] font-medium text-foreground">
                  {{ opt.label }}
                </div>
                <div
                  v-if="opt.description"
                  class="text-[length:var(--chat-text-d2)] text-muted-foreground mt-0.5"
                >
                  {{ opt.description }}
                </div>
              </div>
            </div>
          </button>
        </div>

        <!-- 自由文本输入（用户可不选选项直接打字） -->
        <div class="px-4 pb-3">
          <textarea
            ref="textareaRef"
            v-model="freeText"
            rows="2"
            :placeholder="
              options.length > 0 ? '或直接输入你的想法（可不选上面的选项）…' : '输入你的回答…'
            "
            class="w-full bg-transparent font-chat text-[length:var(--chat-text-u1)] text-foreground px-3 py-2 rounded-md border border-border resize-none focus:outline-none focus:border-primary/50 placeholder:text-muted-foreground/60"
            @keydown="onKeyDown"
          />
        </div>

        <!-- footer -->
        <div class="px-4 py-2.5 border-t border-border flex items-center justify-between gap-2">
          <span class="text-[length:var(--chat-text-d1)] text-muted-foreground truncate">
            {{ canSubmit ? '回车提交 / Esc 跳过' : 'Esc 跳过（让 Claude 自行判断）' }}
          </span>
          <div class="flex gap-2 flex-shrink-0">
            <Button variant="outline" size="sm" @click="onSkip">跳过（Esc）</Button>
            <Button size="sm" :disabled="!canSubmit" @click="onSubmit">提交回答</Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button } from '@renderer/components/ui/button'
import { chatContentWidthClass } from '@renderer/lib/chat-layout'
import { useMessageStore } from '@renderer/stores/message'
import type { AgentAnswer } from '@shared/backend/types'
import { CheckIcon, MessageCircleQuestionIcon } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, ref } from 'vue'

const messageStore = useMessageStore()
defineProps<{ navRailVisible?: boolean }>()
const pending = computed(() => messageStore.pendingAgentQuestion!)
const question = computed(() => pending.value.question)
const options = computed(() => question.value.options ?? [])

/**
 * 选中状态：
 * - 单选：string | null（option label）
 * - 多选：Set<string>
 */
const selected = ref<string | null>(null)
const selectedMulti = ref<Set<string>>(new Set())
const freeText = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)

onMounted(() => {
  // 初始化选中状态
  if (question.value.multiSelect) {
    selectedMulti.value = new Set()
  } else {
    selected.value = null
  }
  window.addEventListener('keydown', onKey)
  // 自动聚焦输入框，方便直接打字
  setTimeout(() => textareaRef.value?.focus(), 0)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
})

function onToggleOption(label: string): void {
  if (question.value.multiSelect) {
    const set = new Set(selectedMulti.value)
    if (set.has(label)) set.delete(label)
    else set.add(label)
    selectedMulti.value = set
  } else {
    selected.value = selected.value === label ? null : label
  }
}

function isSelected(label: string): boolean {
  return question.value.multiSelect ? selectedMulti.value.has(label) : selected.value === label
}

/** 可提交：至少选了一个选项 或 填了自由文本 */
const canSubmit = computed(() => {
  const hasSelection = question.value.multiSelect
    ? selectedMulti.value.size > 0
    : selected.value !== null
  const hasFreeText = freeText.value.trim().length > 0
  return hasSelection || hasFreeText
})

function gatherAnswer(): AgentAnswer {
  const selectedLabels = question.value.multiSelect
    ? Array.from(selectedMulti.value)
    : selected.value !== null
      ? [selected.value]
      : []
  const trimmed = freeText.value.trim()
  return {
    selectedLabels,
    ...(trimmed.length > 0 ? { freeText: trimmed } : {}),
  }
}

async function respondAndClear(answer: AgentAnswer): Promise<void> {
  const p = pending.value
  if (!p) return
  await window.api.backend.respondQuestion({
    turnId: p.turnId,
    requestId: p.requestId,
    answer,
  })
  messageStore.pendingAgentQuestion = null
}

function onSubmit(): void {
  if (!canSubmit.value) return
  void respondAndClear(gatherAnswer())
}

/** 跳过：空答案回传，告诉模型用户跳过了 */
function onSkip(): void {
  void respondAndClear({ selectedLabels: [], freeText: '' })
}

function onKeyDown(e: KeyboardEvent): void {
  // textarea 内的键盘事件：Enter（无 Shift）提交，Esc 跳过
  if (e.key === 'Escape') {
    e.preventDefault()
    onSkip()
  }
}

/** 全局键盘：Esc 跳过；textarea 外的 Enter 也提交 */
function onKey(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null
  const inTextarea = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT'
  if (e.key === 'Escape') {
    e.preventDefault()
    onSkip()
  } else if (e.key === 'Enter' && !e.shiftKey && !inTextarea && canSubmit.value) {
    e.preventDefault()
    onSubmit()
  }
}
</script>
