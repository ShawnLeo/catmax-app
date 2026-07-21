<template>
  <!--
    Claude 权限请求 dialog（claude 通过内置 MCP server 的权限请求触发）。

    驱动：messageStore.pendingClaudePermission（由 backend 推 approval_requested
    TurnEvent with source='claude' 设置）。

    跟 ApprovalDialog（codex 用）的差异：
    - 文案改成 "Claude 请求执行此操作"
    - 不显示"本会话都允许"按钮——claude permission-prompt-tool 协议层没这个语义
      （allow/deny 二选一；要持久化允许后续通过 settings.json 写 allow 规则实现）
    - 同样支持 Esc 拒绝 / Enter 允许键盘快捷键
  -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    @click.self="onReject"
  >
    <div
      class="bg-card text-card-foreground rounded-lg shadow-xl max-w-2xl w-full mx-4 overflow-hidden"
    >
      <!-- header -->
      <div class="p-4 border-b border-border">
        <div class="flex items-center gap-2">
          <ShieldAlertIcon :class="['w-5 h-5', riskColor]" />
          <h3 class="text-lg font-semibold flex-1 truncate">
            {{ request.title }}
          </h3>
          <span
            :class="['ml-auto text-xs px-2 py-0.5 rounded-full whitespace-nowrap', riskBadgeClass]"
          >
            {{ riskLabel }}
          </span>
        </div>
      </div>

      <!-- body -->
      <div class="p-4 max-h-96 overflow-y-auto">
        <pre
          v-if="request.detail"
          class="font-mono text-[12px] text-foreground bg-code-block p-3 rounded whitespace-pre-wrap overflow-x-auto"
          >{{ request.detail }}</pre>
      </div>

      <!-- footer -->
      <div class="p-4 border-t border-border flex items-center justify-between gap-2">
        <span class="text-xs text-muted-foreground">Claude 请求执行此操作</span>
        <div class="flex gap-2">
          <Button variant="outline" size="sm" @click="onReject">拒绝（Esc）</Button>
          <Button
            :variant="request.riskLevel === 'high' ? 'destructive' : 'default'"
            size="sm"
            @click="onApprove"
          >
            允许（Enter）
          </Button>
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

const request = computed(() => messageStore.pendingClaudePermission!.request)

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

async function onApprove(): Promise<void> {
  await window.api.backend.respondApproval({
    requestId: messageStore.pendingClaudePermission!.requestId,
    action: 'approve',
  })
  messageStore.pendingClaudePermission = null
}

async function onReject(): Promise<void> {
  await window.api.backend.respondApproval({
    requestId: messageStore.pendingClaudePermission!.requestId,
    action: 'reject',
  })
  messageStore.pendingClaudePermission = null
}

function onKey(e: KeyboardEvent): void {
  // 在 textarea / input 里不拦截（dialog 没有 input，但兜底）
  const target = e.target as HTMLElement | null
  if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return
  if (e.key === 'Enter') {
    e.preventDefault()
    void onApprove()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    void onReject()
  }
}

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>
