<template>
  <!--
    AskUserQuestion 弹窗（Claude Code 风）——claude 调 AskUserQuestion 时弹出。

    驱动：messageStore.pendingQuestion（由 backend 推 ask_user_question TurnEvent 设置）。
    提交时 emit('submit', text)，ChatView 把 text 当新 user 消息发下一轮 turn
    （claude -p 模式不接受外部 tool_result 回写，所以走新一轮 turn 继续 --resume）。

    支持的 question 形态（参考 claude 官方文档）：
    - 1-4 个 question
    - 每个 question 2-4 个 option
    - 每个 question 有 multiSelect 标记（单选/多选）
    - option 有 label + description

    提交按钮 enable 条件：所有 question 至少选了一个 option。
    Esc 键 / 点遮罩 / 取消按钮 → emit('cancel')，ChatView 清 pendingQuestion。
  -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    @click.self="onCancel"
  >
    <div
      class="bg-card text-card-foreground rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] flex flex-col"
    >
      <!-- header -->
      <div class="p-4 border-b border-border flex items-center gap-2">
        <MessageCircleQuestionIcon class="w-5 h-5 text-primary flex-shrink-0" />
        <h3 class="text-base font-semibold flex-1">
          Claude 想问你 {{ pending.questions.length }} 个问题
        </h3>
        <button
          class="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground"
          title="取消"
          @click="onCancel"
        >
          <XIcon class="w-4 h-4" />
        </button>
      </div>

      <!-- body，可滚 -->
      <div class="p-4 flex-1 overflow-y-auto space-y-4">
        <div
          v-for="(q, i) in pending.questions"
          :key="i"
          class="border border-border/60 rounded-md p-3"
        >
          <div class="flex items-center gap-2 mb-1.5">
            <span
              class="text-[10px] font-mono uppercase tracking-wide text-muted-foreground bg-muted px-1.5 py-0.5 rounded"
            >
              {{ q.header || `Q${i + 1}` }}
            </span>
            <span v-if="q.multiSelect" class="text-[10px] text-muted-foreground italic">
              可多选
            </span>
          </div>
          <div class="text-sm font-medium text-foreground mb-2">{{ q.question }}</div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              v-for="(opt, j) in q.options"
              :key="j"
              type="button"
              :class="[
                'text-left rounded-md border px-3 py-2 transition-colors',
                isSelected(q.header, opt.label)
                  ? 'border-primary bg-primary/10'
                  : 'border-border hover:border-primary/50 hover:bg-muted/50',
              ]"
              @click="onOptionClick(q, opt.label)"
            >
              <div class="flex items-start gap-1.5">
                <CheckIcon
                  v-if="isSelected(q.header, opt.label)"
                  class="w-3.5 h-3.5 text-primary flex-shrink-0 mt-0.5"
                />
                <div v-else class="w-3.5 h-3.5 flex-shrink-0 mt-0.5"></div>
                <div class="flex-1 min-w-0">
                  <div class="text-[13px] font-medium text-foreground">{{ opt.label }}</div>
                  <div v-if="opt.description" class="text-[11px] text-muted-foreground mt-0.5">
                    {{ opt.description }}
                  </div>
                </div>
              </div>
            </button>
          </div>
        </div>
      </div>

      <!-- footer -->
      <div class="p-4 border-t border-border flex items-center justify-between gap-2">
        <span class="text-xs text-muted-foreground">
          {{ allAnswered ? '回车提交 / Esc 取消' : '请回答所有问题' }}
        </span>
        <div class="flex gap-2">
          <Button variant="outline" size="sm" @click="onCancel">取消</Button>
          <Button size="sm" :disabled="!allAnswered" @click="onSubmit">提交回答</Button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button } from '@renderer/components/ui/button'
import { useMessageStore } from '@renderer/stores/message'
import type { ToolControlQuestion } from '@shared/backend/types'
import { CheckIcon, MessageCircleQuestionIcon, XIcon } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted, reactive } from 'vue'

const messageStore = useMessageStore()
const pending = computed(() => messageStore.pendingQuestion!)

const emit = defineEmits<{
  /** 用户提交——payload 是拼好的自然语言回答文本 */
  submit: [text: string]
  /** 用户取消（Esc / 遮罩 / 取消按钮） */
  cancel: []
}>()

/**
 * 每个 question 的回答状态：
 * - 单选：string（option label）
 * - 多选：Set<string>（option labels）
 *
 * 用 reactive 对象（key = question.header）触发响应式。
 * header 在 claude input 里要求唯一，做 key 安全。
 * 万一 header 为空字符串，加 index 后缀避免碰撞。
 */
type AnswerValue = string | Set<string>
const answers = reactive<Record<string, AnswerValue>>({})

/** header 可能重复或为空——加 index 后缀保证 key 唯一 */
function questionKey(q: ToolControlQuestion, index: number): string {
  return q.header ? `${index}-${q.header}` : `q${index}`
}

onMounted(() => {
  pending.value.questions.forEach((q, i) => {
    const key = questionKey(q, i)
    answers[key] = q.multiSelect ? new Set<string>() : ''
  })
  window.addEventListener('keydown', onKey)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
})

function onOptionClick(q: ToolControlQuestion, label: string): void {
  // pending.questions 的 index 需要重新查（避免闭包陷阱）
  const idx = pending.value.questions.indexOf(q)
  if (idx < 0) return
  const key = questionKey(q, idx)
  if (q.multiSelect) {
    const set = answers[key] as Set<string>
    if (set.has(label)) set.delete(label)
    else set.add(label)
    // trigger reactivity——Set mutation 不会触发，需要重新赋值
    answers[key] = new Set(set)
  } else {
    answers[key] = label
  }
}

function isSelected(header: string, label: string): boolean {
  // header 是 question.header（不是 key），需要查 key
  const idx = pending.value.questions.findIndex((q) => q.header === header)
  if (idx < 0) return false
  const q = pending.value.questions[idx]
  if (!q) return false
  const key = questionKey(q, idx)
  const v = answers[key]
  if (typeof v === 'string') return v === label
  if (v instanceof Set) return v.has(label)
  return false
}

/** 是否所有 question 都至少答了一个 option */
const allAnswered = computed(() =>
  pending.value.questions.every((q, i) => {
    const v = answers[questionKey(q, i)]
    if (typeof v === 'string') return v !== ''
    if (v instanceof Set) return v.size > 0
    return false
  }),
)

function onSubmit(): void {
  if (!allAnswered.value) return
  // 把 answers 拼成自然语言——每个 question 一行：[header] answer
  // 多选答案用 ", " 拼接
  const lines: string[] = pending.value.questions.map((q, i) => {
    const v = answers[questionKey(q, i)]
    let answerStr: string
    if (typeof v === 'string') answerStr = v
    else if (v instanceof Set) answerStr = Array.from(v).join(', ')
    else answerStr = ''
    const prefix = q.header || q.question
    return `[${prefix}] ${answerStr}`
  })
  emit('submit', lines.join('\n'))
}

function onCancel(): void {
  emit('cancel')
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    onCancel()
  } else if (e.key === 'Enter' && allAnswered.value) {
    // Cmd/Ctrl+Enter 或直接 Enter（不在 textarea 里）都触发提交
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return
    e.preventDefault()
    onSubmit()
  }
}
</script>
