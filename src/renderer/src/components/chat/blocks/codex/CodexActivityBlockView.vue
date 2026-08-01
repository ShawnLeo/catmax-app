<template>
  <div class="text-[length:var(--chat-text-base)] text-muted-foreground">
    <button
      type="button"
      class="group flex max-w-full items-center gap-2 py-0.5 text-left transition-colors hover:text-foreground"
      :aria-expanded="open"
      @click="open = !open"
    >
      <LoaderCircleIcon v-if="block.status === 'running'" class="size-3.5 shrink-0 animate-spin" />
      <component
        :is="summaryIcon"
        v-else-if="block.status === 'completed'"
        class="size-3.5 shrink-0"
      />
      <CircleXIcon v-else class="size-3.5 shrink-0 text-destructive" />
      <span class="truncate">{{ summary }}</span>
      <ChevronDownIcon
        class="size-3 shrink-0 opacity-60 transition-transform"
        :class="open ? 'rotate-180' : ''"
      />
    </button>

    <div v-if="open" class="ml-5 mt-1 space-y-0.5">
      <template v-for="activity in block.activities" :key="activity.id">
        <div v-if="activity.kind === 'file_change'" class="flex flex-col gap-0.5 py-0.5">
          <button
            v-for="change in activity.changes"
            :key="`${activity.id}-${change.path}`"
            type="button"
            class="flex min-w-0 items-center gap-1.5 text-left leading-5 hover:text-foreground"
            :title="change.path"
            @click="openFile(change.path)"
          >
            <component :is="fileChangeIcon(change.kind)" class="size-3.5 shrink-0" />
            <span class="shrink-0">{{ fileChangeLabel(change.kind, activity.status) }}</span>
            <span class="min-w-0 truncate font-mono underline decoration-border underline-offset-2">
              {{ basename(change.movePath ?? change.path) }}
            </span>
            <span
              class="ml-auto inline-flex shrink-0 gap-1 font-mono text-[length:var(--chat-text-d2)] tabular-nums"
            >
              <span class="text-emerald-500">+{{ change.stats.additions }}</span>
              <span class="text-red-500">-{{ change.stats.deletions }}</span>
            </span>
          </button>
        </div>

        <button
          v-else-if="activity.kind === 'file_read'"
          type="button"
          class="flex min-w-0 items-center gap-1.5 py-0.5 text-left leading-5 hover:text-foreground"
          :title="activity.path"
          @click="openFile(activity.path)"
        >
          <BookOpenIcon class="size-3.5 shrink-0" />
          <span>{{ activity.status === 'running' ? '正在读取' : '已读取' }}</span>
          <span class="min-w-0 truncate font-mono underline decoration-border underline-offset-2">
            {{ basename(activity.path) }}
          </span>
        </button>

        <div v-else class="flex min-w-0 items-center gap-1.5 py-0.5 leading-5">
          <component :is="activityIcon(activity.kind)" class="size-3.5 shrink-0" />
          <span class="shrink-0">{{ activityVerb(activity) }}</span>
          <span class="min-w-0 truncate font-mono" :title="activityDetail(activity)">
            {{ activityDetail(activity) }}
          </span>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { basename } from '@renderer/lib/path'
import { useFilesStore } from '@renderer/stores/files'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type {
  CodexActivity,
  CodexActivityContentBlock,
  CodexActivityStatus,
  CodexFileChange,
} from '@shared/backend/blocks'
import {
  BookOpenIcon,
  ChevronDownIcon,
  CircleXIcon,
  FilePlus2Icon,
  GlobeIcon,
  FolderOpenIcon,
  ImageIcon,
  ListTreeIcon,
  LoaderCircleIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  Trash2Icon,
  UsersIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  block: CodexActivityContentBlock
  cwd?: string | undefined
}>()

const filesStore = useFilesStore()
const workspaceStore = useWorkspaceStore()
const open = ref(props.block.status === 'running')

watch(
  () => props.block.status,
  (status) => {
    if (status === 'running') open.value = true
  },
)

const summary = computed(() => summarizeActivities(props.block.activities, props.block.status))

const summaryIcon = computed<LucideIcon>(() => {
  if (props.block.activities.some((activity) => activity.kind === 'file_change')) return PencilIcon
  if (
    props.block.activities.some((activity) =>
      ['file_read', 'file_list', 'search'].includes(activity.kind),
    )
  ) {
    return FolderOpenIcon
  }
  if (props.block.activities.some((activity) => activity.kind === 'command')) return TerminalIcon
  if (props.block.activities.some((activity) => activity.kind === 'web_search')) return GlobeIcon
  return WrenchIcon
})

