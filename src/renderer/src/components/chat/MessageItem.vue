<template>
  <!--
    历史 /compact 条目：分隔线 + 可折叠摘要。
    全宽渲染——必须放在 <article> 外面，绕过 user 气泡的 max-w-[80%] /
    flex-row-reverse 约束，否则分隔线只占右侧 80%、文字看起来不居中。
    history-mapping 把 /compact + 摘要存成 user message（textBlocks[0]='/compact'），
    这里识别该模式并交给 CompactHistoryEntry 渲染（不再走 user 气泡布局）。
  -->
  <CompactHistoryEntry v-if="isCompactHistoryEntry" :summary="compactSummary" />

  <!--
    消息项布局：
    - user：靠右，单个淡灰气泡（bg-user-bubble，对齐 Claude Code #222222）
    - assistant：靠左，**时间轴布局**——左侧竖线 + 每个事件一个色点串起来
      （起始色点 + 每个 tool 一个色点），文本回复贴在竖线右侧
  -->
  <article
    v-else
    :class="['flex gap-3', message.role === 'user' ? 'flex-row-reverse' : 'flex-row']"
  >
    <!-- 消息体 -->
    <div :class="['min-w-0', message.role === 'user' ? 'max-w-[80%]' : 'flex-1']">
      <!--
        user 消息：合并成一个气泡（对齐 Claude Code）。

        气泡内布局：**上下两块**——
          1. 顶部 chip 区：所有附件 chip（IDE selection / opened file）聚成一组，
             flex-wrap 同行排列（多个 chip 横着排，溢出折行），整体作为一块
          2. 下方 prompt 文本：用户输入的核心 prompt，单独一块

        chip 是"用户引用了哪些文件"的上下文标识，作为一块放上方；
        文本是核心 prompt，自然占满下方。多 chip 之间用 gap-x-3 隔开（比 chip 内部
        紧凑，让 chip 组视觉上是一个整体）。

        hover 气泡时右下角浮出操作行：发送时间（最短化）+ 复制按钮。
        group/group-hover 控制：鼠标移开自动隐藏，不抢占视觉。
      -->
      <div
        v-if="message.role === 'user' && hasAnyUserContent"
        class="group relative rounded-2xl bg-user-bubble border border-border/50 p-3 flex flex-col gap-2 break-words"
      >
        <!--
          附件 chip 区（IDE selection / opened file）：多个 chip 聚成一组，
          flex-wrap 同行排列，溢出自动折行。整组在上方，跟下方 prompt 文本分块。
        -->
        <div
          v-if="(message.contextBlocks?.length ?? 0) > 0"
          class="flex flex-wrap items-center gap-x-3 gap-y-1"
        >
          <template v-for="(block, i) in message.contextBlocks ?? []" :key="`ctx-${i}`">
            <component
              :is="resolveContextComponent(block.tag)"
              v-if="resolveContextComponent(block.tag)"
              :data="block.data"
            />
          </template>
        </div>

        <!-- 用户文本（whitespace-pre-wrap 保留换行） -->
        <template v-for="block in message.textBlocks" :key="block.id">
          <div
            v-if="block.text.trim()"
            class="leading-relaxed text-[15px] text-foreground whitespace-pre-wrap break-words"
          >
            {{ block.text }}
          </div>
        </template>

        <!-- hover 浮出的操作行：时间 + 复制 -->
        <div
          class="absolute right-2 -bottom-6 flex items-center gap-1.5 text-[11px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
        >
          <span>{{ formattedTime }}</span>
          <button
            type="button"
            class="pointer-events-auto p-0.5 rounded hover:text-foreground hover:bg-muted/60 transition-colors"
            :title="copied ? '已复制' : '复制'"
            @click="onCopy"
          >
            <component :is="copied ? CheckIcon : CopyIcon" class="w-3 h-3" />
          </button>
        </div>
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
      <div v-else-if="message.role === 'assistant'" class="relative pl-6 border-l border-border/40">
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
          <ToolCallCard
            v-else
            :tool="tool"
            :cwd="cwd ?? ''"
            :show-thinking="showThinking ?? true"
          />
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
          :duration-sec="reasoningDurationSec(block)"
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
import { formatMessageTime } from '@renderer/lib/format'
import { useMessageStore } from '@renderer/stores/message'
import type { NormalizedMessage } from '@shared/backend/types'
import { CheckIcon, CopyIcon } from 'lucide-vue-next'
import { computed, ref } from 'vue'

