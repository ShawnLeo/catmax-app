<template>
  <!--
    工具调用卡片：shell 命令 / 文件编辑 / 文件读取 / MCP / 其他。

    展开后根据 tool.info 是否有结构化 edit 字段分派渲染：
    - 有 edit：用 DiffView 渲染真正的 diff（文件编辑场景）
    - 无 edit：detail 走终端样式 <pre>（黑底，命令 / 路径 / JSON）

    工具输出（tool.output.output）独立展示，shell 命令的 stdout 走这里。
  -->
  <div
    :class="[
      'rounded-md border text-sm font-sans overflow-hidden',
      tool.status === 'failed'
        ? 'border-destructive/50 bg-destructive/5'
        : 'border-tool-call-border bg-tool-call',
    ]"
  >
    <!-- 标题行 -->
    <button
      class="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50 transition-colors text-left"
      @click="expanded = !expanded"
    >
      <span class="flex-shrink-0">
        <component :is="iconForKind(tool.info.kind)" class="w-4 h-4" />
      </span>
      <span class="flex-1 truncate font-medium text-foreground">
        {{ tool.info.title }}
      </span>
      <span v-if="tool.status === 'running'" class="text-xs text-muted-foreground animate-pulse">
        running...
      </span>
      <span v-else-if="tool.status === 'completed'" class="text-xs text-success">
        {{ tool.output?.summary }}
      </span>
      <span v-else class="text-xs text-destructive">
        {{ tool.output?.summary ?? 'failed' }}
      </span>
      <ChevronDownIcon :class="['w-4 h-4 transition-transform', expanded ? 'rotate-180' : '']" />
    </button>

    <!-- 展开后：详细输出 -->
    <div v-if="expanded" class="border-t border-tool-call-border">
      <!-- 文件编辑：优先用 DiffView 渲染结构化 diff -->
      <DiffView v-if="tool.info.edit" :edit="tool.info.edit" />

      <!-- 非 diff 场景：detail 走终端样式 <pre>（黑底，命令/JSON/路径） -->
      <pre
        v-else-if="tool.info.detail"
        class="font-mono text-[12px] bg-terminal text-foreground p-3 overflow-x-auto whitespace-pre-wrap"
        >{{ tool.info.detail }}</pre>

      <!-- 工具输出（如 shell 命令的 stdout） -->
      <pre
        v-if="tool.output?.output"
        :class="[
          'font-mono text-[12px] bg-terminal text-foreground/80 p-3 overflow-x-auto whitespace-pre-wrap',
          tool.info.edit || tool.info.detail ? 'border-t border-tool-call-border' : '',
        ]"
        >{{ tool.output.output }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { NormalizedMessage } from '@shared/backend/types'
import { ChevronDownIcon, TerminalIcon, FileEditIcon, WrenchIcon } from 'lucide-vue-next'
import { ref, type Component } from 'vue'

import DiffView from './DiffView.vue'

defineProps<{
  tool: NonNullable<NormalizedMessage['toolBlocks']>[number]
}>()

const expanded = ref(false)

function iconForKind(kind: string): Component {
  switch (kind) {
    case 'shell_command':
      return TerminalIcon
    case 'file_edit':
      return FileEditIcon
    default:
      return WrenchIcon
  }
}
</script>
