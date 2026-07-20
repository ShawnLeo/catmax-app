<template>
  <div class="h-full overflow-y-auto">
    <div class="max-w-2xl mx-auto p-8 flex flex-col gap-8">
      <header class="flex items-center justify-between">
        <h1 class="text-2xl font-bold text-foreground">设置</h1>
        <Button variant="ghost" size="sm" @click="router.push('/')">返回</Button>
      </header>

      <ThemeSection />
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
import ThemeSection from '@renderer/components/settings/ThemeSection.vue'
import WorkspaceSection from '@renderer/components/settings/WorkspaceSection.vue'
import ProxySection from '@renderer/components/settings/ProxySection.vue'
import { Button } from '@renderer/components/ui/button'
import type { PlatformInfo } from '@shared/ipc/system'
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const platformInfo = ref<PlatformInfo | null>(null)

onMounted(async () => {
  platformInfo.value = await window.api.system.platformInfo()
})
</script>
