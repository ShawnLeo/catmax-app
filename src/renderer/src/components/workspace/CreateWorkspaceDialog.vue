<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[10000] grid place-items-center bg-black/55 p-6"
      @mousedown.self="emit('close')"
    >
      <section
        class="w-full max-w-2xl rounded-xl border border-border bg-popover p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-workspace-title"
      >
        <header class="mb-5">
          <h2 id="create-workspace-title" class="text-lg font-semibold text-foreground">
            创建工作区
          </h2>
          <p class="mt-1 text-sm text-muted-foreground">
            主文件夹用于新会话、Git 和项目配置；次文件夹可供 Agent 搜索、读取和编辑。
          </p>
        </header>

        <div class="space-y-4">
          <label class="block space-y-1.5">
            <span class="text-sm font-medium text-foreground">工作区名称</span>
            <Input v-model="name" placeholder="选择主文件夹后自动填写" />
          </label>

          <div class="space-y-1.5">
            <span class="text-sm font-medium text-foreground">主文件夹</span>
            <div class="flex gap-2">
              <div
                class="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
                :class="primaryPath ? 'text-foreground' : 'text-muted-foreground'"
              >
                <div class="truncate">{{ primaryPath || '尚未选择' }}</div>
              </div>
              <Button variant="outline" @click="pickPrimary">选择</Button>
            </div>
          </div>

          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium text-foreground">次文件夹</span>
              <Button variant="ghost" size="sm" @click="pickSecondary">选择多个文件夹</Button>
            </div>
            <div
              class="min-h-32 rounded-lg border border-dashed p-3 transition-colors"
              :class="dragging ? 'border-primary bg-primary/8' : 'border-border bg-background/55'"
              @dragenter.prevent="dragging = true"
              @dragover.prevent="dragging = true"
              @dragleave.prevent="dragging = false"
              @drop.prevent="onDrop"
            >
              <div
                v-if="secondaryPaths.length === 0"
                class="grid min-h-24 place-items-center text-center text-sm text-muted-foreground"
              >
                将多个文件夹拖到这里，或点击右上角选择
              </div>
              <div v-else class="space-y-1.5">
                <div
                  v-for="path in secondaryPaths"
                  :key="path"
                  class="flex items-center gap-2 rounded-md border border-border/70 bg-card px-2.5 py-2"
                >
                  <FolderIcon class="h-4 w-4 shrink-0 text-muted-foreground" />
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
              </div>
            </div>
          </div>

          <p v-if="error" class="text-sm text-danger">{{ error }}</p>
        </div>

        <footer class="mt-6 flex justify-end gap-2">
          <Button variant="ghost" :disabled="creating" @click="emit('close')">取消</Button>
          <Button :disabled="!primaryPath || !name.trim() || creating" @click="create">
            {{ creating ? '创建中…' : '创建工作区' }}
          </Button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { FolderIcon, XIcon } from 'lucide-vue-next'
import { ref, watch } from 'vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; created: [workspaceId: string] }>()

const workspaceStore = useWorkspaceStore()
const name = ref('')
const primaryPath = ref('')
const secondaryPaths = ref<string[]>([])
const dragging = ref(false)
const creating = ref(false)
const error = ref('')

watch(
  () => props.open,
  (open) => {
    if (!open) return
    name.value = ''
    primaryPath.value = ''
    secondaryPaths.value = []
    error.value = ''
  },
)

async function pickPrimary(): Promise<void> {
  const result = await window.api.system.openDialog({
    title: '选择主文件夹',
    properties: ['openDirectory'],
  })
  const path = result.filePaths[0]
  if (result.canceled || !path) return
  primaryPath.value = path
  secondaryPaths.value = secondaryPaths.value.filter((item) => item !== path)
  if (!name.value.trim()) name.value = pathName(path)
}

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

async function create(): Promise<void> {
  if (!primaryPath.value || !name.value.trim() || creating.value) return
  creating.value = true
  error.value = ''
  try {
    const workspace = await workspaceStore.add(
      primaryPath.value,
      name.value.trim(),
      secondaryPaths.value,
    )
    emit('created', workspace.id)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    creating.value = false
  }
}

function pathName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || '新工作区'
  )
}
</script>
