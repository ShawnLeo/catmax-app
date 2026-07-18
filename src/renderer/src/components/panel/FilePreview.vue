<template>
  <div class="flex flex-col">
    <!-- 头部：路径 + 操作 -->
    <div class="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/50">
      <FileIcon class="w-3 h-3 text-muted-foreground flex-shrink-0" />
      <span class="text-xs font-mono text-foreground truncate flex-1">
        {{ preview.relativePath }}
      </span>
      <button class="text-xs text-primary hover:underline flex-shrink-0" @click="openInEditor">
        在编辑器中打开
      </button>
    </div>

    <!-- 内容 -->
    <div class="flex-1 overflow-auto bg-code-block">
      <div v-if="preview.isBinary" class="p-4 text-xs text-muted-foreground">
        二进制文件（{{ formatBytes(preview.size) }}）
      </div>
      <pre
        v-else-if="preview.content"
        class="text-xs font-mono p-3 text-foreground whitespace-pre-wrap"
      ><code v-html="highlighted"/></pre>
      <div
        v-if="preview.truncated"
        class="px-3 py-1 text-xs text-muted-foreground border-t border-border"
      >
        文件过大，只显示前 256KB
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { renderMarkdown } from '@renderer/lib/markdown'
import { useFilesStore } from '@renderer/stores/files'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { FileIcon } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'

const filesStore = useFilesStore()
const workspaceStore = useWorkspaceStore()
const preview = computed(() => filesStore.currentPreview!)
const highlighted = ref('')

watch(
  () => filesStore.currentPreview,
  async (p) => {
    if (!p || !p.content) {
      highlighted.value = ''
      return
    }
    // 用 Shiki 高亮（如果是已知语言）
    if (p.language) {
      try {
        // 包成 code block 让 markdown-it + shiki 处理
        const fenced = '```' + p.language + '\n' + p.content + '\n```'
        const html = await renderMarkdown(fenced)
        // 提取 <pre><code> 部分
        const match = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)
        highlighted.value = match ? match[1]! : escapeHtml(p.content)
      } catch {
        highlighted.value = escapeHtml(p.content)
      }
    } else {
      highlighted.value = escapeHtml(p.content)
    }
  },
  { immediate: true },
)

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!)
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function openInEditor(): Promise<void> {
  if (!workspaceStore.currentWorkspace) return
  const result = await filesStore.openInEditor(
    workspaceStore.currentWorkspace.id,
    preview.value.relativePath,
  )
  if (!result.launched && result.error) {
    window.alert(result.error)
  }
}
</script>
