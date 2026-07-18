<template>
  <div class="h-full flex items-center justify-center">
    <div class="text-center">
      <h1 class="text-xl font-semibold text-foreground">Settings</h1>
      <p class="mt-2 text-sm text-muted-foreground">Plan 1 仅含主题切换（Task 17 实现）</p>
      <Button variant="link" @click="router.push('/')">返回</Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button } from '@renderer/components/ui/button'
import { useRouter } from 'vue-router'

const router = useRouter()
</script>
