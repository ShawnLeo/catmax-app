<template>
  <section class="flex flex-col gap-4">
    <header class="flex items-center justify-between">
      <div>
        <h2 class="text-[length:var(--ui-text-u3)] font-semibold text-foreground">工作区</h2>
        <p class="text-[length:var(--ui-text-base)] text-muted-foreground">管理已添加的工作区</p>
      </div>
      <Button
        size="sm"
        class="bg-black text-white shadow hover:bg-black/90 dark:bg-primary dark:text-primary-foreground dark:hover:bg-primary/90"
        @click="showCreateWorkspace = true"
        >创建工作区</Button
      >
    </header>

    <div class="flex flex-col gap-1">
      <!--
        Inline Rename: 点「重命名」后该行名字就地变成输入框（回车提交、Esc 取消）。
        不用 window.prompt——Electron 渲染进程下它直接返回 null，弹不出窗。
      -->
      <div
        v-for="ws in workspaceStore.workspaces"
        :key="ws.id"
        class="flex items-center justify-between p-3 rounded-md hover:bg-muted"
      >
        <div class="min-w-0 flex-1">
          <input
            v-if="editingId === ws.id"
            ref="renameInputEl"
            v-model="editingName"
            class="font-medium text-foreground text-[length:var(--ui-text-base)] w-full h-7 rounded-md border border-input bg-transparent px-2 shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            @keydown.enter="confirmRename"
            @keydown.esc="cancelRename"
            @blur="confirmRename"
          />
          <div v-else class="font-medium text-foreground text-[length:var(--ui-text-base)]">
            {{ ws.name }}
          </div>
          <div class="text-[length:var(--ui-text-d3)] text-muted-foreground font-mono truncate">
            {{ ws.path }}
          </div>
        </div>
        <div class="flex items-center gap-1">
          <Button
            v-if="editingId === ws.id"
            variant="ghost"
            size="sm"
            :disabled="!editingName.trim() || renaming"
            @click="confirmRename"
          >
            {{ renaming ? '…' : '保存' }}
          </Button>
          <Button v-else variant="ghost" size="sm" @click="startRename(ws)">重命名</Button>
          <Button
            variant="ghost"
            size="sm"
            class="text-destructive"
            @click="removeWorkspace(ws.id)"
          >
            删除
          </Button>
        </div>
      </div>

      <div
        v-if="workspaceStore.workspaces.length === 0"
        class="text-center py-8 text-[length:var(--ui-text-base)] text-muted-foreground"
      >
        暂无工作区
      </div>
    </div>
    <CreateWorkspaceDialog
      :open="showCreateWorkspace"
      @close="showCreateWorkspace = false"
      @created="showCreateWorkspace = false"
    />
  </section>
</template>

<script setup lang="ts">
import { Button } from '@renderer/components/ui/button'
import CreateWorkspaceDialog from '@renderer/components/workspace/CreateWorkspaceDialog.vue'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { WorkspaceRecord } from '@shared/domain'
import { nextTick, ref } from 'vue'

const workspaceStore = useWorkspaceStore()
const showCreateWorkspace = ref(false)

async function removeWorkspace(id: string): Promise<void> {
  if (!window.confirm('确认删除此工作区？')) return
  await workspaceStore.remove(id)
}

// Inline Rename: 就地编辑名字。Electron 下 window.prompt 不弹窗（恒返回 null），
// 改用输入框 + 回车/Esc/失焦的标准就地编辑交互。
const editingId = ref<string | null>(null)
const editingName = ref('')
const renaming = ref(false)
const renameInputEl = ref<HTMLInputElement | null>(null)

function startRename(ws: WorkspaceRecord): void {
  editingId.value = ws.id
  editingName.value = ws.name
  // 等输入框渲染出来再聚焦并全选，方便整体覆盖。
  void nextTick(() => {
    const el = renameInputEl.value
    if (!el) return
    el.focus()
    el.select()
  })
}

function cancelRename(): void {
  editingId.value = null
  editingName.value = ''
}

async function confirmRename(): Promise<void> {
  const id = editingId.value
  if (!id) return
  const name = editingName.value.trim()
  if (!name) {
    cancelRename()
    return
  }
  // 名字没变直接退出编辑，不发请求。
  const current = workspaceStore.workspaces.find((w) => w.id === id)
  if (current && current.name === name) {
    cancelRename()
    return
  }
  renaming.value = true
  try {
    await workspaceStore.rename(id, name)
    cancelRename()
  } finally {
    renaming.value = false
  }
}
</script>
