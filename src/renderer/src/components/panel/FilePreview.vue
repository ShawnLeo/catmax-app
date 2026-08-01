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
          'group/tab min-w-0 max-w-48 shrink-0 relative flex items-center border-r border-border/70',
          // File Preview Tabs Active State: 活动项用底部短强调条 + 实底背景，避免与主 Tab
          // 头部的选中下划线在上下边界处交叠。
          tab.relativePath === filesStore.activePreviewPath
            ? 'bg-background text-foreground preview-tab-active'
            : 'bg-card/60 text-muted-foreground/70 hover:bg-muted/40 hover:text-foreground/90',
        ]"
        @mousedown.middle.prevent="filesStore.closePreview(tab.relativePath)"
        @contextmenu.prevent="onTabContextMenu($event, tab.relativePath)"
        @dblclick="filesStore.pinPreviewTab(tab.relativePath)"
      >
        <button
          type="button"
          role="tab"
          :aria-selected="tab.relativePath === filesStore.activePreviewPath"
          :title="
            tab.isTransient ? `${fileName(tab.relativePath)}（预览，双击常驻）` : tab.relativePath
          "
          class="h-full min-w-0 flex-1 flex items-center gap-1.5 pl-2.5 pr-1 text-[length:var(--ui-text-d3)]"
          @click="filesStore.selectPreview(tab.relativePath)"
        >
          <FileTypeIcon
            :name="tab.preview?.name ?? fileName(tab.relativePath)"
            class="w-4 h-4 shrink-0"
          />
          <!-- File Preview Tabs (VS Code Preview Mode): 预览态用斜体标题，转正后恢复常规字重。 -->
          <span :class="['truncate', tab.isTransient ? 'italic font-normal' : 'font-medium']">
            {{ tab.preview?.name ?? fileName(tab.relativePath) }}
          </span>
          <LoaderCircleIcon v-if="tab.loading" class="w-3 h-3 shrink-0 animate-spin" />
        </button>
        <button
          type="button"
          class="w-6 h-6 mr-1 grid place-items-center rounded hover:bg-muted/80 focus:opacity-100"
          :class="
            tab.relativePath === filesStore.activePreviewPath
              ? 'opacity-60'
              : 'opacity-0 group-hover/tab:opacity-60'
          "
          :aria-label="`关闭 ${fileName(tab.relativePath)}`"
          title="关闭文件"
          @click.stop="filesStore.closePreview(tab.relativePath)"
        >
          <XIcon class="w-3 h-3" />
        </button>
      </div>
      <div class="min-w-4 flex-1 border-b border-transparent" />
      <button
        v-if="showFileTreeButton"
        type="button"
        class="sticky right-0 w-9 shrink-0 grid place-items-center border-l border-border bg-card text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        title="打开文件树"
        aria-label="打开文件树"
        @click="emit('showFileTree')"
      >
        <PanelRightIcon class="w-3.5 h-3.5" />
      </button>
    </div>

    <!-- File Preview Tabs Context Menu: 右键 tab 弹出关闭操作。
         Teleport 到 body 并用 fixed 定位在鼠标坐标，避免被 overflow 祖先裁掉。 -->
    <Teleport to="body">
      <div
        v-if="contextMenu.open && contextMenuStyle"
        ref="contextMenuRef"
        class="fixed z-[9999] min-w-[12rem] rounded-md border border-border bg-popover p-1 shadow-lg"
        :style="contextMenuStyle"
        @click.stop
        @contextmenu.prevent
      >
        <button
          type="button"
          class="context-menu-item"
          @click="runContextMenuAction(() => filesStore.closePreview(contextMenu.path!))"
        >
          <XIcon class="w-4 h-4 shrink-0" />
          <span>关闭标签</span>
        </button>
        <button
          type="button"
          class="context-menu-item"
          :disabled="filesStore.previewTabs.length <= 1"
          @click="runContextMenuAction(() => filesStore.closeOthersPreviews(contextMenu.path!))"
        >
          <XSquareIcon class="w-4 h-4 shrink-0" />
          <span>关闭其他</span>
        </button>
        <button
          type="button"
          class="context-menu-item"
          :disabled="filesStore.previewTabs.length === 0"
          @click="runContextMenuAction(() => filesStore.closeAllPreviews())"
        >
          <XCircleIcon class="w-4 h-4 shrink-0" />
          <span>关闭所有</span>
        </button>
      </div>
    </Teleport>

    <!-- File Preview Toolbar: 显示活动路径，并提供刷新与外部编辑器入口。 -->
    <div class="h-10 flex items-center gap-1.5 px-2.5 border-b border-border/70 bg-card/70">
      <FileTypeIcon v-if="preview" :name="preview.name" class="w-[18px] h-[18px] shrink-0" />
      <div class="min-w-0 flex-1 text-[length:var(--ui-text-d3)] truncate" :title="fullPath">
        <template v-if="isOutsideWorkspace">
          <!-- Outside Workspace: 工作区外文件直接显示完整路径，文件名高亮 -->
          <span v-if="parentPath" class="text-muted-foreground">{{ parentPath }}/</span>
          <span class="text-foreground">{{ pathParts[pathParts.length - 1] }}</span>
        </template>
        <template v-else>
          <span class="text-muted-foreground"
            >{{ workspaceStore.currentWorkspace?.name ?? '工作区' }}/</span
          >
          <span v-if="parentPath" class="text-muted-foreground">{{ parentPath }}/</span>
          <span class="text-foreground">{{ pathParts[pathParts.length - 1] }}</span>
        </template>
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
      class="flex-1 grid place-items-center text-[length:var(--ui-text-d3)] text-muted-foreground"
    >
      <div class="flex flex-col items-center gap-2">
        <LoaderCircleIcon class="w-5 h-5 animate-spin" />
        正在生成预览…
      </div>
    </div>

    <div v-else-if="filesStore.previewError" class="flex-1 grid place-items-center p-6 text-center">
      <div class="flex flex-col items-center gap-2">
        <CircleAlertIcon class="w-7 h-7 text-danger" />
        <div class="text-[length:var(--ui-text-base)] font-medium">无法预览文件</div>
        <div class="text-[length:var(--ui-text-d3)] text-muted-foreground break-all">
          {{ filesStore.previewError }}
        </div>
      </div>
    </div>

    <!-- File Preview Content: kind 是唯一分发依据，各类文件共享加载、错误与元数据外壳。 -->
    <template v-else-if="preview">
      <div class="flex-1 min-h-0 overflow-auto bg-background/45 relative">
        <MarkdownView
          v-if="preview.kind === 'markdown' && preview.content && markdownMode === 'preview'"
          :text="preview.content"
          compact
          class="p-5 text-[length:var(--ui-text-d2)]"
        />

        <div
          v-else-if="
            preview.kind === 'markdown' && preview.content !== null && markdownMode === 'source'
          "
          class="min-w-max"
        >
          <pre
            class="file-code-preview text-[length:var(--code-text-d1)] font-mono py-3 pr-3 text-foreground select-text"
            @mouseup="onSelectionChange"
          ><code v-html="highlighted" /></pre>
        </div>

        <div v-else-if="preview.kind === 'table' && preview.content" class="p-3 min-w-max">
          <table class="border-collapse text-[length:var(--ui-text-d4)] font-mono">
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
            class="file-code-preview text-[length:var(--code-text-d1)] font-mono py-3 pr-3 text-foreground select-text"
            @mouseup="onSelectionChange"
          ><code v-html="highlighted" /></pre>
        </div>

        <PreviewUnavailable v-else :preview="preview" />

        <button
          v-if="selectionInfo"
          type="button"
          class="sticky bottom-3 ml-auto mr-3 mb-3 flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-primary text-primary-foreground text-[length:var(--ui-text-d3)] shadow-lg hover:bg-primary/90"
          @click="addToChat"
        >
          <PlusIcon class="w-3.5 h-3.5" />
          添加第 {{ selectionInfo.startLine }}–{{ selectionInfo.endLine }} 行到对话
        </button>
      </div>

      <div
        v-if="preview.truncated"
        class="px-3 py-1.5 text-[length:var(--ui-text-d5)] text-warning border-t border-border bg-warning/5"
      >
        文件较大，当前仅显示安全预览范围
      </div>
      <div
        class="h-7 px-3 border-t border-border/70 flex items-center gap-2 text-[length:var(--ui-text-d5)] text-muted-foreground"
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
import MarkdownView from '@renderer/components/chat/blocks/base/MarkdownView.vue'
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
  PanelRightIcon,
  PlusIcon,
  RefreshCwIcon,
  XCircleIcon,
  XIcon,
  XSquareIcon,
} from 'lucide-vue-next'
import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import FileTypeIcon from './FileTypeIcon.vue'

