<template>
  <!--
    Update Card: 侧栏底部、账号栏正上方的更新提示卡片。
    只在"已下载待重启"时出现——检查与下载全程静默（设计文档 §5.6）。
  -->
  <div v-if="updateStore.showCard" class="update-card px-2 pt-2">
    <button
      type="button"
      class="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-border bg-popover text-left transition-colors"
      :class="blocked ? 'cursor-not-allowed opacity-60' : 'hover:bg-accent cursor-pointer'"
      :disabled="blocked || updateStore.applying"
      :title="blocked ? blockedReason : '重启以应用更新'"
      @click="onApply"
    >
      <div class="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
        <ArrowUpCircleIcon class="w-4 h-4 text-primary" />
      </div>

      <div class="flex-1 min-w-0">
        <div class="text-[length:var(--ui-text-d3)] text-foreground truncate">
          {{ blocked ? '更新已就绪' : '重启以更新' }}
        </div>
        <div class="text-[length:var(--ui-text-d4)] text-muted-foreground truncate">
          {{ blocked ? blockedReason : updateStore.status.stagedVersion }}
        </div>
      </div>

      <ArrowRightIcon v-if="!blocked" class="w-4 h-4 text-muted-foreground flex-shrink-0" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { useUpdateStore } from '@renderer/stores/update'
import { ArrowRightIcon, ArrowUpCircleIcon } from 'lucide-vue-next'
import { computed } from 'vue'

const updateStore = useUpdateStore()

// §5.7：有活跃 turn 时置灰并说明原因，而不是弹"确定要中断吗"——
// 用户在这个场景下几乎总会误点，而被中断的 turn 无法恢复。
const blocked = computed(() => updateStore.status.activeTurns > 0)
const blockedReason = computed(
  () => `还有 ${updateStore.status.activeTurns} 个会话正在运行，暂时无法重启`,
)

async function onApply(): Promise<void> {
  if (blocked.value) return
  const result = await updateStore.apply()
  // 成功时进程直接退出，走不到这里。能走到说明 main 侧门禁在点击瞬间拦下了它
  // （UI 拿到的 activeTurns 是推送快照，点击那一刻可能已经有新 turn 开始）。
  if (!result.ok && result.reason) window.alert(result.reason)
}
</script>

<style scoped>
/* Panel Depth: 卡片贴在账号栏上方，与 sidebar-footer 的上浮阴影连成一体 */
.update-card {
  background: var(--sidebar);
}
</style>
