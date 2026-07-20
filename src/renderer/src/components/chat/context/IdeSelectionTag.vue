<template>
  <!--
    IDE 选中代码片段标签——Claude Code 官方风样式。

    收起态：单行 muted 灰文字 + TextSelectIcon + "Selected N lines from path:L1-L2"
    展开态：下方多一个代码预览块（带语法高亮）

    点击切换收起/展开。
  -->
  <div class="text-[13px]">
    <button
      type="button"
      class="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors text-left group"
      @click="expanded = !expanded"
    >
      <TextSelectIcon class="w-3.5 h-3.5 flex-shrink-0" />
      <span class="leading-tight">
        Selected {{ lineCount }} {{ lineCount === 1 ? 'line' : 'lines' }} from
        <span class="font-mono text-[12px]">{{ shortPath }}:{{ data.startLine }}-{{
          data.endLine
        }}</span>
      </span>
      <ChevronDownIcon
        :class="['w-3 h-3 flex-shrink-0 transition-transform', expanded ? 'rotate-180' : '']"
      />
    </button>

    <div
      v-if="expanded"
      class="mt-1.5 rounded-md border border-border bg-code-block overflow-hidden"
    >
      <pre
        v-if="data.code"
        class="text-xs font-mono p-3 text-foreground whitespace-pre overflow-x-auto"
      ><code v-html="highlighted"/></pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { IdeSelectionData } from '@shared/backend/context-tag-types'
import { renderMarkdown } from '@renderer/lib/markdown'
import { basename } from '@renderer/lib/path'
import { ChevronDownIcon, TextSelectIcon } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'

const props = defineProps<{ data: IdeSelectionData }>()

const expanded = ref(false)
const highlighted = ref('')

const lineCount = computed(() => props.data.endLine - props.data.startLine + 1)

/** 只显示文件名（basename）——完整路径太长 truncate 会把文件名截没。
 *  完整路径在 button 的 title 属性里 hover 可见。
 */
const shortPath = computed(() => basename(props.data.filePath))

watch(
  expanded,
  async (open) => {
    if (!open || highlighted.value || !props.data.code) return
    // 包成 fenced code block 走 Shiki——跟 FilePreview.vue 一致
    const lang = guessLang(props.data.filePath)
    try {
      const fenced = '```' + lang + '\n' + props.data.code + '\n```'
      const html = await renderMarkdown(fenced)
      const match = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)
      highlighted.value = match ? match[1]! : escapeHtml(props.data.code)
    } catch {
      highlighted.value = escapeHtml(props.data.code)
    }
  },
  { immediate: true },
)

function guessLang(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  // 常见扩展名映射，其他原样返回（Shiki 会 fallback 到 text）
  const map: Record<string, string> = {
    ts: 'ts',
    tsx: 'tsx',
    js: 'js',
    jsx: 'jsx',
    vue: 'vue',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    md: 'markdown',
    json: 'json',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'bash',
    zsh: 'bash',
    sql: 'sql',
    html: 'html',
    css: 'css',
    scss: 'scss',
  }
  return map[ext] ?? ext ?? 'text'
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
}
</script>