defineProps<{ showFileTreeButton?: boolean }>()
const emit = defineEmits<{ showFileTree: [] }>()

const filesStore = useFilesStore()
const workspaceStore = useWorkspaceStore()
const chatInput = useChatInputStore()
const preview = computed(() => filesStore.currentPreview)
const activePath = computed(() => filesStore.activePreviewPath ?? '')
const activeTab = computed(() => filesStore.activePreviewTab)
// Outside Workspace Display: 工作区外文件（如 ~/.claude.json）走绝对路径展示，
// 不套用"工作区名/相对路径"逻辑。
const isOutsideWorkspace = computed(() => !!activeTab.value?.absolutePath)
const pathParts = computed(() => activePath.value.split('/'))
const parentPath = computed(() => pathParts.value.slice(0, -1).join('/'))
const fullPath = computed(() =>
  isOutsideWorkspace.value
    ? (activeTab.value?.absolutePath ?? activePath.value)
    : `${workspaceStore.currentWorkspace?.name ?? '工作区'}/${activePath.value}`,
)
const highlighted = ref('')
const markdownMode = ref<'preview' | 'source'>('preview')
const selectionInfo = ref<{
  startLine: number
  endLine: number
  text: string
} | null>(null)

// File Preview Tabs Context Menu: 状态挂在组件上，路径可能为 null（关闭时）。
const contextMenuRef = ref<HTMLElement | null>(null)
const contextMenu = ref<{ open: boolean; x: number; y: number; path: string | null }>({
  open: false,
  x: 0,
  y: 0,
  path: null,
})

