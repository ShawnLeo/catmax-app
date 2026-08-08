<template>
  <!--
    根层负责给侧轨提供定位上下文；内部滚动容器继续负责原有 sticky 按钮与滚动逻辑。

    ChatView 给 MessageList 传 class=\"flex-1\"，合并到这个根 div 上。
    flex-1 在 flex-col 父容器里占满剩余高度；min-h-0 让它能正确 shrink
    （flex item 默认 min-height: auto 会撑爆，必须加 min-h-0 才能触发 overflow）。

    悬浮按钮用 sticky 而不是 absolute——sticky 在滚动容器里会贴视口底部，
    不会随内容滚走（absolute 会，fixed 会脱离容器跑到窗口级别）。
  -->
  <div class="relative h-full min-h-0">
    <div ref="container" class="relative h-full min-h-0 overflow-y-auto" @scroll="onScroll">
      <div
        v-if="messageStore.loading"
        class="flex items-center justify-center h-full text-muted-foreground"
      >
        <div class="text-center">
          <div class="animate-pulse text-[length:var(--chat-text-u1)]">加载历史中...</div>
        </div>
      </div>
      <!--
      响应式宽度：
        侧轨显示      → 内容区总宽度减 40px，给左侧导航留出独立空间
        侧轨隐藏      → 恢复 w-full
        小窗 <640px   → 跟随窗口（仅 px-6 边距）
        sm ≥640px     → 768px (max-w-3xl)
        lg ≥1024px    → 1024px (max-w-screen-lg)
        xl ≥1280px    → 1280px
        2xl ≥1536px   → 1440px（终极上限，超宽屏不会再变宽）
      mx-auto 居中。最大宽度与 Composer 保持一致；仅侧轨显示时额外扣除导航宽度。
    -->
      <div v-else ref="conversation" :class="conversationClass">
        <component
          :is="backendConversationRenderer"
          v-if="backendConversationRenderer"
          :messages="messageStore.messages"
          :show-thinking="showThinking"
          :cwd="cwd"
          :running="messageStore.isRunning"
          :current-turn-id="messageStore.currentTurnId"
        />
        <template v-else>
          <!--
          Turn Changes Card: 每轮末尾挂一张「本轮改了哪些文件」，点进去是右侧审查面板。
          codex 由它自己的 CodexTurn 渲染同一个组件；这里覆盖的是没有专属会话渲染器的
          后端（claude 及后续新增的），改动数据由 lib/review.ts 从工具调用现推。
        -->
          <template v-for="(message, index) in renderMessages" :key="message.id">
            <MessageItem
              :message="message"
              :show-thinking="showThinking"
              :cwd="cwd"
              :is-turn-last-assistant="assistantTimelineEdges.last.has(index)"
              :is-turn-first-assistant="assistantTimelineEdges.first.has(index)"
            />
            <ChangesCard
              v-if="turnChanges.get(index)"
              :files="turnChanges.get(index)!.files"
              :stats="turnChanges.get(index)!.stats"
            />
          </template>
        </template>

        <!--
        /compact 分隔线：用户发 /compact 时不展示 /compact 消息气泡，
        改为在消息流末尾插入这条分隔线。
        - pending（呼吸）：claude 后台正在压缩上下文
        - done（静态）：压缩完成，分隔线上下的对话被压缩隔离
        compactState 由 messageStore 跟踪（turn_completed 自动切 pending → done）。
      -->
        <CompactDivider v-if="messageStore.compactState" :state="messageStore.compactState" />

        <!--
        agent 工作中指示器——消息流底部的一行"正在干活"反馈。

        显示条件：turn 正在跑（isRunning）且没卡在等用户输入
        （pendingApproval / pendingClaudePermission / pendingAgentQuestion 都是 null）。
        等用户确认权限 / 回答问题时 agent 是暂停的，这时显示"正在工作"会误导。

        从用户点发送（markTurnStarting 乐观置 isRunning=true）一直到 turn_completed
        全程显示，覆盖了"发出消息到首个 thinking/文本出现"这段原本无反馈的空窗期。

        样式跟 assistant 消息的时间轴一致：左侧竖线 + 色点（绿色脉冲 = running），
        让它视觉上属于 assistant 侧的对话流，而不是一个突兀的浮层。
      -->
        <div v-if="agentWorking && !backendConversationRenderer" class="flex gap-3 flex-row mt-3">
          <div class="min-w-0 flex-1">
            <div class="relative pl-6 border-l-2 border-border/60">
              <span
                class="absolute w-2 h-2 rounded-full -left-[6px] top-1.5 bg-success animate-pulse"
              />
              <!--
                items-center 整体垂直居中。图标、文字间距、三点和垂直补偿都基于 em，
                跟随 settings.theme.chatFontSize；三点内部再用 clamp 限制过大/过小。
              -->
              <div
                class="flex items-center text-[length:var(--chat-text-base)] text-muted-foreground"
              >
                <Loader2Icon class="size-[1.05em] flex-shrink-0 mr-[0.6em] animate-spin" />
                <span class="mr-[0.3em]">正在思考</span>
                <LoadingDots
                  class="text-muted-foreground"
                  style="transform: translateY(clamp(2px, 0.2em, 3.5px))"
                  :duration="1.6"
                />
              </div>
            </div>
          </div>
        </div>

        <!-- 错误提示（codex/claude 调 API 失败时 messageStore.lastError 会被设置） -->
        <div
          v-if="messageStore.lastError"
          class="mt-3 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-[length:var(--chat-text-u1)] text-destructive whitespace-pre-wrap"
        >
          <div class="flex items-start gap-2">
            <AlertCircleIcon class="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div class="flex-1 min-w-0">
              <div class="font-medium mb-1">出错了</div>
              <div class="text-[length:var(--chat-text-d1)]">{{ messageStore.lastError }}</div>
            </div>
          </div>
        </div>
      </div>

      <!--
      悬浮"回到底部"箭头：用户向上滚离底部超过阈值（120px）时显示，
      点击平滑滚到最新消息。

      用 sticky bottom-4——在滚动容器里贴视口底部，不会随内容滚走。
      水平居中（mx-auto + max-w-fit + 左右 margin auto）。
      半透明悬浮效果：bg-background/80 + backdrop-blur + shadow-lg + border，
      hover 时背景更实（bg-background）+ 轻微上浮。
    -->
      <Transition
        enter-active-class="transition-all duration-200 ease-out"
        leave-active-class="transition-all duration-150 ease-in"
        enter-from-class="opacity-0 translate-y-2"
        leave-to-class="opacity-0 translate-y-2"
      >
        <button
          v-if="showScrollToBottom"
          type="button"
          class="sticky bottom-4 mx-auto flex items-center justify-center w-10 h-10 rounded-full border border-border bg-background/80 backdrop-blur-md shadow-lg text-muted-foreground hover:text-foreground hover:bg-background hover:-translate-y-0.5 hover:shadow-xl transition-all"
          title="回到底部"
          @click="scrollToBottom"
        >
          <ArrowDownIcon class="w-4 h-4" />
        </button>
      </Transition>
    </div>

    <MessageNavRail v-if="railVisible" :user-messages="userMessages" />
  </div>
