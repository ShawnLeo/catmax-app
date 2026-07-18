<template>
  <div class="h-full flex flex-col items-center justify-center gap-4">
    <h1 class="text-3xl font-bold text-foreground">catmax app</h1>
    <p class="text-muted-foreground">theme system test</p>

    <div class="flex gap-2">
      <button
        class="bg-primary text-primary-foreground px-3 py-1.5 rounded-md font-medium"
        @click="setTheme('dark')"
      >
        Dark
      </button>
      <button
        class="bg-secondary text-secondary-foreground px-3 py-1.5 rounded-md font-medium"
        @click="setTheme('light')"
      >
        Light
      </button>
    </div>

    <div class="mt-4 flex gap-2">
      <code class="font-mono text-[13px] bg-code-block text-foreground p-2 rounded">code block</code>
      <code class="font-chat text-[15px] bg-muted p-2 rounded">chat text</code>
    </div>
  </div>
</template>

<script setup lang="ts">
function setTheme(theme: 'dark' | 'light'): void {
  document.documentElement.setAttribute('data-theme', theme)
}
</script>