const contextMenuStyle = computed(() => {
  // Context Menu Position: 鼠标坐标定位，贴边时回退到视口内，避免菜单溢出屏幕。
  if (!contextMenu.value.open) return null
  const menuWidth = 200
  const menuHeight = 96
  const margin = 8
  const maxX = window.innerWidth - menuWidth - margin
  const maxY = window.innerHeight - menuHeight - margin
  return {
    top: `${Math.min(contextMenu.value.y, Math.max(margin, maxY))}px`,
    left: `${Math.min(contextMenu.value.x, Math.max(margin, maxX))}px`,
  }
})

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
          h(
            'div',
            { class: 'text-[length:var(--ui-text-base)] font-medium' },
            labels[props.preview.kind],
          ),
          h(
            'div',
            { class: 'text-[length:var(--ui-text-d3)] text-muted-foreground' },
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

function onTabContextMenu(event: MouseEvent, relativePath: string): void {
  // 右键直接定位到鼠标点击点，并在弹出前先选中该 tab，让操作目标更直观。
  filesStore.selectPreview(relativePath)
  contextMenu.value = { open: true, x: event.clientX, y: event.clientY, path: relativePath }
}

function runContextMenuAction(action: () => void): void {
  action()
  contextMenu.value.open = false
}

// clickOutside 收起——capture 阶段抓事件，避免与菜单项自身 click 打架。
// 跟 DropdownMenu 的实现一致（项目目前没有 v-click-outside 指令）。
function handleContextMenuOutside(event: MouseEvent): void {
  if (!contextMenu.value.open) return
  if (contextMenuRef.value && !contextMenuRef.value.contains(event.target as Node)) {
    contextMenu.value.open = false
  }
}

// Escape / 窗口失焦也收起右键菜单，跟原生上下文菜单行为一致。
function handleContextMenuKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && contextMenu.value.open) contextMenu.value.open = false
}

function handleWindowBlur(): void {
  if (contextMenu.value.open) contextMenu.value.open = false
}

onMounted(() => {
  document.addEventListener('click', handleContextMenuOutside, true)
  document.addEventListener('contextmenu', handleContextMenuOutside, true)
  window.addEventListener('keydown', handleContextMenuKey)
  window.addEventListener('blur', handleWindowBlur)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleContextMenuOutside, true)
  document.removeEventListener('contextmenu', handleContextMenuOutside, true)
  window.removeEventListener('keydown', handleContextMenuKey)
  window.removeEventListener('blur', handleWindowBlur)
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
  await filesStore.previewFile(
    workspaceId,
    preview.value.relativePath,
    true,
    activeTab.value?.absolutePath,
  )
}

async function openInEditor(): Promise<void> {
  const workspaceId = workspaceStore.currentWorkspace?.id
  if (!workspaceId || !preview.value) return
  const result = await filesStore.openInEditor(
    workspaceId,
    preview.value.relativePath,
    undefined,
    activeTab.value?.absolutePath,
  )
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

.context-menu-item {
  @apply w-full flex items-center gap-2.5 px-3 py-2 rounded text-[length:var(--ui-text-base)] text-left transition-colors text-popover-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-40 disabled:cursor-not-allowed;
}

/* File Preview Tabs Active State: 底部内缩强调条与主 Tab 的下划线拉开层级，
 * 同时避免覆盖文件 Tab 容器自身的分隔边框。 */
.preview-tab-active::before {
  content: '';
  position: absolute;
  bottom: 0;
  left: 8px;
  right: 8px;
  height: 2px;
  background: var(--primary);
  border-radius: 2px 2px 0 0;
}

.markdown-mode {
  @apply h-6 px-2 rounded text-[length:var(--ui-text-d4)] text-muted-foreground hover:text-foreground transition-colors;
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
