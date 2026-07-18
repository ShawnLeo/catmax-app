<template>
  <div class="h-full flex items-center justify-center">
    <div class="text-center">
      <h1 class="text-xl font-semibold text-foreground">Chat（Plan 2 实现）</h1>
      <p class="mt-2 text-sm text-muted-foreground">
        当前工作区：{{ workspaceStore.currentWorkspace?.name ?? '未选择' }}
      </p>
      <Button variant="link" @click="router.push('/')">返回</Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button } from '@renderer/components/ui/button'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { useRouter } from 'vue-router'

const router = useRouter()
const workspaceStore = useWorkspaceStore()
</script>
