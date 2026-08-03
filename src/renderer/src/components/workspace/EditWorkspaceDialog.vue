<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[10000] grid place-items-center bg-black/55 p-6"
      @mousedown.self="emit('close')"
    >
      <section
        class="w-full max-w-xl rounded-2xl border border-border bg-popover p-6 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-workspace-title"
      >
        <header class="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2
              id="edit-workspace-title"
              class="text-xl font-semibold tracking-tight text-foreground"
            >
              编辑工作区
            </h2>
            <p class="mt-1 text-sm text-muted-foreground">修改名称或次文件夹</p>
          </div>
          <button
            type="button"
            class="mt-0.5 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="关闭"
            @click="emit('close')"
          >
            <XIcon class="h-4 w-4" />
          </button>
        </header>

        <div class="space-y-2.5">
          <!-- 工作区名称 -->
          <input
            v-model="name"
            placeholder="工作区名称"
            class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-[length:var(--ui-text-base)] shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />

          <!-- 主文件夹:只读展示(创建后不可改) -->
          <div
            class="flex h-9 items-center gap-2 rounded-md border border-border/70 bg-muted/40 px-3"
            :title="`主文件夹:${primaryPath}`"
          >
            <FolderIcon class="h-4 w-4 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              {{ primaryPath || '—' }}
            </span>
            <span class="shrink-0 text-[length:var(--ui-text-d3)] text-muted-foreground">
              主文件夹 · 不可改
            </span>
          </div>

          <!-- 次文件夹:拖放区 + 选择按钮 -->
          <div
            class="rounded-lg border border-dashed p-3 transition-colors"
            :class="dragging ? 'border-primary bg-primary/8' : 'border-border bg-background/55'"
            @dragenter.prevent="dragging = true"
            @dragover.prevent="dragging = true"
            @dragleave.prevent="dragging = false"
            @drop.prevent="onDrop"
          >
            <!-- 空状态:居中按钮 + 拖放提示 -->
            <div
              v-if="secondaryPaths.length === 0"
              class="flex flex-col items-center justify-center gap-2 py-2 text-center"
            >
              <button
                type="button"
                class="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-[length:var(--ui-text-d3)] font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                @click="pickSecondary"
              >
                <FolderPlusIcon class="h-4 w-4" />
                选择多个文件夹
              </button>
              <p class="text-xs text-muted-foreground">或将文件夹拖放到这里(可选)</p>
            </div>

            <!-- 有内容:列表 + 添加更多 -->
            <div v-else class="space-y-1.5">
              <div
                v-for="path in secondaryPaths"
                :key="path"
                class="flex items-center gap-2 rounded-md border border-border/70 bg-card px-2.5 py-1.5"
              >
                <FolderIcon class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ path }}</span>
                <button
                  type="button"
                  class="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="移除次文件夹"
                  @click="removeSecondary(path)"
                >
                  <XIcon class="h-3.5 w-3.5" />
                </button>
              </div>
              <button
                type="button"
                class="mt-0.5 inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[length:var(--ui-text-d3)] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                @click="pickSecondary"
              >
                <PlusIcon class="h-3.5 w-3.5" />
                添加更多
              </button>
            </div>
          </div>

          <p v-if="error" class="pt-1 text-sm text-danger">{{ error }}</p>
        </div>

        <footer class="mt-6 flex justify-end gap-2 border-t border-border/70 pt-4">
          <Button variant="ghost" :disabled="saving" @click="emit('close')">取消</Button>
          <Button :disabled="!canSave || saving" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </Button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { Button } from '@renderer/components/ui/button'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { WorkspaceRecord } from '@shared/domain'
import { FolderIcon, FolderPlusIcon, PlusIcon, XIcon } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'

const props = defineProps<{ open: boolean; workspace: WorkspaceRecord | null }>()
const emit = defineEmits<{ close: []; updated: [workspaceId: string] }>()

const workspaceStore = useWorkspaceStore()
const name = ref('')
const primaryPath = ref('')
const secondaryPaths = ref<string[]>([])
const dragging = ref(false)
const saving = ref(false)
const error = ref('')

// 打开时从传入 workspace 预填:主文件夹取 role==='primary',其余作为次文件夹。
watch(
  () => props.open,
  (open) => {
    if (!open || !props.workspace) return
    name.value = props.workspace.name
    primaryPath.value =
      props.workspace.folders.find((f) => f.role === 'primary')?.path ?? props.workspace.path
    secondaryPaths.value = props.workspace.folders
      .filter((f) => f.role === 'secondary')
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((f) => f.path)
    error.value = ''
  },
)

const canSave = computed(() => name.value.trim().length > 0 && !!props.workspace)

async function pickSecondary(): Promise<void> {
  const result = await window.api.system.openDialog({
    title: '选择次文件夹',
    properties: ['openDirectory', 'multiSelections'],
  })
  if (result.canceled) return
  addSecondary(result.filePaths)
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  const paths = [...(event.dataTransfer?.files ?? [])]
    .map((file) => window.api.fs.getPathForFile(file))
    .filter(Boolean)
  addSecondary(paths)
}

function addSecondary(paths: string[]): void {
  const next = new Set(secondaryPaths.value)
  for (const path of paths) {
    if (path !== primaryPath.value) next.add(path)
  }
  secondaryPaths.value = [...next]
}

function removeSecondary(path: string): void {
  secondaryPaths.value = secondaryPaths.value.filter((item) => item !== path)
}

async function save(): Promise<void> {
  if (!props.workspace || !canSave.value || saving.value) return
  saving.value = true
  error.value = ''
  try {
    await workspaceStore.updateFolders(props.workspace.id, name.value.trim(), secondaryPaths.value)
    emit('updated', props.workspace.id)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}
</script>