function summarizeActivities(activities: CodexActivity[], status: CodexActivityStatus): string {
  if (status === 'running') {
    if (activities.length === 1) return activityVerb(activities[0]!)
    return '正在处理'
  }

  const editCount = activities
    .filter((activity) => activity.kind === 'file_change')
    .reduce((count, activity) => count + activity.changes.length, 0)
  const readCount = activities.filter((activity) => activity.kind === 'file_read').length
  const commandCount = activities.filter((activity) => activity.kind === 'command').length
  const searchCount = activities.filter(
    (activity) => activity.kind === 'search' || activity.kind === 'file_list',
  ).length
  const webCount = activities.filter((activity) => activity.kind === 'web_search').length
  const toolCount = activities.filter((activity) =>
    ['mcp', 'dynamic_tool', 'collab_tool', 'image_view'].includes(activity.kind),
  ).length

  const parts: string[] = []
  if (editCount > 0) parts.push('编辑了文件')
  if (readCount > 0) parts.push(readCount > 1 ? '读取了多个文件' : '读取了文件')
  if (searchCount > 0) parts.push('搜索了代码')
  if (commandCount > 0) parts.push(commandCount > 1 ? '运行了多个命令' : '运行了命令')
  if (webCount > 0) parts.push('搜索了网页')
  if (toolCount > 0) parts.push(toolCount > 1 ? '调用了多个工具' : '调用了工具')
  if (parts.length === 0) return status === 'failed' ? '处理失败' : '已处理'
  return parts.join('')
}

function activityVerb(activity: CodexActivity): string {
  const running = activity.status === 'running'
  switch (activity.kind) {
    case 'command':
      return running ? '正在运行' : '已运行'
    case 'file_list':
      return running ? '正在列出文件' : '已列出文件'
    case 'search':
      return running ? '正在搜索' : '已搜索'
    case 'mcp':
    case 'dynamic_tool':
      return running ? '正在调用工具' : '已调用工具'
    case 'collab_tool':
      return running ? '正在协调代理' : '已协调代理'
    case 'web_search':
      return running ? '正在搜索网页' : '已搜索网页'
    case 'image_view':
      return running ? '正在查看图片' : '已查看图片'
    case 'file_read':
      return running ? '正在读取' : '已读取'
    case 'file_change':
      return running ? '正在编辑文件' : '已编辑文件'
  }
}

function activityDetail(activity: CodexActivity): string {
  switch (activity.kind) {
    case 'command':
      return activity.command
    case 'file_list':
      return activity.path ?? activity.command
    case 'search': {
      const query = activity.query ? `“${activity.query}”` : activity.command
      return activity.path ? `${activity.path} · ${query}` : query
    }
    case 'file_read':
      return activity.path
    case 'file_change':
      return activity.changes.map((change) => change.path).join(', ')
    default:
      return activity.title
  }
}

function activityIcon(kind: CodexActivity['kind']): LucideIcon {
  switch (kind) {
    case 'command':
      return TerminalIcon
    case 'file_list':
      return ListTreeIcon
    case 'search':
      return SearchIcon
    case 'web_search':
      return GlobeIcon
    case 'image_view':
      return ImageIcon
    case 'collab_tool':
      return UsersIcon
    default:
      return WrenchIcon
  }
}

function fileChangeIcon(kind: CodexFileChange['kind']): LucideIcon {
  switch (kind) {
    case 'add':
      return FilePlus2Icon
    case 'delete':
      return Trash2Icon
    default:
      return PencilIcon
  }
}

function fileChangeLabel(kind: CodexFileChange['kind'], status: CodexActivityStatus): string {
  if (status === 'running') {
    if (kind === 'add') return '正在创建'
    if (kind === 'delete') return '正在删除'
    return '正在编辑'
  }
  if (kind === 'add') return '已创建'
  if (kind === 'delete') return '已删除'
  return '已编辑'
}

async function openFile(path: string): Promise<void> {
  const workspaceId = workspaceStore.currentWorkspace?.id
  if (!workspaceId || !path) return
  await filesStore.openFileReference(workspaceId, path)
}
</script>
