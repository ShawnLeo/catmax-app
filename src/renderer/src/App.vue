<template>
  <div class="h-full">
    <RouterView />
  </div>
</template>

<script setup lang="ts">
import { useTheme } from '@renderer/composables/useTheme'
import { useSettingsStore } from '@renderer/stores/settings'
import { onMounted } from 'vue'

const settings = useSettingsStore()
const { apply } = useTheme()

onMounted(async () => {
  await settings.load()
  if (settings.settings) {
    apply(settings.settings.theme.mode)
  }
})
</script>
