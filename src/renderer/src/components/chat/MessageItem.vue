<template>
  <!--
    消息项布局：
    - user：靠右，单个淡灰气泡（bg-user-bubble，对齐 Claude Code #222222）
    - assistant：靠左，**时间轴布局**——左侧竖线 + 每个事件一个色点串起来
      （起始色点 + 每个 tool 一个色点），文本回复贴在竖线右侧
  -->
  <article :class="['flex gap-3', message.role === 'user' ? 'flex-row-reverse' : 'flex-row']">
    <!-- 消息体 -->
    <div :class="['min-w-0', message.role === 'user' ? 'max-w-[80%]' : 'flex-1']">
      <!--
        user 消息：合并成一个气泡。
        气泡内布局：上附件（contextBlocks） / 下文本（textBlocks）。
        气泡本身用淡灰背景（bg-user-bubble，Claude Code 风）。
      -->
      <div
        v-if="message.role === 'user' && hasAnyUserContent"
        class="rounded-2xl bg-user-bubble border border-border/50 p-3 flex flex-col gap-2 break-words"
      >
        <template v-for="(block, i) in message.contextBlocks ?? []" :key="`ctx-${i}`">
          <component
            :is="resolveContextComponent(block.tag)"
            v-if="resolveContextComponent(block.tag)"
            :data="block.data"
          />
        </template>

        <template v-for="block in message.textBlocks" :key="block.id">
          <div
            v-if="block.text.trim()"
            :class="[
              'leading-relaxed text-[15px]',
              block.kind === 'reasoning' ? 'italic text-muted-foreground' : 'text-foreground',
            ]"
          >
            <MarkdownView :text="block.text" />
          </div>
        </template>
      </div>

      <!--
        assistant 消息：时间轴布局。

        左侧 border-l 是竖线，**只有 1 个起始色点**（不再每个 tool 单独色点），
        表示这条 assistant 消息的整体状态：
          - 灰色 = 纯文本回复（无工具调用）
          - 绿色 = 有工具调用且全部完成
          - 绿色脉冲 = 运行中（有工具 running 或流式输出）
          - 红色 = 有工具失败
      -->
      <div v-else class="relative pl-6 border-l border-border/40">
        <!-- 唯一的起始色点 -->
        <span
          :class="['absolute w-2 h-2 rounded-full -left-[5px] top-1.5', assistantStatusClass]"
          :title="assistantStatusTooltip"
        />

        <!-- toolBlocks：贴竖线渲染，不各自带色点 -->
        <div
          v-for="(tool, i) in message.toolBlocks ?? []"
          :key="tool.id"
          :class="i === 0 ? 'mt-1' : 'mt-2'"
        >
          <!-- Read 内联渲染（file_read + title "Read: ..."） -->
          <ToolCallInline v-if="isInlineTool(tool)" :tool="tool" />
          <!-- 其他工具走卡片 -->
          <ToolCallCard v-else :tool="tool" />
        </div>

        <!--
          textBlocks 分两路渲染：

          1. reasoning 块 → ThinkingBlock（可折叠披露，对齐 Claude Code）
             实时流式时 header 显示 "thinking..." 动画，完成态显示 "已思考 ▾"。
             showThinking=false 时整个跳过（用户已通过 effort=none 关闭思考）。
          2. text 块 → 原本内联渲染（保留 text-[15px] 文本样式）
        -->
        <ThinkingBlock
          v-for="block in reasoningBlocks"
          :key="block.id"
          :text="block.text"
          :streaming="isReasoningStreaming(block)"
        />

        <!-- text 块：贴竖线渲染，无独立色点 -->
        <div
          v-for="(block, i) in textBlocks"
          :key="block.id"
          :class="[
            reasoningBlocks.length > 0 || (message.toolBlocks?.length ?? 0) > 0 || i > 0
              ? 'mt-2'
              : '',
          ]"
        >
          <MarkdownView
            v-if="block.text.trim()"
            :text="block.text"
            :class="['leading-relaxed text-[15px]']"
          />
        </div>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { contextTagRegistry } from '@renderer/lib/context-tag-registry'
import { useMessageStore } from '@renderer/stores/message'
import type { NormalizedMessage } from '@shared/backend/types'
import { computed } from 'vue'

import MarkdownView from './MarkdownView.vue'
import ThinkingBlock from './ThinkingBlock.vue'
import ToolCallCard from './ToolCallCard.vue'
import ToolCallInline from './ToolCallInline.vue'

