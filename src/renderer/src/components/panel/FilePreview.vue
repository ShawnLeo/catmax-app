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
    <div class="flex-1 overflow-auto bg-code-block relative">
      <div v-if="preview.isBinary" class="p-4 text-xs text-muted-foreground">
        二进制文件（{{ formatBytes(preview.size) }}）
      </div>
      <!--
        代码区：select-text 允许鼠标选行，mouseup 时反推行号。
        每行包一层 data-line 的 span 让 selection API 能拿到 anchorNode 的行号——
        比 indexOf 反推更稳（同文件重复内容不会误匹配）。
      -->
      <pre
        v-else-if="preview.content && highlighted"
        class="text-xs font-mono p-3 text-foreground whitespace-pre-wrap select-text"
        @mouseup="onSelectionChange"
      ><code v-html="highlighted" /></pre>
      <div
        v-if="preview.truncated"
        class="px-3 py-1 text-xs text-muted-foreground border-t border-border"
      >
        文件过大，只显示前 256KB
      </div>

      <!-- 浮动"添加到对话"按钮——selection 不空时显示 -->
      <button
        v-if="selectionInfo"
        type="button"
        class="sticky bottom-2 ml-auto mr-2 flex items-center gap-1 px-2 py-1 rounded-md bg-primary text-primary-foreground text-xs shadow-lg hover:bg-primary/90 transition-colors"
        @click="addToChat"
      >
        <PlusIcon class="w-3 h-3" />
        添加 {{ selectionInfo.lineCount }} 行到对话
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { renderMarkdown } from '@renderer/lib/markdown'
import { ideSelectionAttachment, useChatInputStore } from '@renderer/stores/chat-input'
import { useFilesStore } from '@renderer/stores/files'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { FileIcon, PlusIcon } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'

const filesStore = useFilesStore()
const workspaceStore = useWorkspaceStore()
const chatInput = useChatInputStore()
const preview = computed(() => filesStore.currentPreview!)
const highlighted = ref('')
const selectionInfo = ref<{
  startLine: number
  endLine: number
  text: string
  lineCount: number
} | null>(null)

watch(
  () => filesStore.currentPreview,
  async (p) => {
    if (!p || !p.content) {
      highlighted.value = ''
      return
    }
    selectionInfo.value = null
    // 用 Shiki 高亮（如果是已知语言）—— 为了 selection 反推行号，需要每行包 data-line 属性。
    // 实现：先 renderMarkdown 拿 HTML，再把每个 .line 元素打上 data-line=index。
    if (p.language) {
      try {
        const fenced = '```' + p.language + '\n' + p.content + '\n```'
        const html = await renderMarkdown(fenced)
        const match = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)
        const inner = match ? match[1]! : escapeHtml(p.content)
        // Shiki 输出 <span class="line">...</span>——加 data-line
        let lineIdx = 0
        const withDataLine = inner.replace(/<span class="line">/g, () => {
          lineIdx += 1
          return `<span class="line" data-line="${lineIdx}">`
        })
        highlighted.value = withDataLine
      } catch {
        highlighted.value = escapeHtml(p.content)
      }
    } else {
      highlighted.value = escapeHtml(p.content)
    }
  },
  { immediate: true },
)

/**
 * 鼠标松开时检测 selection——拿 anchorNode / focusNode 最近 .line 祖先的 data-line。
 * 取 startLine = min, endLine = max（处理反向选择）。文本走 selection.toString()。
 */
function onSelectionChange(): void {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    selectionInfo.value = null
    return
  }
  const text = sel.toString()
  if (!text.trim()) {
    selectionInfo.value = null
    return
  }
  const startLine = lineOf(sel.anchorNode)
  const endLine = lineOf(sel.focusNode)
  if (startLine === null || endLine === null) {
    selectionInfo.value = null
    return
  }
  const lo = Math.min(startLine, endLine)
  const hi = Math.max(startLine, endLine)
  selectionInfo.value = {
    startLine: lo,
    endLine: hi,
    text,
    lineCount: hi - lo + 1,
  }
}

/** 找 node 最近祖先的 data-line（向父级爬直到找到 .line span） */
function lineOf(node: Node | null): number | null {
  let el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement | null)
  while (el && !el.dataset.line) {
    el = el.parentElement
  }
  const n = el?.dataset.line
  return n ? parseInt(n, 10) : null
}

function addToChat(): void {
  if (!selectionInfo.value) return
  chatInput.addAttachment(
    ideSelectionAttachment({
      filePath: preview.value.relativePath,
      startLine: selectionInfo.value.startLine,
      endLine: selectionInfo.value.endLine,
      code: selectionInfo.value.text,
    }),
  )
  // 清掉当前 selection（视觉反馈：被收走了）
  window.getSelection()?.removeAllRanges()
  selectionInfo.value = null
}

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
