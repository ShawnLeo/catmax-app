<template>
  <!--
    Claude Tool Folding: 一组相邻工具调用的折叠行。

    视觉语言与 codex 的 CodexActivityBlockView 保持一致（同一个图标尺寸、同一种
    dim 摘要行 + chevron），两个后端的"工作过程"在同一个对话流里读起来才是一回事。
    差别在展开态：codex 展开后是只读的活动清单，claude 展开后是原本的工具卡片，
    每张卡还能各自再展开看完整输出——工具输出对 claude 的使用方式更重要。
  -->
  <div class="text-[length:var(--chat-text-base)]">
    <button
      type="button"
      class="group flex max-w-full items-center gap-2 py-0.5 text-left text-muted-foreground transition-colors hover:text-foreground"
      :aria-expanded="open"
      @click="open = !open"
    >
      <LoaderCircleIcon v-if="block.status === 'running'" class="size-3.5 shrink-0 animate-spin" />
      <CircleXIcon
        v-else-if="block.status === 'failed'"
        class="size-3.5 shrink-0 text-destructive"
      />
      <component :is="summaryIcon" v-else class="size-3.5 shrink-0" />
      <span class="truncate">{{ summary }}</span>
      <ChevronDownIcon
        class="size-3 shrink-0 opacity-60 transition-transform"
        :class="open ? 'rotate-180' : ''"
      />
    </button>

    <!--
      展开态：原样交回 ToolCallBlockView。左侧留一条细竖线把这一组在视觉上收拢成
      一个整体，避免展开后和上下文的普通块混成一片分不清边界。
    -->
    <div v-if="open" class="mt-1 ml-1.5 flex flex-col gap-2 border-l border-border/60 pl-3">
      <ToolCallBlockView
        v-for="tool in block.tools"
        :key="tool.id"
        :block="tool"
        :cwd="cwd ?? ''"
        :show-thinking="showThinking ?? true"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ClaudeToolGroupContentBlock } from '@shared/backend/blocks'
import type { ToolCallInfo } from '@shared/backend/types'
import {
  ChevronDownIcon,
  CircleXIcon,
  FileTextIcon,
  GlobeIcon,
  LoaderCircleIcon,
  PencilIcon,
  SparklesIcon,
  TerminalIcon,
  WrenchIcon,
} from 'lucide-vue-next'
import { computed, ref } from 'vue'

import ToolCallBlockView from '../base/ToolCallBlockView.vue'

const props = defineProps<{
  block: ClaudeToolGroupContentBlock
  cwd?: string
  showThinking?: boolean
}>()

/**
 * 运行中默认展开，完成后默认折叠。
 *
 * 这两个默认值合起来正好让「跑完的样子」等于「重新打开的样子」：历史回放里的组
 * 全是 completed，初值就是折叠；实时跑完的组也是 completed。用户手动切换过之后
 * 由这个 ref 自己保持，不会被状态变化拽回去。
 */
const open = ref(props.block.status === 'running')

/** 组内工具按类别归并后的计数，保持首次出现的顺序。 */
const counts = computed(() => {
  const byLabel = new Map<string, number>()
  for (const tool of props.block.tools) {
    const label = categoryLabel(tool.info)
    byLabel.set(label, (byLabel.get(label) ?? 0) + 1)
  }
  return byLabel
})

/**
 * 摘要行文案：按类别计数、用 · 连接，对齐 Claude 自己的 "Ran 2 commands · 1 file"。
 *
 * 不必处理单工具的情形——foldClaudeToolGroups 保证只有 ≥2 个工具才成组，单个工具
 * 直接以 tool_call 原样渲染，不套这层壳。
 */
const summary = computed(() => {
  const running = props.block.status === 'running'
  const parts = [...counts.value].map(([label, count]) => `${count} ${label}`)
  return `${running ? '正在处理' : '已处理'} ${parts.join(' · ')}`
})

/** 组内类别单一时用该类别的图标，混合时用通用扳手。 */
const summaryIcon = computed(() => {
  const kinds = new Set(props.block.tools.map((tool) => tool.info.kind))
  if (kinds.size !== 1) return WrenchIcon
  return kindIcon([...kinds][0]!)
})

function categoryLabel(info: ToolCallInfo): string {
  switch (info.kind) {
    case 'shell_command':
      return '条命令'
    case 'file_edit':
      return '处改动'
    case 'file_read':
      return '个文件'
    case 'web':
      return '次检索'
    case 'task':
      return '个子任务'
    case 'mcp':
      return '次 MCP 调用'
    default:
      return '次工具调用'
  }
}

function kindIcon(kind: ToolCallInfo['kind']): typeof WrenchIcon {
  switch (kind) {
    case 'shell_command':
      return TerminalIcon
    case 'file_edit':
      return PencilIcon
    case 'file_read':
      return FileTextIcon
    case 'web':
      return GlobeIcon
    case 'task':
      return SparklesIcon
    default:
      return WrenchIcon
  }
}
</script>
