import { randomUUID } from '@renderer/lib/utils'
import type {
  CodexActivity,
  CodexActivityContentBlock,
  CodexActivityStatus,
} from '@shared/backend/blocks'
import type {
  AgentQuestion,
  ContextBlock,
  NormalizedMessage,
  TokenUsage,
  TurnEvent,
  ApprovalRequest,
} from '@shared/backend/types'
import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'

interface PendingApproval {
  requestId: string
  request: ApprovalRequest
  turnId: string
}

interface PendingAgentQuestion {
  requestId: string
  turnId: string
  question: AgentQuestion
}

/**
 * 单个 session 的所有 message 相关状态。
 *
 * 改造历史：原本 messageStore 是全局单值，切 session 时 reset 清空。
 * 但 claude 多 turn 并发场景下，用户切走时 A 的 turn 可能还在跑（权限请求 / 流式输出），
 * 这时 A 的状态被清空 → 切回 A 看不到正在跑的 turn，dialog 消失但 main 进程还在等回应。
 *
 * 现在按 sessionId 各持一份状态，切 session 只是切 currentSessionId，不动各 session 的内容。
 */
interface SessionState {
  messages: NormalizedMessage[]
  currentTurnId: string | null
  isRunning: boolean
  /** codex approval 请求 */
  pendingApproval: PendingApproval | null
  /** claude 通过内置 MCP server 的权限请求（走 PermissionPanel） */
  pendingClaudePermission: PendingApproval | null
  /** agent 问用户问题（claude 调 ask_user 工具，走 QuestionPanel） */
  pendingAgentQuestion: PendingAgentQuestion | null
  lastError: string | null
  lastUsage: TokenUsage | null
  /**
   * /compact 进行中的 turnId——非 null 表示该 session 有 compact 正在后台跑。
   * UI 在消息流末尾插入"正在压缩上下文"分隔线（呼吸动画）。
   * turn_completed 时 compactDone 置 true，分隔线变成静态"上下文已压缩"。
   * 用户切走再切回时仍能看到 compact 状态——它跟 session 走，不跟当前视图走。
   */
  compactTurnId: string | null
  /** compact 是否已完成（compactTurnId 非 null 时才有意义） */
  compactDone: boolean
  /**
   * 是否有"未读"的后台 turn 完成——侧边栏小蓝点的来源。
   *
   * 置 true：turn 在后台跑完（turn_completed），且当时用户不在看这个 session。
   * 清 false：用户切到该 session（selectSession）。
   *
   * 跟 isRunning 互补：
   *   - isRunning=true  → 侧边栏显示旋转 loader
   *   - isRunning=false + unreadActivity=true → 侧边栏显示小蓝点（"有新活动可看"）
   *   - isRunning=false + unreadActivity=false → 无指示器（默认/已看过）
   */
  unreadActivity: boolean
}

function createEmptySessionState(): SessionState {
  return {
    messages: [],
    currentTurnId: null,
    isRunning: false,
    pendingApproval: null,
    pendingClaudePermission: null,
    pendingAgentQuestion: null,
    lastError: null,
    lastUsage: null,
    compactTurnId: null,
    compactDone: false,
    unreadActivity: false,
  }
}

