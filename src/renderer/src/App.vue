<template>
  <div class="h-full">
    <RouterView />

    <CommandPalette v-model:visible="commandPaletteVisible" />
  </div>
</template>

<script setup lang="ts">
import CommandPalette from '@renderer/components/command/CommandPalette.vue'
import { useTheme } from '@renderer/composables/useTheme'
import { useSettingsStore } from '@renderer/stores/settings'
import { useUiStore } from '@renderer/stores/ui'
import { computed } from 'vue'
import { onMounted } from 'vue'

const uiStore = useUiStore()

// 双向绑定到 uiStore.commandPaletteVisible（让命令系统的 mod+k 能控制 palette）
const commandPaletteVisible = computed({
  get: () => uiStore.commandPaletteVisible,
  set: (v: boolean) => {
    if (v) uiStore.openCommandPalette()
    else uiStore.closeCommandPalette()
  },
})

const settings = useSettingsStore()
const { apply } = useTheme()

onMounted(async () => {
  await settings.load()
  if (settings.settings) {
    apply(settings.settings.theme.mode)
  }
})
</script>
