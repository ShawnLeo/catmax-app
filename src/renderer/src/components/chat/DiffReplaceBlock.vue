<template>
  <!--
    old/new 对比块：claude Edit 工具的 string_replace 渲染单元。
    红色块=原文（被删的），绿色块=新文（替换后的）。
    DiffView 在单组 Edit 和 MultiEdit 多组都复用本组件。
  -->
  <div>
    <div v-if="oldString" class="bg-destructive/10 border-b border-destructive/20">
      <div class="px-3 py-0.5 text-[10px] uppercase tracking-wide text-destructive/80">- 原文</div>
      <pre class="px-3 pb-2 text-destructive/90 whitespace-pre-wrap overflow-x-auto">{{
        oldString
      }}</pre>
    </div>
    <div class="bg-success/10">
      <div class="px-3 py-0.5 text-[10px] uppercase tracking-wide text-success/80">+ 新文</div>
      <pre class="px-3 pb-2 text-success/90 whitespace-pre-wrap overflow-x-auto">{{
        newString
      }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  oldString?: string
  newString?: string
}>()
</script>
