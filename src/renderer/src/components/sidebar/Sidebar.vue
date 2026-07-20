<template>
  <aside class="w-60 flex flex-col bg-sidebar border-r border-sidebar-border">
    <!-- 顶部：工作区切换 -->
    <WorkspaceSwitcher />

    <!-- 中部：会话列表（含 tab + 新建按钮，内部自己管滚动） -->
    <SessionList class="flex-1 overflow-hidden" />

    <!-- 底部：用户信息 + 设置 -->
    <SidebarFooter />
  </aside>
</template>

<script setup lang="ts">
import SessionList from './SessionList.vue'
import SidebarFooter from './SidebarFooter.vue'
import WorkspaceSwitcher from './WorkspaceSwitcher.vue'
</script>
