<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    @click.self="onReject"
  >
    <div
      class="bg-card text-card-foreground rounded-lg shadow-xl max-w-2xl w-full mx-4 overflow-hidden"
    >
      <div class="p-4 border-b border-border">
        <div class="flex items-center gap-2">
          <ShieldAlertIcon :class="['w-5 h-5', riskColor]" />
          <h3 class="text-lg font-semibold">
            {{ approval.request.title }}
          </h3>
          <span :class="['ml-auto text-xs px-2 py-0.5 rounded-full', riskBadgeClass]">
            {{ approval.request.riskLevel }}
          </span>
        </div>
      </div>

      <div class="p-4 max-h-96 overflow-y-auto">
        <pre
          v-if="approval.request.detail"
          class="font-mono text-[12px] text-foreground bg-code-block p-3 rounded whitespace-pre-wrap overflow-x-auto"
          >{{ approval.request.detail }}</pre>
      </div>

      <div class="p-4 border-t border-border flex items-center justify-between gap-2">
        <span class="text-xs text-muted-foreground">codex 请求执行此操作</span>
        <div class="flex gap-2">
          <Button variant="outline" size="sm" @click="onReject"> 拒绝（Esc） </Button>
          <Button
            v-if="approval.request.riskLevel !== 'high'"
            variant="secondary"
            size="sm"
            @click="onApproveAlways"
          >
            本会话都允许
          </Button>
          <Button
            :variant="approval.request.riskLevel === 'high' ? 'destructive' : 'default'"
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

const approval = computed(() => messageStore.pendingApproval!)

const riskColor = computed(() => {
  switch (approval.value.request.riskLevel) {
    case 'high':
      return 'text-destructive'
    case 'medium':
      return 'text-warning'
    default:
      return 'text-muted-foreground'
  }
})

const riskBadgeClass = computed(() => {
  switch (approval.value.request.riskLevel) {
    case 'high':
      return 'bg-destructive/10 text-destructive'
    case 'medium':
      return 'bg-warning/10 text-warning'
    default:
      return 'bg-muted text-muted-foreground'
  }
})

async function onApprove(): Promise<void> {
  await window.api.backend.respondApproval({
    requestId: approval.value.requestId,
    action: 'approve',
  })
  messageStore.pendingApproval = null
}

async function onApproveAlways(): Promise<void> {
  await window.api.backend.respondApproval({
    requestId: approval.value.requestId,
    action: 'approve_always',
  })
  messageStore.pendingApproval = null
}

async function onReject(): Promise<void> {
  await window.api.backend.respondApproval({
    requestId: approval.value.requestId,
    action: 'reject',
  })
  messageStore.pendingApproval = null
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Enter') onApprove()
  else if (e.key === 'Escape') onReject()
}

onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>
