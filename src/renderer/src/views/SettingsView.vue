<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-2xl mx-auto p-8 flex flex-col gap-8">
      <header class="flex items-center justify-between">
        <h1 class="text-2xl font-bold text-foreground">设置</h1>
        <Button variant="ghost" size="sm" @click="goBack">返回</Button>
      </header>

      <ThemeSection />
      <BackendSection />
      <WorkspaceSection />
      <ProxySection />

      <section class="flex flex-col gap-4">
        <header>
          <h2 class="text-lg font-semibold text-foreground">关于</h2>
        </header>
        <div class="text-sm text-muted-foreground space-y-1">
          <div>catmax v{{ platformInfo?.appVersion ?? '...' }}</div>
          <div>Electron v{{ platformInfo?.electronVersion ?? '...' }}</div>
          <div>{{ platformInfo?.platform ?? '...' }} {{ platformInfo?.arch ?? '' }}</div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import BackendSection from '@renderer/components/settings/BackendSection.vue'
import ProxySection from '@renderer/components/settings/ProxySection.vue'
import ThemeSection from '@renderer/components/settings/ThemeSection.vue'
import WorkspaceSection from '@renderer/components/settings/WorkspaceSection.vue'
import { Button } from '@renderer/components/ui/button'
import type { PlatformInfo } from '@shared/ipc/system'
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const platformInfo = ref<PlatformInfo | null>(null)

onMounted(async () => {
  platformInfo.value = await window.api.system.platformInfo()
})

/**
 * 返回上一页——优先用浏览器历史（router.back），
 * 这样从哪进来就回哪去（chat → settings → chat；welcome → settings → welcome）。
 *
 * 兜底：如果用户直接刷新 settings 页（没有历史记录，back 无效），
 * 按 workspace 状态决定去 chat（选过 workspace）还是 welcome（没选过）。
 */
function goBack(): void {
  // router.back() 内部判断 history.length，没有可回退的会 no-op
  // 通过 history.state 判断有没有上一页可回（vue-router 在 history.state 上挂了 back 字段）
  if (window.history.length > 1) {
    router.back()
    return
  }
  // 直接刷新进 settings 的情况——按 workspace 选过与否决定去向
  const lastWorkspaceId = localStorage.getItem('last_workspace_id')
  if (lastWorkspaceId) {
    router.push('/chat')
  } else {
    router.push('/')
  }
}
</script>
