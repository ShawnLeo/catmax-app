<template>
  <!-- 窗口置顶开关：与聊天运行时栏、设置页、欢迎页共用同一份状态（useAlwaysOnTop），
       任一处切换，其余处立即同步。 -->
  <button
    type="button"
    class="always-on-top-button p-1.5 rounded-md transition-colors"
    :class="isAlwaysOnTop ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'"
    :title="isAlwaysOnTop ? '取消置顶' : '置顶窗口'"
    :aria-label="isAlwaysOnTop ? '取消置顶' : '置顶窗口'"
    :aria-pressed="isAlwaysOnTop"
    @click="toggleAlwaysOnTop"
  >
    <PinIcon class="w-4 h-4" :fill="isAlwaysOnTop ? 'currentColor' : 'none'" />
  </button>
</template>

<script setup lang="ts">
import { useAlwaysOnTop } from '@renderer/composables/useAlwaysOnTop'
import { PinIcon } from 'lucide-vue-next'
import { onMounted } from 'vue'

const { isAlwaysOnTop, initAlwaysOnTop, toggleAlwaysOnTop } = useAlwaysOnTop()

onMounted(() => {
  void initAlwaysOnTop()
})
</script>

<style scoped>
/* 这颗按钮会出现在声明了 -webkit-app-region: drag 的顶条里，
   必须自己声明 no-drag 才能被点击（不依赖父页面的 .interactive 类）。 */
.always-on-top-button {
  -webkit-app-region: no-drag;
}
</style>
