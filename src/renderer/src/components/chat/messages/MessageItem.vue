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
    历史「用户中断」条目：history-mapping 把 Claude SDK 写入的中断 sentinel
    （`[Request interrupted by user]` / `... for tool use]`）构造成 role:'user' +
    textBlocks[0].text=原文。这里识别该模式并交给 InterruptedHistoryEntry 渲染
    （不再走 user 气泡布局）——复刻 /compact 的拦截渲染模式。
  -->
  <InterruptedHistoryEntry v-else-if="isInterruptedEntry" :variant="interruptVariant" />

  <!--
    消息项布局：
    - user：靠右，单个淡灰气泡（bg-user-bubble，对齐 Claude Code #222222）
    - assistant：靠左，**时间轴布局**——左侧竖线 + 每个事件一个色点串起来
      （起始色点 + 每个 tool 一个色点），文本回复贴在竖线右侧
  -->
  <article
    v-else
    v-message-anchor="messageAnchorId"
    :data-message-id="messageAnchorId ?? undefined"
    :class="[
      'flex gap-3 scroll-mt-2',
      message.role === 'user'
        ? // user 消息:靠右。
          // mt-4 补 assistant→user 方向的间距（上一轮回复 → 这一轮提问）；
          // user→assistant 方向靠 mb-4。连续 assistant 之间仍零间距，竖线不断。
          // first:mt-0：对话首条通常是 user 提问，去掉顶部 margin 避免与容器 py-4 叠加。
          'flex-row-reverse mb-4 mt-4 first:mt-0'
        : 'flex-row relative border-l-2 border-border/60 pt-3',
      // 首尾遮罩按**每一轮**算（不是整个会话的首尾）：本轮首条遮色点上方，
      // 本轮末条遮色点下方；两者必须能同时生效——本轮只有一条 assistant
      // （含仅 thinking）时整条连线隐藏，只剩色点。
      {
        'mask-line-top': message.role === 'assistant' && isTurnFirstAssistant,
        'mask-line-bottom': message.role === 'assistant' && isTurnLastAssistant,
      },
    ]"
  >
    <!-- assistant 起始色点:相对 article 定位,中心对齐 border-l 竖线 + 第一行文字中线。
         -left-[5px]:8px 色点中心落在 2px border 中心(半径4 - border一半1 = 3,负方向)。
         top:对齐第一行文字中线。pt-3 让内容下移 12px，色点 top 为 18px。 -->
    <span
      v-if="message.role === 'assistant'"
      :class="[
        'absolute w-2 h-2 rounded-full -left-[5px] top-[18px] z-10 ring-2 ring-background',
        assistantStatusClass,
      ]"
      :title="assistantStatusTooltip"
    />
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
        <div v-if="contextBlocks.length > 0" class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <component
            :is="getBlockRenderer(block.type)"
            v-for="block in contextBlocks"
            :key="block.id"
            :block="block"
          />
        </div>

        <!-- 用户文本（whitespace-pre-wrap 保留换行） -->
        <component
          :is="getBlockRenderer(block.type)"
          v-for="block in textBlocks"
          :key="block.id"
          :block="block"
          message-role="user"
        />

        <!-- hover 浮出的操作行：时间 + 复制 -->
        <div
          class="absolute right-2 -bottom-6 flex items-center gap-1.5 text-[length:var(--chat-text-d2)] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
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
      <div v-else-if="message.role === 'assistant'" class="relative pl-6 -ml-0.5">
        <!-- 色点已移到 article 层(见上方),这里直接渲染 blocks -->

        <!-- toolBlocks：贴竖线渲染，不各自带色点 -->
        <component
          v-for="block in assistantBlocks"
          :key="block.id"
          :is="getBlockRenderer(block.type)"
          :block="block"
          :cwd="cwd"
          :show-thinking="showThinking"
          :message-role="message.role"
          :streaming="block.type === 'reasoning' ? isReasoningStreaming(block) : undefined"
          :duration-sec="block.type === 'reasoning' ? reasoningDurationSec(block) : undefined"
          class="mt-2 first:mt-0"
        />
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { useMessageAnchorDirective } from '@renderer/composables/useMessageAnchors'
import { formatMessageTime } from '@renderer/lib/format'
import { isNavigableUserMessage } from '@renderer/lib/message-navigation'
import { useMessageStore } from '@renderer/stores/message'
import type {
  ContextContentBlock,
  ReasoningContentBlock,
  TextContentBlock,
  ToolCallContentBlock,
} from '@shared/backend/blocks'
import { matchInterruptMarker } from '@shared/backend/interrupt-marker'
import { messageBlocks } from '@shared/backend/normalize-blocks'
import type { NormalizedMessage } from '@shared/backend/types'
import { CheckIcon, CopyIcon } from 'lucide-vue-next'
import { computed, ref } from 'vue'

import { getBlockRenderer } from '../blocks/registry'

import CompactHistoryEntry from './CompactHistoryEntry.vue'
import InterruptedHistoryEntry from './InterruptedHistoryEntry.vue'

type TextBlock = ReasoningContentBlock

const messageStore = useMessageStore()
const vMessageAnchor = useMessageAnchorDirective()

