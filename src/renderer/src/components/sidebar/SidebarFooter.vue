<template>
  <div class="sidebar-footer p-2 border-t border-sidebar-border bg-sidebar flex items-center gap-1">
    <!-- 用户信息（预留）—— 后续接入登录态后填充头像/用户名 -->
    <button
      class="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-sidebar-accent text-left cursor-pointer"
      :title="'用户信息（即将推出）'"
      @click="onUserClick"
    >
      <!-- 头像占位：灰色圆形 + user icon -->
      <div
        class="w-6 h-6 rounded-full bg-sidebar-accent flex items-center justify-center flex-shrink-0"
      >
        <UserIcon class="w-3.5 h-3.5 text-muted-foreground" />
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-[length:var(--ui-text-d3)] text-foreground truncate">未登录</div>
      </div>
    </button>

    <!-- 设置入口（纯图标） -->
    <button
      class="p-1.5 rounded-md hover:bg-sidebar-accent text-muted-foreground hover:text-foreground flex-shrink-0 cursor-pointer"
      title="设置"
      @click="openSettings"
    >
      <SettingsIcon class="w-4 h-4" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { SettingsIcon, UserIcon } from 'lucide-vue-next'
import { useRouter } from 'vue-router'

const router = useRouter()

function openSettings(): void {
  router.push('/settings')
}

function onUserClick(): void {
  // 预留——后续接入用户系统后再实现。
  // 暂时跳到设置页（用户可能在设置里能配 token 之类的）
  router.push('/settings')
}
</script>

<style scoped>
/* Panel Depth: 底部操作栏轻微浮在会话列表之上，阴影向上柔和发散。 */
.sidebar-footer {
  position: relative;
  z-index: 10;
  box-shadow: 0 -8px 20px -14px var(--panel-edge-shadow);
}
</style>
