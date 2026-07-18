<template>
  <section class="flex flex-col gap-4">
    <header>
      <h2 class="text-lg font-semibold text-foreground">外观</h2>
      <p class="text-sm text-muted-foreground">主题、字体设置</p>
    </header>

    <div class="flex flex-col gap-3">
      <!-- 主题模式 -->
      <div class="flex items-center justify-between">
        <label class="text-sm font-medium">主题</label>
        <div class="flex gap-1 rounded-md bg-muted p-1">
          <button
            v-for="mode in ['light', 'dark', 'system'] as const"
            :key="mode"
            :class="[
              'px-3 py-1 text-xs rounded transition-colors',
              currentMode === mode
                ? 'bg-background text-foreground shadow'
                : 'text-muted-foreground hover:text-foreground',
            ]"
            @click="setMode(mode)"
          >
            {{ modeLabel(mode) }}
          </button>
        </div>
      </div>

      <!-- UI 字号 -->
      <div class="flex items-center justify-between">
        <label class="text-sm font-medium">UI 字号</label>
        <Input
          type="number"
          :model-value="settings.settings?.theme.fontSize ?? ''"
          :min="11"
          :max="20"
          class="w-20"
          @update:model-value="(v) => updateFontSize('fontSize', v)"
        />
      </div>

      <!-- 聊天字号 -->
      <div class="flex items-center justify-between">
        <label class="text-sm font-medium">聊天字号</label>
        <Input
          type="number"
          :model-value="settings.settings?.theme.chatFontSize ?? ''"
          :min="11"
          :max="20"
          class="w-20"
          @update:model-value="(v) => updateFontSize('chatFontSize', v)"
        />
      </div>

      <!-- 代码字号 -->
      <div class="flex items-center justify-between">
        <label class="text-sm font-medium">代码字号</label>
        <Input
          type="number"
          :model-value="settings.settings?.theme.codeFontSize ?? ''"
          :min="10"
          :max="18"
          class="w-20"
          @update:model-value="(v) => updateFontSize('codeFontSize', v)"
        />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Input } from '@renderer/components/ui/input'
import { useTheme } from '@renderer/composables/useTheme'
import { useSettingsStore } from '@renderer/stores/settings'
import type { ThemeMode } from '@shared/settings-schema'
import { computed } from 'vue'

const settings = useSettingsStore()
const { setMode } = useTheme()

const currentMode = computed<ThemeMode>(() => settings.settings?.theme.mode ?? 'system')

function modeLabel(mode: ThemeMode): string {
  return { light: '日间', dark: '夜间', system: '跟随系统' }[mode]
}

async function updateFontSize(
  field: 'fontSize' | 'chatFontSize' | 'codeFontSize',
  value: string | number,
): Promise<void> {
  const num = typeof value === 'string' ? Number.parseInt(value, 10) : value
  if (Number.isNaN(num)) return
  await settings.update({
    theme: { ...settings.settings!.theme, [field]: num },
  })
}
</script>
