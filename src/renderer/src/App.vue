<template>
  <div class="h-full flex flex-col items-center justify-center gap-4">
    <h1 class="text-3xl font-bold text-foreground">catmax app</h1>
    <p class="text-muted-foreground">shadcn-vue works</p>

    <div class="flex gap-2">
      <Button @click="setTheme('dark')">Dark</Button>
      <Button variant="secondary" @click="setTheme('light')">Light</Button>
    </div>

    <Input placeholder="test input" class="max-w-xs" />
  </div>
</template>

<script setup lang="ts">
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'

function setTheme(theme: 'dark' | 'light'): void {
  document.documentElement.setAttribute('data-theme', theme)
}
</script>