</template>

<script setup lang="ts">
import { MESSAGE_ANCHOR_KEY, useMessageAnchors } from '@renderer/composables/useMessageAnchors'
import { chatContentWidthClass } from '@renderer/lib/chat-layout'
import type { DiffStats } from '@renderer/lib/diff-stats'
import { isNavigableUserMessage } from '@renderer/lib/message-navigation'
import { buildReviewFilesFromMessages, sumReviewStats, type ReviewFile } from '@renderer/lib/review'
import { useBackendStore } from '@renderer/stores/backend'
import { useMessageStore } from '@renderer/stores/message'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { NormalizedMessage } from '@shared/backend/types'
import { AlertCircleIcon, ArrowDownIcon, Loader2Icon } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue'

import { foldClaudeToolGroups } from '../blocks/claude/fold-tool-groups'
import { getBackendConversationRenderer } from '../blocks/plugin-registry'
import ChangesCard from '../changes/ChangesCard.vue'

import CompactDivider from './CompactDivider.vue'
import LoadingDots from './LoadingDots.vue'
import MessageItem from './MessageItem.vue'
import MessageNavRail from './MessageNavRail.vue'

const props = defineProps<{
  /** 是否显示思考块（reasoning）。OFF 时 MessageItem 折叠 kind='reasoning' 的 textBlocks。 */
  showThinking?: boolean
  /** ChatView 按中央聊天列实际宽度统一计算，Composer 与 MessageList 共用。 */
  navRailVisible?: boolean
}>()
const showThinking = computed(() => props.showThinking ?? true)
const workspaceStore = useWorkspaceStore()
const backendStore = useBackendStore()

