<template>
  <section class="flex flex-col gap-4">
    <header>
      <h2 class="text-[length:var(--ui-text-u3)] font-semibold text-foreground">外观</h2>
      <p class="text-[length:var(--ui-text-base)] text-muted-foreground">主题、字体设置</p>
    </header>

    <div class="flex flex-col gap-3">
      <!-- 主题模式 -->
      <div class="flex items-center justify-between">
        <label class="text-[length:var(--ui-text-base)] font-medium">主题</label>
        <div class="flex gap-1 rounded-md bg-muted p-1">
          <button
            v-for="mode in ['light', 'dark', 'system'] as const"
            :key="mode"
            :class="[
              'px-3 py-1 text-[length:var(--ui-text-d3)] rounded transition-colors cursor-pointer',
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

      <!-- UI 字号：聊天区之外（侧边栏 / 面板 / 设置页 / 命令面板）的正文基准 -->
      <div class="flex items-center justify-between">
        <div>
          <label class="text-[length:var(--ui-text-base)] font-medium">UI 字号</label>
          <p class="text-[length:var(--ui-text-d3)] text-muted-foreground">
            侧边栏、面板、设置页等界面文字，不含对话内容
          </p>
        </div>
        <Input
          type="number"
          :model-value="settings.settings?.theme.fontSize ?? ''"
          :min="11"
          :max="20"
          class="w-20"
          @update:model-value="(v) => updateFontSize('fontSize', v)"
        />
      </div>

      <!-- 聊天字号：对话正文与 Markdown（含标题）的基准 -->
      <div class="flex items-center justify-between">
        <div>
          <label class="text-[length:var(--ui-text-base)] font-medium">聊天字号</label>
          <p class="text-[length:var(--ui-text-d3)] text-muted-foreground">
            对话正文与 Markdown，标题按比例跟着缩放
          </p>
        </div>
        <Input
          type="number"
          :model-value="settings.settings?.theme.chatFontSize ?? ''"
          :min="11"
          :max="20"
          class="w-20"
          @update:model-value="(v) => updateFontSize('chatFontSize', v)"
        />
      </div>

      <!-- 代码字号：等宽区域（代码块 / diff / 终端 / 文件预览）的基准 -->
      <div class="flex items-center justify-between">
        <div>
          <label class="text-[length:var(--ui-text-base)] font-medium">代码字号</label>
          <p class="text-[length:var(--ui-text-d3)] text-muted-foreground">
            代码块、diff、终端、文件预览
          </p>
        </div>
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
const { applyChatFontSize, applyCodeFontSize, applyUiFontSize, setMode } = useTheme()

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
  // 字号立即生效——都是 CSS 变量，不需要重挂组件。
  // 终端和 diff 另外从 settings 直接读 codeFontSize（它们的字号是 JS 参数），
  // store 更新后自己会响应，这里不用管。
  if (field === 'fontSize') applyUiFontSize(num)
  if (field === 'chatFontSize') applyChatFontSize(num)
  if (field === 'codeFontSize') applyCodeFontSize(num)
}
</script>
