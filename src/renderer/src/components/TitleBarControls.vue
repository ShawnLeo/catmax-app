<template>
  <div class="titlebar-controls flex items-center gap-1.5">
    <!-- macOS: 红绿灯风格 -->
    <template v-if="platform === 'darwin'">
      <button
        class="w-3.5 h-3.5 rounded-full bg-[#ff5f57] hover:bg-[#ff4b43] transition-colors cursor-pointer"
        title="关闭"
        @click="windowClose"
      />
      <button
        class="w-3.5 h-3.5 rounded-full bg-[#febc2e] hover:bg-[#e5a826] transition-colors cursor-pointer"
        title="最小化"
        @click="windowMinimize"
      />
      <button
        class="w-3.5 h-3.5 rounded-full bg-[#28c840] hover:bg-[#1aab2f] transition-colors cursor-pointer"
        :title="isMaximized ? '还原' : '最大化'"
        @click="windowMaximize"
      />
    </template>

    <!-- Windows/Linux: 标准按钮 -->
    <template v-else>
      <button
        class="w-8 h-8 flex items-center justify-center rounded hover:bg-muted transition-colors cursor-pointer"
        title="最小化"
        @click="windowMinimize"
      >
        <MinusIcon class="w-4 h-4" />
      </button>
      <button
        class="w-8 h-8 flex items-center justify-center rounded hover:bg-muted transition-colors cursor-pointer"
        :title="isMaximized ? '还原' : '最大化'"
        @click="windowMaximize"
      >
        <svg
          v-if="!isMaximized"
          class="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" stroke-width="2" />
        </svg>
        <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <rect x="3" y="3" width="14" height="14" rx="2" stroke-width="2" />
          <rect x="11" y="11" width="10" height="10" rx="2" stroke-width="2" />
        </svg>
      </button>
      <button
        class="w-8 h-8 flex items-center justify-center rounded hover:bg-destructive hover:text-destructive-foreground transition-colors cursor-pointer"
        title="关闭"
        @click="windowClose"
      >
        <XIcon class="w-4 h-4" />
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { MinusIcon, XIcon } from 'lucide-vue-next'
import { onMounted, ref } from 'vue'

const platform = ref<'darwin' | 'win32' | 'linux'>('darwin')
const isMaximized = ref(false)

onMounted(async () => {
  // 获取平台信息
  const info = await window.api.system.platformInfo()
  platform.value = info.platform

  // 获取窗口最大化状态
  isMaximized.value = await window.api.system.windowIsMaximized()

  // 监听窗口最大化状态变化（需要在 Electron 端实现事件推送）
  // 这里简化处理：每次点击最大化按钮后更新状态
})

async function windowMinimize(): Promise<void> {
  await window.api.system.windowMinimize()
}

async function windowMaximize(): Promise<void> {
  await window.api.system.windowMaximize()
  isMaximized.value = await window.api.system.windowIsMaximized()
}

async function windowClose(): Promise<void> {
  await window.api.system.windowClose()
}
</script>

<style scoped>
.titlebar-controls {
  -webkit-app-region: no-drag;
}

.titlebar-controls button {
  -webkit-app-region: no-drag;
}
</style>