/** 工作区目录--子 agent 读 jsonl 需要 */
const cwd = computed(() => workspaceStore.currentWorkspace?.path ?? '')

const messageStore = useMessageStore()
const container = ref<HTMLElement | null>(null)
const anchorApi = useMessageAnchors(
  container,
  computed(() => messageStore.currentSessionId),
)
provide(MESSAGE_ANCHOR_KEY, anchorApi)

const userMessages = computed(() => messageStore.messages.filter(isNavigableUserMessage))
const railVisible = computed(() => props.navRailVisible ?? false)

const backendConversationRenderer = computed(() =>
  getBackendConversationRenderer(backendStore.currentId),
)
const conversationClass = computed(() =>
  backendConversationRenderer.value
    ? [
        ...chatContentWidthClass(railVisible.value),
        'flex flex-col py-4 pr-4',
        railVisible.value ? 'pl-10' : 'pl-4',
      ]
    : // 不用 flex gap——gap 会在每条消息之间留空白,打断 assistant 时间轴竖线。
      // 间距改由 MessageItem 内部控制:user 消息底部留呼吸空间(分隔对话轮次),
      // 连续 assistant 消息之间零间距,竖线才能连续不断。
      [
        ...chatContentWidthClass(railVisible.value),
        'flex flex-col py-4 pr-6',
        railVisible.value ? 'pl-10' : 'pl-6',
      ],
)

/**
 * Claude Tool Folding: 实际渲染用的消息数组。
 *
 * claude 把相邻的工具调用折叠成一行可展开的摘要（见 blocks/claude/fold-tool-groups.ts），
 * 折叠会合并块、并丢弃「工具已全部并进前一组」的空消息，所以这个数组和
 * messageStore.messages 长度不同——**凡是按 index 定位的逻辑都必须用它**。
 *
 * 其余后端原样透传，行为不变。
 */
const renderMessages = computed(() =>
  backendStore.currentId === 'claude'
    ? foldClaudeToolGroups(messageStore.messages)
    : messageStore.messages,
)

/**
 * Assistant 时间轴首尾：**每一轮**的首 / 末 assistant 消息 index——
 * 用于 MessageItem 决定竖线画到哪里:
 *   - 本轮第一条 assistant:色点上方不画竖线(上方接的是本轮的 user 提问)
 *   - 本轮最后一条 assistant:色点下方不画竖线(本轮时间轴到此终止)
 * 轮内中间的 assistant 画完整竖线,与前后衔接成一条连续时间轴。
 *
 * 边界判据是「相邻 + 同 turnId」,不是全局首尾:
 *   - 相邻——中间夹了 user 气泡 / compact / 中断条目就断开(这些条目全宽渲染,
 *     竖线本来也接不上)
 *   - 同 turnId——兜住"连续两轮之间没有可见分隔"的情况。历史回放过去恒为
 *     'history'、这条判据退化成纯相邻性；现在历史也按真实轮次切成 `history-N`
 *     (claude/history-mapping.ts)，与实时流一样逐轮断开时间轴。
 */
function inSameTimeline(a: NormalizedMessage, b: NormalizedMessage): boolean {
  return a.role === 'assistant' && b.role === 'assistant' && a.turnId === b.turnId
}
const assistantTimelineEdges = computed(() => {
  const msgs = renderMessages.value
  const first = new Set<number>()
  const last = new Set<number>()
  for (let i = 0; i < msgs.length; i++) {
    const current = msgs[i]!
    if (current.role !== 'assistant') continue
    const prev = msgs[i - 1]
    const next = msgs[i + 1]
    if (!prev || !inSameTimeline(prev, current)) first.add(i)
    if (!next || !inSameTimeline(current, next)) last.add(i)
  }
  return { first, last }
})

