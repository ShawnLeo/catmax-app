<template>
  <div class="h-full min-w-0 flex flex-col bg-background">
    <!-- File Preview Tabs: 多文件保持打开状态，支持切换、中键关闭和独立加载状态。 -->
    <div
      class="h-9 flex items-stretch overflow-x-auto overflow-y-hidden border-b border-border bg-card"
      role="tablist"
      aria-label="打开的文件"
    >
      <div
        v-for="tab in filesStore.previewTabs"
        :key="tab.relativePath"
        :class="[
          'group/tab min-w-0 max-w-48 shrink-0 flex items-center border-r border-border/70',
          tab.relativePath === filesStore.activePreviewPath
            ? 'bg-background text-foreground'
            : 'bg-muted/20 text-muted-foreground hover:bg-muted/45 hover:text-foreground',
        ]"
        @mousedown.middle.prevent="filesStore.closePreview(tab.relativePath)"
      >
        <button
          type="button"
          role="tab"
          :aria-selected="tab.relativePath === filesStore.activePreviewPath"
          :title="tab.relativePath"
          class="h-full min-w-0 flex-1 flex items-center gap-1.5 pl-2.5 pr-1 text-xs"
          @click="filesStore.selectPreview(tab.relativePath)"
        >
          <FileTypeIcon
            :name="tab.preview?.name ?? fileName(tab.relativePath)"
            class="w-4 h-4 shrink-0"
          />
          <span class="truncate">{{ tab.preview?.name ?? fileName(tab.relativePath) }}</span>
          <LoaderCircleIcon v-if="tab.loading" class="w-3 h-3 shrink-0 animate-spin" />
        </button>
        <button
          type="button"
          class="w-6 h-6 mr-1 grid place-items-center rounded opacity-0 group-hover/tab:opacity-100 hover:bg-muted/80 focus:opacity-100"
          :aria-label="`关闭 ${fileName(tab.relativePath)}`"
          title="关闭文件"
          @click.stop="filesStore.closePreview(tab.relativePath)"
        >
          <XIcon class="w-3 h-3" />
        </button>
      </div>
      <div class="min-w-4 flex-1 border-b border-transparent" />
    </div>

    <!-- File Preview Toolbar: 显示活动路径，并提供刷新与外部编辑器入口。 -->
    <div class="h-10 flex items-center gap-1.5 px-2.5 border-b border-border/70 bg-card/70">
      <FileTypeIcon v-if="preview" :name="preview.name" class="w-[18px] h-[18px] shrink-0" />
      <div class="min-w-0 flex-1 text-xs truncate" :title="fullPath">
        <span class="text-muted-foreground"
          >{{ workspaceStore.currentWorkspace?.name ?? '工作区' }}/</span
        >
        <span v-if="parentPath" class="text-muted-foreground">{{ parentPath }}/</span>
        <span class="text-foreground">{{ pathParts[pathParts.length - 1] }}</span>
      </div>
      <div
        v-if="preview?.kind === 'markdown'"
        class="h-7 flex items-center rounded-md bg-muted/60 p-0.5"
        role="group"
        aria-label="Markdown 显示模式"
      >
        <button
          type="button"
          :class="['markdown-mode', { 'markdown-mode-active': markdownMode === 'preview' }]"
          @click="markdownMode = 'preview'"
        >
          预览
        </button>
        <button
          type="button"
          :class="['markdown-mode', { 'markdown-mode-active': markdownMode === 'source' }]"
          @click="markdownMode = 'source'"
        >
          源码
        </button>
      </div>
      <button v-if="preview" type="button" class="preview-action" title="重新载入" @click="reload">
        <RefreshCwIcon class="w-3.5 h-3.5" />
      </button>
      <button
        v-if="preview"
        type="button"
        class="preview-action"
        title="在编辑器中打开"
        @click="openInEditor"
      >
        <ExternalLinkIcon class="w-3.5 h-3.5" />
      </button>
    </div>

    <div
      v-if="filesStore.previewLoading"
      class="flex-1 grid place-items-center text-xs text-muted-foreground"
    >
      <div class="flex flex-col items-center gap-2">
        <LoaderCircleIcon class="w-5 h-5 animate-spin" />
        正在生成预览…
      </div>
    </div>

    <div v-else-if="filesStore.previewError" class="flex-1 grid place-items-center p-6 text-center">
      <div class="flex flex-col items-center gap-2">
        <CircleAlertIcon class="w-7 h-7 text-danger" />
        <div class="text-sm font-medium">无法预览文件</div>
        <div class="text-xs text-muted-foreground break-all">{{ filesStore.previewError }}</div>
      </div>
    </div>

    <!-- File Preview Content: kind 是唯一分发依据，各类文件共享加载、错误与元数据外壳。 -->
    <template v-else-if="preview">
      <div class="flex-1 min-h-0 overflow-auto bg-background/45 relative">
        <MarkdownView
          v-if="preview.kind === 'markdown' && preview.content && markdownMode === 'preview'"
          :text="preview.content"
          compact
          class="p-5 text-[13px]"
        />

        <div
          v-else-if="
            preview.kind === 'markdown' && preview.content !== null && markdownMode === 'source'
          "
          class="min-w-max"
        >
          <pre
            class="file-code-preview text-[12px] font-mono py-3 pr-3 text-foreground select-text"
            @mouseup="onSelectionChange"
          ><code v-html="highlighted" /></pre>
        </div>

        <div v-else-if="preview.kind === 'table' && preview.content" class="p-3 min-w-max">
          <table class="border-collapse text-[11px] font-mono">
            <tbody>
              <tr v-for="(row, rowIndex) in tableRows" :key="rowIndex">
                <td
                  v-for="(cell, columnIndex) in row"
                  :key="columnIndex"
                  :class="[
                    'px-2 py-1 border border-border whitespace-pre',
                    rowIndex === 0 ? 'bg-muted font-semibold' : 'bg-card',
                  ]"
                >
                  {{ cell }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div
          v-else-if="preview.kind === 'image'"
          class="h-full min-h-64 grid place-items-center p-5 checkerboard"
        >
          <img
            v-if="preview.dataUrl"
            :src="preview.dataUrl"
            :alt="preview.name"
            class="max-w-full max-h-full object-contain rounded shadow-sm"
          />
          <PreviewUnavailable v-else :preview="preview" />
        </div>

        <iframe
          v-else-if="preview.kind === 'pdf' && preview.dataUrl"
          :src="preview.dataUrl"
          :title="preview.name"
          class="w-full h-full min-h-[500px] border-0 bg-white"
        />

        <div
          v-else-if="preview.kind === 'audio' && preview.dataUrl"
          class="h-full min-h-64 grid place-items-center p-6"
        >
          <div class="w-full flex flex-col items-center gap-5">
            <div class="w-24 h-24 rounded-2xl bg-primary/10 grid place-items-center">
              <AudioLinesIcon class="w-10 h-10 text-primary" />
            </div>
            <audio :src="preview.dataUrl" controls class="w-full" />
          </div>
        </div>

        <div
          v-else-if="preview.kind === 'video' && preview.dataUrl"
          class="h-full min-h-64 grid place-items-center bg-black p-2"
        >
          <video :src="preview.dataUrl" controls class="max-w-full max-h-full" />
        </div>

        <div v-else-if="preview.kind === 'text' && preview.content !== null" class="min-w-max">
          <pre
            class="file-code-preview text-[12px] font-mono py-3 pr-3 text-foreground select-text"
            @mouseup="onSelectionChange"
          ><code v-html="highlighted" /></pre>
        </div>

        <PreviewUnavailable v-else :preview="preview" />

        <button
          v-if="selectionInfo"
          type="button"
          class="sticky bottom-3 ml-auto mr-3 mb-3 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-primary text-primary-foreground text-xs shadow-lg hover:bg-primary/90"
          @click="addToChat"
        >
          <PlusIcon class="w-3.5 h-3.5" />
          添加第 {{ selectionInfo.startLine }}–{{ selectionInfo.endLine }} 行到对话
        </button>
      </div>

      <div
        v-if="preview.truncated"
        class="px-3 py-1.5 text-[10px] text-warning border-t border-border bg-warning/5"
      >
        文件较大，当前仅显示安全预览范围
      </div>
      <div
        class="h-7 px-3 border-t border-border/70 flex items-center gap-2 text-[10px] text-muted-foreground"
      >
        <span>{{ kindLabel }}</span>
        <span>·</span>
        <span>{{ formatBytes(preview.size) }}</span>
        <span>·</span>
        <span>{{ formatDate(preview.modifiedAt) }}</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import MarkdownView from '@renderer/components/chat/MarkdownView.vue'
import { renderMarkdown } from '@renderer/lib/markdown'
import { ideSelectionAttachment, useChatInputStore } from '@renderer/stores/chat-input'
import { useFilesStore } from '@renderer/stores/files'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { FilePreview } from '@shared/ipc/fs'
import {
  AudioLinesIcon,
  CircleAlertIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from 'lucide-vue-next'
import { computed, defineComponent, h, ref, watch } from 'vue'

import FileTypeIcon from './FileTypeIcon.vue'

const filesStore = useFilesStore()
const workspaceStore = useWorkspaceStore()
const chatInput = useChatInputStore()
const preview = computed(() => filesStore.currentPreview)
const activePath = computed(() => filesStore.activePreviewPath ?? '')
const pathParts = computed(() => activePath.value.split('/'))
const parentPath = computed(() => pathParts.value.slice(0, -1).join('/'))
const fullPath = computed(
  () => `${workspaceStore.currentWorkspace?.name ?? '工作区'}/${activePath.value}`,
)
const highlighted = ref('')
const markdownMode = ref<'preview' | 'source'>('preview')
const selectionInfo = ref<{
  startLine: number
  endLine: number
  text: string
} | null>(null)

const PreviewUnavailable = defineComponent<{ preview: FilePreview }>({
  props: {
    preview: { type: Object, required: true },
  },
  setup(props) {
    const labels: Record<FilePreview['kind'], string> = {
      archive: '压缩包不支持内嵌预览',
      audio: '音频过大，无法生成内嵌预览',
      binary: '这是二进制文件',
      document: 'Office 文档暂不支持内嵌预览',
      image: '图片过大，无法生成内嵌预览',
      markdown: '没有可预览的内容',
      pdf: 'PDF 过大，无法生成内嵌预览',
      table: '没有可预览的表格内容',
      text: '没有可预览的文本内容',
      video: '视频过大，无法生成内嵌预览',
    }
    return () =>
      h('div', { class: 'h-full min-h-64 grid place-items-center p-6 text-center' }, [
        h('div', { class: 'flex flex-col items-center gap-3' }, [
          h(FileTypeIcon, {
            name: props.preview.name,
            class: 'w-14 h-14 opacity-90',
          }),
          h('div', { class: 'text-sm font-medium' }, labels[props.preview.kind]),
          h(
            'div',
            { class: 'text-xs text-muted-foreground' },
            '可使用右上角按钮在外部编辑器中打开',
          ),
        ]),
      ])
  },
})

watch(
  [preview, markdownMode],
  async ([file, mode]) => {
    // File Preview Highlighting: 切换 tab 时重置选择态，并为纯文本生成双主题 Shiki 标记。
    highlighted.value = ''
    selectionInfo.value = null
    if (
      !file ||
      file.content === null ||
      (file.kind !== 'text' && !(file.kind === 'markdown' && mode === 'source'))
    ) {
      return
    }
    highlighted.value = await highlightCode(file.content, file.language)
  },
  { immediate: true },
)

watch(activePath, () => {
  markdownMode.value = 'preview'
})

const tableRows = computed(() => {
  if (!preview.value?.content) return []
  const separator = preview.value.relativePath.toLowerCase().endsWith('.tsv') ? '\t' : ','
  return parseDelimited(preview.value.content, separator).slice(0, 500)
})

const kindLabel = computed(() => {
  const labels: Record<FilePreview['kind'], string> = {
    archive: '压缩文件',
    audio: '音频',
    binary: '二进制',
    document: '办公文档',
    image: '图片',
    markdown: 'Markdown',
    pdf: 'PDF',
    table: '表格',
    text: preview.value?.language ?? '文本',
    video: '视频',
  }
  return preview.value ? labels[preview.value.kind] : ''
})

async function reload(): Promise<void> {
  const workspaceId = workspaceStore.currentWorkspace?.id
  if (!workspaceId || !preview.value) return
  await filesStore.previewFile(workspaceId, preview.value.relativePath, true)
}

async function openInEditor(): Promise<void> {
  const workspaceId = workspaceStore.currentWorkspace?.id
  if (!workspaceId || !preview.value) return
  const result = await filesStore.openInEditor(workspaceId, preview.value.relativePath)
  if (!result.launched && result.error) window.alert(result.error)
}

function onSelectionChange(): void {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.toString().trim()) {
    selectionInfo.value = null
    return
  }
  const startLine = lineOf(selection.anchorNode)
  const endLine = lineOf(selection.focusNode)
  if (startLine === null || endLine === null) {
    selectionInfo.value = null
    return
  }
  selectionInfo.value = {
    startLine: Math.min(startLine, endLine),
    endLine: Math.max(startLine, endLine),
    text: selection.toString(),
  }
}

function lineOf(node: Node | null): number | null {
  let element =
    node?.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement | null)
  while (element && !element.dataset.line) element = element.parentElement
  const line = element?.dataset.line
  return line ? Number.parseInt(line, 10) : null
}