type TextBlock = NonNullable<NormalizedMessage['textBlocks']>[number]

const messageStore = useMessageStore()

const props = defineProps<{
  message: NormalizedMessage
  /** 是否显示思考块（reasoning）。false 时过滤掉 kind='reasoning' 的 textBlocks。 */
  showThinking?: boolean
}>()

/** 按 tag 名从注册表查 component。加新 tag 不用改这里。 */
function resolveContextComponent(tag: string) {
  return contextTagRegistry.get(tag)?.component
}

/**
 * reasoning 块（kind==='reasoning'）。
 * showThinking=false 时返回空数组（effort=none 已关闭思考，UI 完全不显示）。
 */
const reasoningBlocks = computed<TextBlock[]>(() => {
  if (props.showThinking === false) return []
  return (props.message.textBlocks ?? []).filter((b) => b.kind === 'reasoning' && b.text.trim())
})

/** text 块（kind==='text'）——普通正文 */
const textBlocks = computed<TextBlock[]>(() =>
  (props.message.textBlocks ?? []).filter((b) => b.kind === 'text'),
)

/**
 * 判断某条 reasoning 块是否还在实时流式输出。

 * 判据：当前 turn 正在跑（isRunning && turnId === currentTurnId），
 * 且这条 reasoning 块是该 turn 的最后一个非空 textBlock——
 * 后面还没有 text 块跟上来，说明模型还在产 reasoning token，没切换到正文。
 *
 * 一旦正文（text_delta）开始累积，reasoning 块不再是"最后一个"，
 * streaming 判定自动转 false，header 切到静态 "已思考 ▾"。
 */
function isReasoningStreaming(block: TextBlock): boolean {
  if (!messageStore.isRunning) return false
  if (props.message.turnId !== messageStore.currentTurnId) return false
  const blocks = (props.message.textBlocks ?? []).filter((b) => b.text.trim())
  const last = blocks[blocks.length - 1]
  return last !== undefined && last.id === block.id
}

/** user 消息是否至少有一个可见内容。 */
const hasAnyUserContent = computed(() => {
  if (props.message.contextBlocks && props.message.contextBlocks.length > 0) return true
  return (props.message.textBlocks ?? []).some((b) => b.text.trim().length > 0)
})

/**
 * 判定一个工具是否内联渲染（不显示卡片）。
 *
 * 当前规则：只有 claude Read 工具（kind=file_read + title "Read: ..."）走内联。
 * Glob / Grep 虽然也是 file_read，但 title 是 "Glob: ..."/"Grep: ..."，仍走卡片。
 */
function isInlineTool(tool: NonNullable<NormalizedMessage['toolBlocks']>[number]): boolean {
  return tool.info.kind === 'file_read' && /^Read:/.test(tool.info.title)
}

/**
 * assistant 起始色点的状态——按 toolBlocks 聚合：
 *   - 无 toolBlocks → 'text'（纯文本回复，灰色稳态）
 *   - 有任意 running → 'running'（绿色脉冲）
 *   - 有任意 failed / output.ok === false → 'failed'（红色稳态）
 *   - 否则全 completed + ok → 'completed'（绿色稳态）
 */
const assistantStatus = computed<'text' | 'running' | 'completed' | 'failed'>(() => {
  const tools = props.message.toolBlocks ?? []
  if (tools.length === 0) return 'text'
  if (tools.some((t) => t.status === 'running')) return 'running'
  if (
    tools.some((t) => t.status === 'failed' || (t.status === 'completed' && t.output?.ok === false))
  ) {
    return 'failed'
  }
  return 'completed'
})

const assistantStatusClass = computed(() => statusDotClass(assistantStatus.value))
const assistantStatusTooltip = computed(() => statusTooltip(assistantStatus.value))

/**
 * 色点 class：
 *   - text（纯文本）：灰色稳态
 *   - running：绿色脉冲
 *   - completed：绿色稳态
 *   - failed：红色稳态
 */
function statusDotClass(status: 'text' | 'running' | 'completed' | 'failed'): string {
  switch (status) {
    case 'text':
      return 'bg-muted-foreground'
    case 'running':
      return 'bg-success animate-pulse'
    case 'failed':
      return 'bg-destructive'
    default:
      return 'bg-success'
  }
}

function statusTooltip(status: 'text' | 'running' | 'completed' | 'failed'): string {
  switch (status) {
    case 'text':
      return '文本回复'
    case 'running':
      return '运行中'
    case 'failed':
      return '出错'
    default:
      return '完成'
  }
}
</script>