/**
 * 每轮的改动汇总，key 是该轮最后一条消息的 index——卡片就插在那条消息之后。
 *
 * 按 turnId 分组而不是整个会话汇总：和 codex 的 CodexChangesCard 口径一致，
 * 「这一轮改了什么」才是用户点审核时想复核的范围；整个会话的累计改动是 git 面板的事。
 *
 * 只在没有专属会话渲染器的后端走这里（codex 由 CodexTurn 自己渲染）。
 */
const turnChanges = computed(() => {
  const byLastIndex = new Map<number, { files: ReviewFile[]; stats: DiffStats }>()
  if (backendConversationRenderer.value) return byLastIndex

  // 改动内容从**原始**消息推：折叠会把工具收进 claude_tool_group、并丢弃因此
  // 变空的消息，拿折叠后的数组去扫会漏掉那些工具改的文件。
  const messagesByTurn = new Map<string, NormalizedMessage[]>()
  for (const message of messageStore.messages) {
    if (!message.turnId) continue
    const list = messagesByTurn.get(message.turnId)
    if (list) list.push(message)
    else messagesByTurn.set(message.turnId, [message])
  }
  // 卡片**位置**则按渲染数组定位——插入点是 v-for 的 index。
  const lastIndexByTurn = new Map<string, number>()
  renderMessages.value.forEach((message, index) => {
    if (message.turnId) lastIndexByTurn.set(message.turnId, index)
  })

  for (const [turnId, messages] of messagesByTurn) {
    const files = buildReviewFilesFromMessages(messages, cwd.value)
    if (files.length === 0) continue
    const index = lastIndexByTurn.get(turnId)
    if (index === undefined) continue
    byLastIndex.set(index, { files, stats: sumReviewStats(files) })
  }
  return byLastIndex
})

/**
 * 是否显示底部"agent 正在干活"指示器。
 *
 * 条件：
 *   1. turn 正在跑（isRunning）——从 markTurnStarting（发消息即置 true）到 turn_completed
 *   2. 没卡在等用户输入——pendingApproval / pendingClaudePermission / pendingAgentQuestion
 *      任一非空时 agent 实际是暂停的（等用户确认权限或回答问题），不显示"正在工作"
 *
 * 覆盖了"发出消息到首个 thinking/文本出现"这段原本没有任何反馈的空窗期。
 */
const agentWorking = computed(
  () =>
    messageStore.isRunning &&
    !messageStore.pendingApproval &&
    !messageStore.pendingClaudePermission &&
    !messageStore.pendingAgentQuestion,
)

/**
 * 是否显示"回到底部"箭头。
 * 判据：距离底部超过 SCROLL_THRESHOLD（120px）时显示。
 * 贴近底部（流式自动滚动 / 用户已看到最新）时隐藏。
 */
const showScrollToBottom = ref(false)
const SCROLL_THRESHOLD = 120

/**
 * 用户此刻是否"跟着底部看"。
 *
 * 决定内容长高 / 可视区变矮时要不要自动跟随（见下方 ResizeObserver）。往上翻看历史
 * 的人不能被拽回底部，所以只有贴着底的时候才跟。初值 true：新会话从底部开始。
 */
const stickToBottom = ref(true)

/** 滚动事件——计算是否离底部足够远，决定显示/隐藏箭头 */
function onScroll(): void {
  if (!container.value) return
  const { scrollTop, scrollHeight, clientHeight } = container.value
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight
  showScrollToBottom.value = distanceFromBottom > SCROLL_THRESHOLD
  stickToBottom.value = distanceFromBottom <= SCROLL_THRESHOLD
}

/** 平滑滚到底部（用户点击箭头用） */
function scrollToBottom(): void {
  if (!container.value) return
  container.value.scrollTo({
    top: container.value.scrollHeight,
    behavior: 'smooth',
  })
}

