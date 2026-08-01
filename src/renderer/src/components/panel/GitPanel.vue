<template>
  <div class="h-full overflow-y-auto p-3">
    <!-- 非 repo -->
    <div
      v-if="!gitStore.status.isRepo"
      class="text-center text-[length:var(--ui-text-base)] text-muted-foreground py-8"
    >
      <GitBranchIcon class="w-8 h-8 mx-auto mb-2 opacity-50" />
      <p>当前工作区不是 git repo</p>
    </div>

    <template v-else>
      <!-- 分支信息 -->
      <div class="mb-4">
        <div class="flex items-center gap-2 text-[length:var(--ui-text-base)]">
          <GitBranchIcon class="w-4 h-4 text-muted-foreground" />
          <span class="font-medium">{{ gitStore.status.branch }}</span>
          <span
            v-if="gitStore.status.ahead > 0"
            class="text-[length:var(--ui-text-d3)] text-success"
          >
            ↑ {{ gitStore.status.ahead }}
          </span>
          <span
            v-if="gitStore.status.behind > 0"
            class="text-[length:var(--ui-text-d3)] text-warning"
          >
            ↓ {{ gitStore.status.behind }}
          </span>
          <button
            class="ml-auto text-[length:var(--ui-text-d3)] text-muted-foreground hover:text-foreground"
            @click="refresh"
          >
            刷新
          </button>
        </div>
      </div>

      <!-- Staged -->
      <section v-if="gitStore.status.staged.length > 0" class="mb-4">
        <h3
          class="text-[length:var(--ui-text-d3)] font-medium text-muted-foreground uppercase tracking-wide mb-1"
        >
          Staged ({{ gitStore.status.staged.length }})
        </h3>
        <div class="space-y-1">
          <FileChangeItem v-for="file in gitStore.status.staged" :key="file.path" :file="file" />
        </div>
      </section>

      <!-- Unstaged -->
      <section v-if="gitStore.status.unstaged.length > 0" class="mb-4">
        <h3
          class="text-[length:var(--ui-text-d3)] font-medium text-muted-foreground uppercase tracking-wide mb-1"
        >
          Unstaged ({{ gitStore.status.unstaged.length }})
        </h3>
        <div class="space-y-1">
          <FileChangeItem v-for="file in gitStore.status.unstaged" :key="file.path" :file="file" />
        </div>
      </section>

      <!-- Untracked -->
      <section v-if="gitStore.status.untracked.length > 0" class="mb-4">
        <h3
          class="text-[length:var(--ui-text-d3)] font-medium text-muted-foreground uppercase tracking-wide mb-1"
        >
          Untracked ({{ gitStore.status.untracked.length }})
        </h3>
        <div class="space-y-1">
          <button
            v-for="path in gitStore.status.untracked"
            :key="path"
            class="w-full text-left text-[length:var(--ui-text-d3)] font-mono text-foreground hover:bg-muted px-2 py-1 rounded truncate"
            :title="path"
          >
            {{ path }}
          </button>
        </div>
      </section>

      <!-- Recent commits -->
      <section v-if="gitStore.status.recentCommits.length > 0">
        <h3
          class="text-[length:var(--ui-text-d3)] font-medium text-muted-foreground uppercase tracking-wide mb-1"
        >
          最近提交
        </h3>
        <div class="space-y-2">
          <div
            v-for="commit in gitStore.status.recentCommits.slice(0, 5)"
            :key="commit.hash"
            class="text-[length:var(--ui-text-d3)]"
          >
            <div class="flex items-baseline gap-2">
              <span class="font-mono text-muted-foreground">{{ commit.shortHash }}</span>
              <span class="text-foreground truncate">{{ commit.message }}</span>
            </div>
            <div class="text-muted-foreground ml-1">{{ commit.author }} · {{ commit.date }}</div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useGitStore } from '@renderer/stores/git'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { GitBranchIcon } from 'lucide-vue-next'

import FileChangeItem from './FileChangeItem.vue'

const gitStore = useGitStore()
const workspaceStore = useWorkspaceStore()

async function refresh(): Promise<void> {
  if (workspaceStore.currentWorkspace) {
    await gitStore.refresh(workspaceStore.currentWorkspace.path)
  }
}
</script>