const props = defineProps<{
  message: NormalizedMessage
  /** 是否显示思考块（reasoning）。false 时过滤掉 kind='reasoning' 的 textBlocks。 */
  showThinking?: boolean
  /** 工作区目录--子 agent 读 jsonl 需要 */
  cwd?: string
  /** 是否是**本轮**最后一条 assistant——是则遮住色点下方的竖线段(本轮时间轴到此终止) */
  isTurnLastAssistant?: boolean
  /** 是否是**本轮**第一条 assistant——是则遮住色点上方的竖线段(上方接 user,无需延伸到色点之上) */
  isTurnFirstAssistant?: boolean
}>()
const messageAnchorId = computed(() =>
  isNavigableUserMessage(props.message) ? props.message.id : null,
)

const blocks = computed(() => messageBlocks(props.message))
const contextBlocks = computed(() =>
  blocks.value.filter((block): block is ContextContentBlock => block.type === 'context'),
)
const assistantBlocks = computed(() =>
  blocks.value.filter((block) => block.type !== 'context' && block.type !== 'compact_divider'),
)

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
  const first = blocks.value.find((block) => block.type === 'text')
  return first?.type === 'text' && first.text === '/compact'
})

/** /compact 的压缩摘要原文（textBlocks[1]），无摘要时 undefined */
const compactSummary = computed(() => {
  const texts = blocks.value.filter((block): block is TextContentBlock => block.type === 'text')
  return texts[1]?.text
})

/**
 * 检测这条消息是否是历史回放的中断 sentinel——Claude SDK 写入 transcript 的
 * `[Request interrupted by user]` / `[Request interrupted by user for tool use]`。
 * history-mapping 把它构造成 role:'user' + 首个 text block 文本 = 原文。
 * 命中时 UI 不渲染用户气泡，交给 InterruptedHistoryEntry 用居中胶囊样式渲染。
 */
const interruptMatch = computed(() => {
  if (props.message.role !== 'user') return null
  const first = blocks.value.find((block) => block.type === 'text')
  if (first?.type !== 'text') return null
  return matchInterruptMarker(first.text)
})
const isInterruptedEntry = computed(() => interruptMatch.value !== null)
const interruptVariant = computed(() => interruptMatch.value?.variant ?? 'user')

/**
 * reasoning 块（kind==='reasoning'）。
 * showThinking=false 时返回空数组（effort=none 已关闭思考，UI 完全不显示）。
 */
/** text 块（kind==='text'）——普通正文 */
const textBlocks = computed<TextContentBlock[]>(() =>
  blocks.value.filter((block): block is TextContentBlock => block.type === 'text'),
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
  if (block.durationMs !== undefined) return Math.max(0, block.durationMs / 1000)
  if (block.startedAt === undefined || block.endedAt === undefined) return null
  return Math.max(0, (block.endedAt - block.startedAt) / 1000)
}

/** user 消息是否至少有一个可见内容。 */
const hasAnyUserContent = computed(() => {
  if (contextBlocks.value.length > 0) return true
  return textBlocks.value.some((b) => b.text.trim().length > 0)
})

/** user 气泡 hover 时显示的发送时间（最短化格式）。 */
const formattedTime = computed(() => formatMessageTime(props.message.createdAt))

/** 复制按钮：1.5s 内显示"已复制"对勾反馈 */
const copied = ref(false)
let copyTimer: ReturnType<typeof setTimeout> | null = null

/** 复制 user 消息正文：拼所有 text 块，用空行分隔多个 block。 */
function onCopy(): void {
  const text = textBlocks.value
    .filter((b) => b.text.trim())
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
/**
 * assistant 起始色点的状态——按 toolBlocks 聚合：
 *   - 无 toolBlocks → 'text'（纯文本回复，灰色稳态）
 *   - 有任意 running → 'running'（绿色脉冲）
 *   - 有任意 failed / output.ok === false → 'failed'（红色稳态）
 *   - 否则全 completed + ok → 'completed'（绿色稳态）
 */
const assistantStatus = computed<'text' | 'running' | 'completed' | 'failed'>(() => {
  const tools = blocks.value.filter(
    (block): block is ToolCallContentBlock => block.type === 'tool_call',
  )
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

<style scoped>
/*
 * mask-line-top:**本轮**第一条 assistant 消息用。
 * border-l 竖线从 article 顶部开始画,但本轮首条 assistant 上方接的是 user 消息,
 * 竖线不该延伸到色点之上。用 ::before 伪元素盖住色点上方(0 ~ 22px)的 border 段。
 * 22px = 色点 top(18px) + 色点半径(4px),即盖到色点中心位置。
 * 背景色跟随 --color-background,保证暗/亮主题下都与页面融合。
 */
.mask-line-top::before {
  content: '';
  position: absolute;
  left: -2px; /* 对齐 border-l 的位置(2px 宽) */
  top: 0;
  width: 2px;
  height: 22px;
  background-color: var(--color-background);
  z-index: 5; /* 在 border 之上,色点(z-10)之下 */
}

/*
 * mask-line-bottom:**本轮**最后一条 assistant 消息用。
 * 本轮时间轴到末端的色点处应终止,色点下方不再画竖线。
 * ::after 覆盖色点下方(22px ~ 底部)的 border 段。
 * top 22px 起始(色点中心),height 100% - 22px 用 calc 算,
 * 或者直接 top: 22px; bottom: 0; 让浏览器撑满。
 * 与顶部的 ::before 分开，确保单条 assistant 可同时遮住点的上下两侧。
 */
.mask-line-bottom::after {
  content: '';
  position: absolute;
  left: -2px;
  top: 22px;
  bottom: 0;
  width: 2px;
  background-color: var(--color-background);
  z-index: 5;
}
</style>
