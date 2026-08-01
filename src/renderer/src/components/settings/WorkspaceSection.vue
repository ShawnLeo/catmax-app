<template>
  <section class="flex flex-col gap-4">
    <header class="flex items-center justify-between">
      <div>
        <h2 class="text-[length:var(--ui-text-u3)] font-semibold text-foreground">工作区</h2>
        <p class="text-[length:var(--ui-text-base)] text-muted-foreground">管理已添加的工作区</p>
      </div>
      <Button size="sm" @click="addWorkspace">添加</Button>
    </header>

    <div class="flex flex-col gap-1">
      <div
        v-for="ws in workspaceStore.workspaces"
        :key="ws.id"
        class="flex items-center justify-between p-3 rounded-md hover:bg-muted"
      >
        <div class="min-w-0 flex-1">
          <div class="font-medium text-foreground text-[length:var(--ui-text-base)]">
            {{ ws.name }}
          </div>
          <div class="text-[length:var(--ui-text-d3)] text-muted-foreground font-mono truncate">
            {{ ws.path }}
          </div>
        </div>
        <div class="flex items-center gap-1">
          <Button variant="ghost" size="sm" @click="renameWorkspace(ws.id, ws.name)">重命名</Button>
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
  </section>
</template>

<script setup lang="ts">
import { Button } from '@renderer/components/ui/button'
import { useWorkspaceStore } from '@renderer/stores/workspace'

const workspaceStore = useWorkspaceStore()

async function addWorkspace(): Promise<void> {
  const result = await window.api.system.openDialog({
    title: '选择工作区文件夹',
    properties: ['openDirectory'],
  })
  if (!result.canceled && result.filePaths.length > 0) {
    await workspaceStore.add(result.filePaths[0]!)
  }
}

async function removeWorkspace(id: string): Promise<void> {
  if (!window.confirm('确认删除此工作区？')) return
  await workspaceStore.remove(id)
}

async function renameWorkspace(id: string, currentName: string): Promise<void> {
  const name = window.prompt('新名字', currentName)
  if (name && name.trim()) {
    await workspaceStore.rename(id, name.trim())
  }
}
</script>
