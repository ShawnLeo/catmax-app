<template>
  <aside v-if="visible" class="w-80 flex flex-col bg-card border-l border-border">
    <!-- Tab 头 -->
    <div class="flex border-b border-border">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        :class="[
          'flex-1 px-3 py-2 text-sm font-medium border-b-2 transition-colors',
          activeTab === tab.id
            ? 'border-primary text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground',
        ]"
        @click="activeTab = tab.id"
      >
        <component :is="tab.icon" class="w-4 h-4 inline-block mr-1" />
        {{ tab.label }}
        <span v-if="tab.badge" class="ml-1 text-xs text-muted-foreground">({{ tab.badge }})</span>
      </button>
    </div>

    <!-- Tab 内容 -->
    <div class="flex-1 overflow-hidden">
      <GitPanel v-if="activeTab === 'git'" />
      <FileTree v-else-if="activeTab === 'files'" />
    </div>
  </aside>
</template>

<script setup lang="ts">
import { useGitStore } from '@renderer/stores/git'
import { GitBranchIcon, FolderTreeIcon } from 'lucide-vue-next'
import { computed, ref } from 'vue'

import FileTree from './FileTree.vue'
import GitPanel from './GitPanel.vue'

defineProps<{ visible: boolean }>()

type TabId = 'git' | 'files'
const activeTab = ref<TabId>('git')
const gitStore = useGitStore()

const tabs = computed(() => [
  {
    id: 'git' as const,
    label: 'Git',
    icon: GitBranchIcon,
    badge: gitStore.totalChanges > 0 ? gitStore.totalChanges : undefined,
  },
  {
    id: 'files' as const,
    label: 'Files',
    icon: FolderTreeIcon,
    badge: undefined,
  },
])
</script>