function addToChat(): void {
  if (!selectionInfo.value || !preview.value) return
  chatInput.addAttachment(
    ideSelectionAttachment({
      filePath: preview.value.relativePath,
      startLine: selectionInfo.value.startLine,
      endLine: selectionInfo.value.endLine,
      code: selectionInfo.value.text,
    }),
  )
  window.getSelection()?.removeAllRanges()
  selectionInfo.value = null
}

async function highlightCode(content: string, language: string | null): Promise<string> {
  // File Preview Highlighting: 复用 Markdown Shiki 管线，但只提取 code 内部以避免嵌套 pre。
  if (!language) return linesWithNumbers(escapeHtml(content))
  try {
    const html = await renderMarkdown(`\`\`\`${language}\n${content}\n\`\`\``)
    const match = html.match(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/)
    return addLineNumbers(match?.[1] ?? escapeHtml(content))
  } catch {
    return linesWithNumbers(escapeHtml(content))
  }
}

function addLineNumbers(html: string): string {
  let line = 0
  const withLines = html.replace(/<span class="line">/g, () => {
    line += 1
    return `<span class="line" data-line="${line}">`
  })
  return line > 0 ? withLines : linesWithNumbers(html)
}

function linesWithNumbers(html: string): string {
  return html
    .split('\n')
    .map((line, index) => `<span class="line" data-line="${index + 1}">${line}</span>`)
    .join('\n')
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!)
}