/**
 * 程式化滚到底部（无动画，给自动滚动用）。
 * 滚完后同步更新 showScrollToBottom（贴底了 → 隐藏箭头）。
 *
 * 多次滚策略：MarkdownView 的 renderMarkdown 是异步的（懒加载 markdown-it + Shiki），
 * setMessages 后 messages div 挂载但内容还是空字符串，scrollHeight 不准。
 * 等内容渲染撑开后才有效——分几次滚：
 *   - 立即：messages div 已挂载，布局发生（容器有基础高度）
 *   - rAF：下一帧，Vue patch 完成
 *   - 60ms：markdown 渲染通常 1-2 帧内完成
 *   - 200ms：兜底首次懒加载（markdown-it 模块加载 + Shiki 语法注册）
 */
function snapToBottom(): void {
  if (!container.value) return
  const doScroll = (): void => {
    if (container.value) {
      container.value.scrollTop = container.value.scrollHeight
      anchorApi.refreshActive()
    }
  }
  doScroll()
  showScrollToBottom.value = false
  requestAnimationFrame(doScroll)
  setTimeout(doScroll, 60)
  setTimeout(doScroll, 200)
}

// 自动滚到底部。
//
// 触发场景：
//   1. 流式输出：messages push 新内容（length 增加）
//   2. 切换 session：currentSessionId 变化 + setMessages 替换数组
//   3. lastError 出现/消失
//   4. loading 变化：loadHistory 时 setLoading(true) 盖住消息列表（v-if loading），
//      setMessages 在 loading=true 期间跑——消息 div 是 v-else 没渲染。
//      setLoading(false) 后消息才挂到 DOM，这时才滚。
//
// ⚠️ ChatView 用 v-if="messages.length > 0" 控制 MessageList 挂载——
// 切到有消息的 session 时组件可能 freshly mounted。watch 默认 immediate=false
// 不会在 mount 时触发，所以额外用 onMounted 兜底滚一次。
watch(
  () => [
    messageStore.messages.length,
    messageStore.currentSessionId,
    messageStore.lastError,
    messageStore.loading,
    agentWorking.value,
  ],
  async () => {
    // loading 中不滚——消息列表被 loading overlay 盖住，滚了也看不到
    if (messageStore.loading) return
    await nextTick()
    snapToBottom()
  },
)

// mount 时兜底滚一次——处理 v-if fresh mount 场景（watch immediate=false 漏掉）
onMounted(async () => {
  await nextTick()
  snapToBottom()
})

/*
 * 贴底跟随：内容长高、或可视区变矮时，把底部继续留在视野里。
 *
 * 上面那个 watch 只看 messages.length，而流式输出是往**同一条**消息里追加 block
 * （thinking 一行行长出来、工具结果展开），length 一直不变，于是不触发滚动——内容
 * 越长越高，最新的部分被顶出可视区下沿。底部交互区换成 PermissionPanel 时更明显：
 * 它比 Composer 高，MessageList 的 clientHeight 被压小，原本贴底的内容一下子被挤到
 * 审核框后面，看起来就像 thinking「跑到审核框下面去了」。
 *
 * 两个都要观察：滚动容器（可视区高度变化）和内容容器（内容高度变化）。
 * 只在用户本来就贴着底时跟随，往上翻历史不会被拽回来。
 */
const conversation = ref<HTMLElement | null>(null)
let followObserver: ResizeObserver | null = null

onMounted(() => {
  followObserver = new ResizeObserver(() => {
    if (!stickToBottom.value || messageStore.loading || !container.value) return
    container.value.scrollTop = container.value.scrollHeight
  })
  if (container.value) followObserver.observe(container.value)
  if (conversation.value) followObserver.observe(conversation.value)
})

// 内容容器挂在 v-else 上，loading 切换会换掉这个节点，重新接观察。
watch(conversation, (el, prev) => {
  if (prev) followObserver?.unobserve(prev)
  if (el) followObserver?.observe(el)
})

onUnmounted(() => {
  followObserver?.disconnect()
  followObserver = null
})
</script>