import CompactHistoryEntry from './CompactHistoryEntry.vue'
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
  /** 工作区目录--子 agent 读 jsonl 需要 */
  cwd?: string
}>()

/** 按 tag 名从注册表查 component。加新 tag 不用改这里。 */
function resolveContextComponent(tag: string) {
  return contextTagRegistry.get(tag)?.component
}

/**
 * 检测这条消息是否是历史回放的 /compact 条目。
 *
 * history-mapping 把 /compact + 摘要存成 user message：
 *   textBlocks[0].text === '/compact'
 *   textBlocks[1].text === 摘要原文（可选，无摘要时只有 textBlocks[0]）
 *
 * 命中时 UI 不渲染用户气泡，交给 CompactHistoryEntry 渲染分隔线 + 可折叠摘要。
 */
const isCompactHistoryEntry = computed(() => {
  if (props.message.role !== 'user') return false
  const first = props.message.textBlocks?.[0]
  return first?.text === '/compact'
})

/** /compact 的压缩摘要原文（textBlocks[1]），无摘要时 undefined */
const compactSummary = computed(() => props.message.textBlocks?.[1]?.text)

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
 *
 * 两个必要条件都满足才认为还在思考：
 *   1. 当前 turn 正在跑（isRunning && turnId === currentTurnId）——
 *      历史消息反推的 reasoning 块没有 endedAt（磁盘 jsonl 不带这个字段），
 *      光看 endedAt === undefined 会把所有历史消息误判成"还在思考"。
 *      必须叠加 turn 在跑的判据把历史排除掉。
 *   2. 该 reasoning 块没有 endedAt（turn 还没写结束标记）——
 *      endedAt 在以下任一事件触发时被写入（见 markReasoningEnded）：
 *        - text_delta（正文开始）
 *        - tool_call_started（开始调工具 = 这轮想清楚了）
 *        - turn_completed / error（兜底）
 *      没写就说明这三类后续事件都还没到，思考确实还在进行。
 */
function isReasoningStreaming(block: TextBlock): boolean {
  if (!messageStore.isRunning) return false
  if (props.message.turnId !== messageStore.currentTurnId) return false
  return block.endedAt === undefined
}

/**
 * 思考耗时（秒）。取 startedAt → endedAt 的差值。
 * 任一字段缺失（历史消息反推时可能没有）→ 返回 null，UI 不显示时长。
 */
function reasoningDurationSec(block: TextBlock): number | null {
  if (block.startedAt === undefined || block.endedAt === undefined) return null
  return Math.max(0, (block.endedAt - block.startedAt) / 1000)
}

/** user 消息是否至少有一个可见内容。 */
const hasAnyUserContent = computed(() => {
  if (props.message.contextBlocks && props.message.contextBlocks.length > 0) return true
  return (props.message.textBlocks ?? []).some((b) => b.text.trim().length > 0)
})

/** user 气泡 hover 时显示的发送时间（最短化格式）。 */
const formattedTime = computed(() => formatMessageTime(props.message.createdAt))

/** 复制按钮：1.5s 内显示"已复制"对勾反馈 */
const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | null = null

/** 复制 user 消息正文：拼所有 text 块，用空行分隔多个 block。 */
function onCopy(): void {
  const text = (props.message.textBlocks ?? [])
    .filter((b) => b.kind === 'text' && b.text.trim())
    .map((b) => b.text)
    .join('\n\n')
  if (!text) return
  void navigator.clipboard.writeText(text).then(
    () => {
      copied.value = true
      if (copyTimer) clearTimeout(copyTimer)
      copyTimer = setTimeout(() => {
        copied.value = false
      }, 1500)
    },
    () => {
      // 剪贴板权限被拒或不可用--忽略
    },
  )
}

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