function parseDelimited(content: string, separator: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!
    if (char === '"') {
      if (quoted && content[index + 1] === '"') {
        cell += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (char === separator && !quoted) {
      row.push(cell)
      cell = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && content[index + 1] === '\n') index += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }
  if (cell || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(timestamp: number): string {
  if (timestamp <= 0) return '修改时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

function fileName(relativePath: string): string {
  return relativePath.split('/').pop() ?? relativePath
}
</script>

<style scoped>
@reference "../../assets/styles/main.css";

.preview-action {
  @apply w-7 h-7 grid place-items-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors;
}

.markdown-mode {
  @apply h-6 px-2 rounded text-[11px] text-muted-foreground hover:text-foreground transition-colors;
}

.markdown-mode-active {
  @apply bg-background text-foreground shadow-sm;
}

.file-code-preview {
  min-height: 100%;
  line-height: 1.45;
  background-color: var(--code-block-background);
  counter-reset: preview-line;
}

.file-code-preview :deep(code) {
  display: block;
  /* Shiki 的 .line 已经逐行 display:block；这里折叠标签之间的换行字符，
   * 避免 <pre> 再为它们生成一份额外的空白行。每行内部仍由下方规则保留空格。 */
  white-space: normal;
}

.file-code-preview :deep(.line) {
  display: block;
  min-height: 1.0875rem;
  padding-left: 3.75rem;
  counter-increment: preview-line;
  white-space: pre;
}

/* File Preview Line Numbers: 固定宽度的编辑器式 gutter，不进入复制和选择内容。 */
.file-code-preview :deep(.line)::before {
  content: attr(data-line);
  display: inline-block;
  width: 3rem;
  margin-left: -3.75rem;
  margin-right: 0.75rem;
  color: var(--muted-foreground);
  text-align: right;
  user-select: none;
  opacity: 0.55;
}

.checkerboard {
  background-color: var(--background);
  background-image:
    linear-gradient(45deg, color-mix(in oklch, var(--muted) 55%, transparent) 25%, transparent 25%),
    linear-gradient(
      -45deg,
      color-mix(in oklch, var(--muted) 55%, transparent) 25%,
      transparent 25%
    ),
    linear-gradient(45deg, transparent 75%, color-mix(in oklch, var(--muted) 55%, transparent) 75%),
    linear-gradient(-45deg, transparent 75%, color-mix(in oklch, var(--muted) 55%, transparent) 75%);
  background-position:
    0 0,
    0 8px,
    8px -8px,
    -8px 0;
  background-size: 16px 16px;
}
</style>

<style>
/* File Preview Contrast: Shiki 双主题把亮色写成 inline color，暗色放在每个 token 的
 * --shiki-dark 变量中。文件预览只提取 code 内容，因此需要用非 scoped
 * 规则显式激活暗色变量；否则夜间模式会显示浅色主题的深色 token。 */
[data-theme='dark'] .file-code-preview span {
  color: var(--shiki-dark, inherit) !important;
}
</style>
