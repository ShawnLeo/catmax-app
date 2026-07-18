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
import { ref } from 'vue'
import { onMounted } from 'vue'

const commandPaletteVisible = ref(false)

const settings = useSettingsStore()
const { apply } = useTheme()

onMounted(async () => {
  await settings.load()
  if (settings.settings) {
    apply(settings.settings.theme.mode)
  }
})
</script>
