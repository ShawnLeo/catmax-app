<template>
  <!--
    权限确认面板——直接覆盖 Composer 的位置（同外层布局 + 同宽度），
    不再用全屏遮罩，让聊天记录始终可见，用户能边看消息边确认。

    合并了原 ClaudePermissionDialog（claude，source='claude'）和 ApprovalDialog（codex）：
    - claude 权限：允许 / 拒绝 二选一（协议层没有"本会话都允许"）
    - codex 权限：拒绝 / 本会话都允许（非高危时）/ 允许

    驱动：messageStore.pendingClaudePermission 或 messageStore.pendingApproval（同一时刻只一个）。
    决策通过 window.api.backend.respondApproval 回传，随后清空 pending。

    外层布局完全复用 Composer（mx-auto max-w-... + p-3 + rounded-2xl border bg-background），
    视觉上精确占据输入框位置，确认完恢复输入框。
  -->
  <div>
    <div class="mx-auto max-w-3xl lg:max-w-screen-lg xl:max-w-[1280px] 2xl:max-w-[1440px] p-3">
      <div
        class="rounded-2xl border bg-background transition-colors overflow-hidden"
        :class="isHighRisk ? 'border-destructive/60' : 'border-border'"
      >
        <!-- header -->
        <div class="px-4 pt-3 pb-2 flex items-center gap-2">
          <ShieldAlertIcon :class="['w-5 h-5 flex-shrink-0', riskColor]" />
          <h3 class="text-base font-semibold flex-1 min-w-0 truncate">
            {{ request.title }}
          </h3>
          <span
            :class="[
              'text-xs px-2 py-0.5 rounded-full whitespace-nowrap flex-shrink-0',
              riskBadgeClass,
            ]"
          >
            {{ riskLabel }}
          </span>
        </div>

        <!-- 动作描述：SDK canUseTool 透传的友好文案（displayName + description）。
             没有 SDK 文案时（codex / 旧消息）回退到 kind 的中文标签。 -->
        <div
          v-if="request.displayName || request.description || request.kind"
          class="px-4 pb-2 flex items-center gap-2 flex-wrap"
        >
          <span
            v-if="request.displayName"
            class="text-xs font-medium px-1.5 py-0.5 rounded bg-muted text-foreground whitespace-nowrap"
          >
            {{ request.displayName }}
          </span>
          <span
            v-else
            class="text-xs font-medium px-1.5 py-0.5 rounded bg-muted text-foreground whitespace-nowrap"
          >
            {{ kindLabel }}
          </span>
          <span v-if="request.description" class="text-xs text-muted-foreground min-w-0 truncate">
            {{ request.description }}
          </span>
        </div>

        <!-- 为什么问：SDK decisionReason（如 "Path is outside allowed working directories"） -->
        <div v-if="request.decisionReason" class="px-4 pb-2">
          <p class="text-[11px] text-muted-foreground italic">
            {{ request.decisionReason }}
          </p>
        </div>

        <!-- body：要确认的命令 / diff / mcp 细节（原始 input，补充信息） -->
        <div v-if="request.detail" class="px-4 pb-3 max-h-72 overflow-y-auto">
          <pre
            class="font-mono text-[12px] text-foreground bg-code-block p-3 rounded whitespace-pre-wrap overflow-x-auto"
            >{{ request.detail }}</pre>
        </div>

        <!-- footer -->
        <div class="px-4 py-2.5 border-t border-border flex items-center justify-between gap-2">
          <span class="text-xs text-muted-foreground truncate">{{ sourceLabel }}</span>
          <div class="flex gap-2 flex-shrink-0">
            <Button variant="outline" size="sm" @click="onReject">拒绝（Esc）</Button>
            <Button v-if="showApproveAlways" variant="secondary" size="sm" @click="onApproveAlways">
              {{ approveAlwaysLabel }}
            </Button>
            <Button :variant="isHighRisk ? 'destructive' : 'default'" size="sm" @click="onApprove">
              允许（Enter）
            </Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button } from '@renderer/components/ui/button'
import { useMessageStore } from '@renderer/stores/message'
import { ShieldAlertIcon } from 'lucide-vue-next'
import { computed, onMounted, onUnmounted } from 'vue'

const messageStore = useMessageStore()

/**
 * 当前 pending：claude 权限或 codex 权限二选一（同一时刻只一个 backend 在跑 turn）。
 * 两者形状一致（{ requestId, request: ApprovalRequest, turnId }）。
 */
const pending = computed(() => messageStore.pendingClaudePermission ?? messageStore.pendingApproval)
const request = computed(() => pending.value!.request)

/** 来源：claude 权限走 pendingClaudePermission，否则 codex。决定文案与"本会话都允许"语义。 */
const isClaude = computed(() => messageStore.pendingClaudePermission !== null)
const isHighRisk = computed(() => request.value.riskLevel === 'high')

/**
 * "本会话都允许/始终允许"显示条件：
 * - codex 普通审批：approve_always → 原生 acceptForSession，非高危时显示
 * - MCP elicitation：只有 server 在 _meta.persist 明确声明支持时显示
 * - claude：approve_always → 回传 SDK suggestions 作为 updatedPermissions（adapter 已支持），非高危时显示
 *   （claude 协议层曾有"无 always 语义"的旧注释，SDK 下经 updatedPermissions 已可真持久化）
 */
const showApproveAlways = computed(
  () =>
    !isHighRisk.value &&
    (request.value.kind !== 'mcp' || (request.value.approvalPersistence?.length ?? 0) > 0),
)
const approveAlwaysLabel = computed(() =>
  request.value.kind === 'mcp' && request.value.approvalPersistence?.includes('always')
    ? '始终允许'
    : '本会话都允许',
)

/** 没有 SDK displayName 时的兜底标签（按 kind 给中文） */
const kindLabel = computed(() => {
  switch (request.value.kind) {
    case 'shell_command':
      return '命令'
    case 'file_edit':
      return '文件编辑'
    case 'mcp':
      return 'MCP'
    default:
      return '操作'
  }
})

const sourceLabel = computed(() =>
  isClaude.value ? 'Claude 请求执行此操作' : 'codex 请求执行此操作',
)

const riskColor = computed(() => {
  switch (request.value.riskLevel) {
    case 'high':
      return 'text-destructive'
    case 'medium':
      return 'text-warning'
    default:
      return 'text-muted-foreground'
  }
})

const riskBadgeClass = computed(() => {
  switch (request.value.riskLevel) {
    case 'high':
      return 'bg-destructive/10 text-destructive'
    case 'medium':
      return 'bg-warning/10 text-warning'
    default:
      return 'bg-muted text-muted-foreground'
  }
})

const riskLabel = computed(() => {
  switch (request.value.riskLevel) {
    case 'high':
      return '高危'
    case 'medium':
      return '中等'
    default:
      return '低'
  }
})

async function respondAndClear(action: 'approve' | 'reject' | 'approve_always'): Promise<void> {
  const p = pending.value
  if (!p) return
  await window.api.backend.respondApproval({ requestId: p.requestId, action })
  // 清空对应的 pending slot（claude / codex）
  if (isClaude.value) messageStore.pendingClaudePermission = null
  else messageStore.pendingApproval = null
}

function onApprove(): void {
  void respondAndClear('approve')
}

function onApproveAlways(): void {
  void respondAndClear('approve_always')
}

function onReject(): void {
  void respondAndClear('reject')
}

function onKey(e: KeyboardEvent): void {
  // 面板内没有 input/textarea，但兜底
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return
  if (e.key === 'Enter') {
    e.preventDefault()
    onApprove()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    onReject()
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>