export const useMessageStore = defineStore('message', () => {
  /** sessionId → 该 session 的状态。用 reactive Map 让 Vue 跟踪 set/get */
  const sessionStates = reactive(new Map<string, SessionState>())
  /** 当前激活的 session——所有非 session 限定的访问（messages/pending* 等）都从这个 session 取 */
  const currentSessionId = ref<string | null>(null)

  /** loading 是全局的（loadHistory 跨 session） */
  const loading = ref(false)
  /** 全局 error——不跟 session 绑定，给 loadHistory 等全局错误用 */
  const globalError = ref<string | null>(null)

  /** 取当前 session 状态——没有就懒创建一个空状态 */
  function cur(): SessionState {
    const id = currentSessionId.value
    if (!id) {
      // 没设当前 session 时返回一个共享的空 state（让 computed 不报错）
      return EMPTY_STATE
    }
    let s = sessionStates.get(id)
    if (!s) {
      s = createEmptySessionState()
      sessionStates.set(id, s)
    }
    return s
  }

  // 共享的空 state——currentSessionId 为 null 时用。
  // 注意：写它的字段没意义（写完就丢），只用于读
  const EMPTY_STATE = createEmptySessionState()

  // ============ 对外暴露的状态（computed + setter，保持调用方兼容） ============
  // computed 让外部访问 messageStore.messages 时 reactive；setter 让 `store.xxx = ...` 也能工作。

  const messages = computed({
    get: () => cur().messages,
    set: (v: NormalizedMessage[]) => {
      const id = currentSessionId.value
      if (!id) return
      const s = sessionStates.get(id) ?? createEmptySessionState()
      s.messages = v
      sessionStates.set(id, s)
    },
  })

  const currentTurnId = computed(() => cur().currentTurnId)

  const isRunning = computed(() => cur().isRunning)

  const pendingApproval = computed({
    get: () => cur().pendingApproval,
    set: (v: PendingApproval | null) => {
      const id = currentSessionId.value
      if (!id) return
      const s = cur()
      s.pendingApproval = v
    },
  })

  const pendingClaudePermission = computed({
    get: () => cur().pendingClaudePermission,
    set: (v: PendingApproval | null) => {
      const id = currentSessionId.value
      if (!id) return
      const s = cur()
      s.pendingClaudePermission = v
    },
  })

  const pendingAgentQuestion = computed({
    get: () => cur().pendingAgentQuestion,
    set: (v: PendingAgentQuestion | null) => {
      const id = currentSessionId.value
      if (!id) return
      const s = cur()
      s.pendingAgentQuestion = v
    },
  })

  const lastError = computed(() => cur().lastError)
  const lastUsage = computed(() => cur().lastUsage)
  /**
   * 当前 session 的 compact 分隔线状态：
   *   - null：没有 compact（从未发过 /compact，或历史回放的会话没记录）
   *   - 'pending'：正在压缩（呼吸动画）
   *   - 'done'：已压缩（静态文案）
   *
   * UI（MessageList）在消息流末尾按这个值渲染 CompactDivider。
   */
  const compactState = computed<'pending' | 'done' | null>(() => {
    const s = cur()
    if (s.compactTurnId === null) return null
    return s.compactDone ? 'done' : 'pending'
  })

  /** 把 TurnEvent 累积到对应 session 的 NormalizedMessage[]。
   *  sessionId 由 backend envelope 提供（多 turn 并发隔离）。 */
  function applyEvent(sessionId: string, event: TurnEvent): void {
    let s = sessionStates.get(sessionId)
    if (!s) {
      s = createEmptySessionState()
      sessionStates.set(sessionId, s)
    }
    // 是否当前正在看的 session——turn 完成时用它决定要不要置 unreadActivity
    // （用户正在看的 session 完成不算"未读"，后台完成的才算）
    const isCurrent = currentSessionId.value === sessionId
    applyEventToState(s, event, isCurrent)
  }

  function applyEventToState(s: SessionState, event: TurnEvent, isCurrent: boolean): void {
    switch (event.type) {
      case 'turn_started': {
        s.currentTurnId = event.turnId
        s.isRunning = true
        s.lastError = null
        // /compact turnId 对齐：
        // ChatView 的 startCompact(turnId) 传的是 renderer-local UUID（占位），
        // 但 backend（adapter）自己起 internalTurnId 标在所有事件上，
        // 且 startTurn 不接受外部 turnId。如果不在 turn_started 时对齐，
        // 后续 turn_completed 里 s.compactTurnId === event.turnId 永远 false，
        // compactDone 永不置 true，"正在压缩上下文"呼吸动画永远停不下来。
        //
        // 前提：Composer 在 turn 跑时禁用，没有并发 turn；startCompact 后
        // 收到的第一个 turn_started 必然是 /compact 这个 turn，可以直接覆盖占位。
        if (s.compactTurnId !== null && !s.compactDone) {
          s.compactTurnId = event.turnId
        }
        break
      }
      case 'text_delta': {
        const msg = findOrCreateAssistantMessage(s, event.turnId, event.itemId)
        if (!msg.blocks) msg.blocks = []
        const contentBlock = msg.blocks.find(
          (block) => block.type === 'text' && block.id === `${event.itemId}-text`,
        )
        if (contentBlock?.type === 'text') {
          contentBlock.text += event.text
        } else {
          msg.blocks.push({ id: `${event.itemId}-text`, type: 'text', text: event.text })
        }
        if (!msg.textBlocks) msg.textBlocks = []
        const lastBlock = msg.textBlocks[msg.textBlocks.length - 1]
        if (lastBlock && lastBlock.id === `${event.itemId}-text`) {
          lastBlock.text += event.text
        } else {
          msg.textBlocks.push({
            id: `${event.itemId}-text`,
            text: event.text,
            kind: 'text',
          })
        }
        // 正文开始 → 同 turn 所有未结束的 reasoning 块视为结束。
        // reasoning 和 text 通常不同 itemId（落在不同 NormalizedMessage 上），
        // 所以必须在 turn 维度扫描，不能只看本 message。
        markReasoningEnded(s, event.turnId, Date.now())
        break
      }
      case 'reasoning_delta': {
        const msg = findOrCreateAssistantMessage(s, event.turnId, event.itemId)
        if (!msg.blocks) msg.blocks = []
        const now = Date.now()
        const contentBlock = msg.blocks.find(
          (block) => block.type === 'reasoning' && block.id === `${event.itemId}-reasoning`,
        )
        if (contentBlock?.type === 'reasoning') {
          contentBlock.text += event.text
          if (event.completedLabel) contentBlock.completedLabel = event.completedLabel
        } else {
          msg.blocks.push({
            id: `${event.itemId}-reasoning`,
            type: 'reasoning',
            text: event.text,
            startedAt: now,
            ...(event.completedLabel ? { completedLabel: event.completedLabel } : {}),
            ...(hasTextStarted(s, event.turnId) ? { endedAt: now } : {}),
          })
        }
        if (!msg.textBlocks) msg.textBlocks = []
        // Bug G：reasoning_delta 必须和 text_delta 一样按 itemId 累积到同一个 block，
        // 否则每个 token delta 都被 push 成独立 block（UI 上显示成 46 个 span）。
        const lastBlock = msg.textBlocks[msg.textBlocks.length - 1]
        if (lastBlock && lastBlock.id === `${event.itemId}-reasoning`) {
          lastBlock.text += event.text
        } else {
          const now = Date.now()
          const block: NonNullable<NormalizedMessage['textBlocks']>[number] = {
            id: `${event.itemId}-reasoning`,
            text: event.text,
            kind: 'reasoning',
            startedAt: now,
          }
          // 兜底：如果 reasoning 开始时正文已经在流（极少见，比如 turn resume
          // 拉历史带 reasoning），直接认为已结束。避免出现 endedAt < startedAt。
          if (hasTextStarted(s, event.turnId)) block.endedAt = now
          msg.textBlocks.push(block)
        }
        break
      }
      case 'content_block_upsert': {
        if (event.block.type === 'codex_activity') {
          upsertCodexActivityBlock(s, event.turnId, event.block)
          break
        }
        const msg = findOrCreateAssistantMessage(s, event.turnId, event.block.id)
        if (!msg.blocks) msg.blocks = []
        const index = msg.blocks.findIndex((block) => block.id === event.block.id)
        if (index === -1) msg.blocks.push(event.block)
        else msg.blocks[index] = event.block
        break
      }
      case 'codex_activity_output_delta': {
        appendCodexActivityOutput(s, event.turnId, event.itemId, event.text)
        break
      }
      case 'codex_turn_diff_updated': {
        updateCodexTurnDiff(s, event.turnId, event.diff)
        break
      }
      case 'tool_call_started': {
        const msg = findOrCreateAssistantMessage(s, event.turnId, event.itemId)
        if (!msg.blocks) msg.blocks = []
        msg.blocks.push({
          id: event.itemId,
          type: 'tool_call',
          info: event.tool,
          status: 'running',
          startedAt: Date.now(),
        })
        if (!msg.toolBlocks) msg.toolBlocks = []
        msg.toolBlocks.push({
          id: event.itemId,
          info: event.tool,
          status: 'running',
          // 记录开始时间--前端 TaskCard 用来显示"已运行 N 秒"实时计时
          startedAt: Date.now(),
        })
        // 模型决定调工具 = "这轮想清楚了"，等工具返回再继续。
        // 工具调用开始即结束 thinking（跟 text_delta 同样的处理）。
        // 否则像 thinking → tool → tool_result → text 这种序列，
        // 整个工具执行期间会错误地卡在 "thinking..." 动画。
        markReasoningEnded(s, event.turnId, Date.now())
        break
      }
      case 'tool_call_completed': {
        const msg = findMessageByItemId(s, event.turnId, event.itemId)
        const contentBlock = msg?.blocks?.find(
          (block) => block.type === 'tool_call' && block.id === event.itemId,
        )
        if (contentBlock?.type === 'tool_call') {
          contentBlock.status = event.output.ok ? 'completed' : 'failed'
          contentBlock.output = event.output
          if (event.taskStats) contentBlock.taskStats = event.taskStats
        }
        if (msg?.toolBlocks) {
          const block = msg.toolBlocks.find((b) => b.id === event.itemId)
          if (block) {
            block.status = event.output.ok ? 'completed' : 'failed'
            block.output = event.output
            // Task（子 Agent）完成统计--把 adapter 提取的 taskStats 挂上
            if (event.taskStats) block.taskStats = event.taskStats
          }
        }
        break
      }
      case 'background_task_updated': {
        const itemId = event.task.toolUseId
        if (!itemId) break
        const msg = findMessageByItemId(s, event.turnId, itemId)
        const isCompleted = event.task.status === 'completed'
        const toolStatus =
          event.task.status === 'running' ? 'running' : isCompleted ? 'completed' : 'failed'
        const output = {
          ok: isCompleted,
          summary:
            event.task.summary ??
            (isCompleted
              ? '后台 Agent 已完成'
              : event.task.status === 'stopped'
                ? '后台 Agent 已停止'
                : '后台 Agent 执行失败'),
        }

        const contentBlock = msg?.blocks?.find(
          (block) => block.type === 'tool_call' && block.id === itemId,
        )
        if (contentBlock?.type === 'tool_call') {
          contentBlock.status = toolStatus
          contentBlock.taskStats = event.task.stats
          if (event.task.status !== 'running') contentBlock.output = output
        }
        const toolBlock = msg?.toolBlocks?.find((block) => block.id === itemId)
        if (toolBlock) {
          toolBlock.status = toolStatus
          toolBlock.taskStats = event.task.stats
          if (event.task.status !== 'running') toolBlock.output = output
        }
        break
      }
      case 'approval_requested': {
        // 按 source 分发——claude 走 pendingClaudePermission（PermissionPanel），
        // codex（不带 source）走 pendingApproval（PermissionPanel）。
        const target = event.source === 'claude' ? 'pendingClaudePermission' : 'pendingApproval'
        s[target] = {
          requestId: event.requestId,
          request: event.request,
          turnId: event.turnId,
        }
        break
      }
      case 'agent_question': {
        // agent 调 ask_user 工具问用户——UI 弹 QuestionPanel，用户回答后走 respondQuestion
        s.pendingAgentQuestion = {
          requestId: event.requestId,
          turnId: event.turnId,
          question: event.question,
        }
        break
      }
      case 'error': {
        s.lastError = event.message
        // 不可恢复错误 → 兜底结束所有未完成的 reasoning（否则 header 卡在 thinking... 永远不结束）
        if (!event.recoverable) {
          s.isRunning = false
          markReasoningEnded(s, event.turnId, Date.now())
          // compact 出错也要切到 done——否则呼吸动画永远不停
          if (s.compactTurnId === event.turnId) {
            s.compactDone = true
          }
        }
        break
      }
      case 'turn_completed': {
        s.isRunning = false
        s.currentTurnId = null
        if (event.usage) {
          s.lastUsage = event.usage
        }
        // 兜底：纯思考无正文的 turn，reasoning 没机会被 text_delta 标记结束，
        // 这里统一兜底结束（幂等，已结束的不会被覆盖）。
        markReasoningEnded(s, event.turnId, Date.now())
        // compact 完成：turn 匹配 compactTurnId 时把分隔线状态从"呼吸"切到"已压缩"。
        // 分隔线继续保留（不删 compactTurnId）——它标记了"这里发生过压缩"，
        // 用户切走再切回仍能看到。后续再发 /compact 会覆盖 compactTurnId 开新一轮。
        if (s.compactTurnId === event.turnId) {
          s.compactDone = true
        }
        // 后台 turn 完成 + 用户没在看这个 session → 标记"未读活动"，
        // 侧边栏显示小蓝点提示"有新活动可看"。用户正在看的不标（即时看到完成）。
        if (!isCurrent) {
          s.unreadActivity = true
        }
        // turn 结束时兜底清空 pending——
        // 正常流程下 PermissionPanel/QuestionPanel 决策时已经清了，
        // 这里防止面板卡住（比如 turn 因各种原因提前结束时）。
        s.pendingClaudePermission = null
        s.pendingAgentQuestion = null
        break
      }
    }
  }

  /**
   * 把同 turn 内所有"还在思考中"（endedAt === undefined）的 reasoning 块标记为结束。
   *
   * 幂等：已结束的块（有 endedAt）不动。
   *
   * 调用时机：
   *   - text_delta 首次到达（正文开始 → 思考结束）
   *   - tool_call_started 首次到达（模型决定调工具 = 想清楚了，等结果再继续思考）
   *   - turn_completed（兜底：纯思考无正文/工具）
   *   - 不可恢复 error（避免 header 永远停在 thinking...）
   *
   * 跨 message 扫描的原因：reasoning 和 text/tool 通常落在不同 itemId → 不同
   * NormalizedMessage，只扫当前 message 会漏掉。
   */
  function markReasoningEnded(s: SessionState, turnId: string, now: number): void {
    for (const m of s.messages) {
      if (m.turnId !== turnId) continue
      for (const block of m.blocks ?? []) {
        if (block.type === 'reasoning' && block.endedAt === undefined) {
          block.endedAt = now
        }
      }
      for (const block of m.textBlocks ?? []) {
        if (block.kind === 'reasoning' && block.endedAt === undefined) {
          block.endedAt = now
        }
      }
    }
  }

  /** 同 turn 内是否已经累积过 text_delta（正文已开始）。用于 reasoning 块创建时的兜底。 */
  function hasTextStarted(s: SessionState, turnId: string): boolean {
    for (const m of s.messages) {
      if (m.turnId !== turnId || !m.textBlocks) continue
      if (m.textBlocks.some((b) => b.kind === 'text' && b.text.length > 0)) return true
    }
    return false
  }

  function findOrCreateAssistantMessage(
    s: SessionState,
    turnId: string,
    itemId: string,
  ): NormalizedMessage {
    // 先找已有的同 itemId 的 message
    let msg = findMessageByItemId(s, turnId, itemId)
    if (msg) return msg

    // 否则创建新的 assistant message
    msg = {
      id: itemId,
      role: 'assistant',
      turnId,
      blocks: [],
      createdAt: Date.now(),
    }
    s.messages.push(msg)
    return msg
  }

  function findMessageByItemId(
    s: SessionState,
    turnId: string,
    itemId: string,
  ): NormalizedMessage | undefined {
    return s.messages.find((m) => m.turnId === turnId && m.id === itemId)
  }

  function upsertCodexActivityBlock(
    s: SessionState,
    turnId: string,
    incoming: CodexActivityContentBlock,
  ): void {
    let target: CodexActivityContentBlock | undefined
    for (const message of s.messages) {
      if (message.turnId !== turnId) continue
      target = message.blocks?.find(
        (block): block is CodexActivityContentBlock =>
          block.type === 'codex_activity' &&
          incoming.activities.some((activity) =>
            block.activities.some((existing) => existing.id === activity.id),
          ),
      )
      if (target) break
    }

    if (!target) {
      const lastMessage = s.messages[s.messages.length - 1]
      const lastBlock = lastMessage?.blocks?.[lastMessage.blocks.length - 1]
      if (
        lastMessage?.role === 'assistant' &&
        lastMessage.turnId === turnId &&
        lastBlock?.type === 'codex_activity'
      ) {
        target = lastBlock
      } else {
        const message: NormalizedMessage = {
          id: `codex-activity-${incoming.id}`,
          role: 'assistant',
          turnId,
          blocks: [incoming],
          createdAt: Date.now(),
        }
        s.messages.push(message)
        return
      }
    }

    for (const activity of incoming.activities) {
      const index = target.activities.findIndex((existing) => existing.id === activity.id)
      if (index === -1) {
        target.activities.push(activity)
      } else {
        target.activities[index] = mergeCodexActivity(target.activities[index]!, activity)
      }
    }
    target.status = aggregateCodexActivityStatus(target.activities)
    target.durationMs = target.activities.reduce(
      (total, activity) => total + (activity.durationMs ?? 0),
      0,
    )
    if (incoming.defaultCollapsed !== undefined) {
      target.defaultCollapsed = incoming.defaultCollapsed
    }
  }

  function appendCodexActivityOutput(
    s: SessionState,
    turnId: string,
    itemId: string,
    text: string,
  ): void {
    for (const message of s.messages) {
      if (message.turnId !== turnId) continue
      for (const block of message.blocks ?? []) {
        if (block.type !== 'codex_activity') continue
        for (const activity of block.activities) {
          if (
            activity.kind === 'command' &&
            (activity.id === itemId || activity.id.startsWith(`${itemId}-`))
          ) {
            activity.output = (activity.output ?? '') + text
          }
        }
      }
    }
  }

  function updateCodexTurnDiff(s: SessionState, turnId: string, diff: string): void {
    for (let messageIndex = s.messages.length - 1; messageIndex >= 0; messageIndex--) {
      const message = s.messages[messageIndex]!
      if (message.turnId !== turnId) continue
      for (let blockIndex = (message.blocks?.length ?? 0) - 1; blockIndex >= 0; blockIndex--) {
        const block = message.blocks![blockIndex]!
        if (block.type !== 'codex_activity') continue
        block.turnDiff = diff
        block.turnDiffStats = countDiffStats(diff)
        return
      }
    }
  }

  /** 加一条用户消息到当前 session（在发 turn 之前）。
   *  contextBlocks 可选——如果传入，UI 会把对应 tag 渲染成专门的卡片
   *  （IDE selection / opened file / environment_context 等），跟气泡平级展示。 */
  function pushUserMessage(turnId: string, text: string, contextBlocks?: ContextBlock[]): void {
    if (!currentSessionId.value) return
    const s = cur()
    s.messages.push({
      id: randomUUID(),
      role: 'user',
      turnId,
      blocks: [
        ...(contextBlocks ?? []).map((context, index) => ({
          id: `${turnId}-context-${index}`,
          type: 'context' as const,
          ...context,
        })),
        { id: randomUUID(), type: 'text', text },
      ],
      textBlocks: [{ id: randomUUID(), text, kind: 'text' }],
      ...(contextBlocks && contextBlocks.length > 0 ? { contextBlocks } : {}),
      createdAt: Date.now(),
    })
  }

  /**
   * 切换当前 session——不动各 session 的状态（多 turn 并发时不互相清空）。
   * 旧版 reset() 行为已废弃——切 session 不应该清掉后台还在跑的 turn 状态。
   *
   * 空字符串当 null 处理——sessionStore.setCurrent('') 表示"没选 session"
   * （新建会话场景），跟 null 语义一致。
   *
   * 切到的 session 清掉 unreadActivity——用户已经在看了，小蓝点不再需要。
   */
  function setCurrentSession(sessionId: string | null): void {
    currentSessionId.value = sessionId === '' ? null : sessionId
    if (sessionId) {
      const s = sessionStates.get(sessionId)
      if (s) s.unreadActivity = false
    }
  }

  /**
   * 标记当前 session 进入 /compact 进行中状态。
   * UI 会在消息流末尾插入"正在压缩上下文"分隔线（呼吸动画）。
   * turn_completed 匹配 compactTurnId 时自动切到"已压缩"静态态。
   *
   * 调用时机：onSend 检测到用户发的是 /compact 命令时调用，
   * **不**走 pushUserMessage（/compact 那行消息不展示）。
   */
  function startCompact(turnId: string): void {
    if (!currentSessionId.value) return
    const s = cur()
    s.compactTurnId = turnId
    s.compactDone = false
  }

  /**
   * 乐观标记 turn 已开始——发消息后立刻把 isRunning/currentTurnId 设上，
   * 让 UI（MessageList 底部 loading 指示器、Composer 停止按钮）马上有反馈，
   * 不用等 backend 的 turn_started 事件（其间有几百 ms ~ 数秒的网络/进程启动延迟）。
   *
   * 后续真正的 turn_started 事件到达时会覆盖这些字段（幂等）；
   * turn_completed / 不可恢复 error 会把 isRunning 置回 false。
   * 所以即使 backend 启动失败，状态也不会卡死——用户看到的只是"短暂亮了一下又灭"。
   *
   * @param sessionId  目标 session（支持非当前 session 的后台 turn，跟 applyEvent 对齐）
   * @param turnId     本次发送的 turnId（跟 pushUserMessage 用同一个）
   */
  function markTurnStarting(sessionId: string, turnId: string): void {
    let s = sessionStates.get(sessionId)
    if (!s) {
      s = createEmptySessionState()
      sessionStates.set(sessionId, s)
    }
    s.currentTurnId = turnId
    s.isRunning = true
    s.lastError = null
  }

  /**
   * 替换当前 session 的 messages（loadHistory 调）。
   * 不动其他 session 状态。
   */
  function setMessages(newMessages: NormalizedMessage[]): void {
    if (!currentSessionId.value) return
    const s = cur()
    s.messages = newMessages
  }

  /** 显式清空某个 session 的状态——删除 session 时调 */
  function clearSession(sessionId: string): void {
    sessionStates.delete(sessionId)
  }

  /**
   * 重置所有 session 状态——切工作区 / 切 backend 时调（彻底清空）。
   * 不同于旧版 reset()——旧版只清"当前 session"，现在清所有 session。
   */
  function resetAll(): void {
    sessionStates.clear()
    currentSessionId.value = null
    globalError.value = null
  }

  function setLoading(v: boolean): void {
    loading.value = v
  }

  function setError(msg: string | null): void {
    if (!currentSessionId.value) {
      globalError.value = msg
      return
    }
    // 写到当前 session——ChatView 渲染 lastError 时能正确读到
    const s = cur()
    s.lastError = msg
  }

  return {
    // 状态（computed + setter，调用方原代码不动）
    messages,
    currentTurnId,
    isRunning,
    pendingApproval,
    pendingClaudePermission,
    pendingAgentQuestion,
    lastError,
    lastUsage,
    compactState,
    loading,
    // session 管理
    currentSessionId,
    sessionStates,
    // 方法
    applyEvent,
    pushUserMessage,
    startCompact,
    markTurnStarting,
    setCurrentSession,
    setMessages,
    clearSession,
    resetAll,
    setLoading,
    setError,
  }
})

function mergeCodexActivity(existing: CodexActivity, incoming: CodexActivity): CodexActivity {
  if (existing.kind !== incoming.kind) return incoming
  return { ...existing, ...incoming } as CodexActivity
}

function aggregateCodexActivityStatus(activities: CodexActivity[]): CodexActivityStatus {
  if (activities.some((activity) => activity.status === 'running')) return 'running'
  if (activities.some((activity) => activity.status === 'failed')) return 'failed'
  return 'completed'
}

function countDiffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { additions, deletions }
}
