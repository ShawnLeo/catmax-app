<template>
  <aside class="w-60 flex flex-col bg-sidebar border-r border-sidebar-border">
    <!-- 顶部：工作区切换 -->
    <WorkspaceSwitcher />

    <!-- 中部：会话列表 -->
    <SessionList class="flex-1 overflow-y-auto" />

    <!-- 底部：后端状态 -->
    <BackendIndicator />
  </aside>
</template>

<script setup lang="ts">
import BackendIndicator from './BackendIndicator.vue'
import SessionList from './SessionList.vue'
import WorkspaceSwitcher from './WorkspaceSwitcher.vue'
</script>
