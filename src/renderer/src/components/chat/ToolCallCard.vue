<template>
  <!--
    工具调用卡片：Claude Code 风极简样式。

    三态交互（跟 Claude Code 一致）：
      - collapsed（收起）：只显示 header 一行
      - preview（默认）：展开 + 内容限高 max-h-40（约 10 行内滚动）
      - expanded（全展）：内容不限高，看完整输出
    点 header 在 preview ↔ expanded 之间切换；右下角小按钮可单独 collapse。

    header: [icon] [Type]  [path/command]      [●] [⌄]
  -->
  <div
    :class="[
      'rounded-md border transition-colors overflow-hidden',
      tool.status === 'failed'
        ? 'border-destructive/40 bg-destructive/5'
        : 'border-border/60 bg-transparent hover:bg-muted/40',
    ]"
  >
    <!-- 标题行：点击在 preview ↔ expanded 之间切换 -->
    <button class="w-full flex items-center gap-2 px-3 py-1.5 text-left" @click="toggleExpand">
      <component
        :is="iconForKind(tool.info.kind)"
        class="w-3.5 h-3.5 text-muted-foreground flex-shrink-0"
      />
      <span class="text-[12px] font-medium text-foreground flex-shrink-0">{{ typeName }}</span>
      <span
        class="text-[12px] text-muted-foreground font-mono truncate flex-1 min-w-0"
        :title="displayPathTooltip"
        >{{ displayPath }}</span
      >

      <!-- 箭头：preview 不旋转；expanded 旋转 180 -->
      <ChevronDownIcon
        :class="[
          'w-3.5 h-3.5 text-muted-foreground transition-transform flex-shrink-0',
          mode === 'expanded' ? 'rotate-180' : '',
        ]"
        :title="mode === 'expanded' ? '点击限高预览' : '点击全展开'"
      />
    </button>

    <!--
      内容区：preview 模式限高（max-h ≈ 10rem = 160px），expanded 模式不限高。
      max-h 用 inline style——Tailwind v4 的 max-h-40 在动态 :class 里 JIT 可能扫不到。

      渲染优先级（互斥，第一个匹配的胜出）：
        1. control：控制流工具（EnterPlanMode/ExitPlanMode/TodoWrite）
        2. edit：文件编辑（Edit/Write/MultiEdit）→ DiffView
        3. output：stdout（shell_command 优先显示这个，不再重复显示命令本身）
        4. detail：fallback 显示原始 input JSON（但跳过 "{}" 空对象）
    -->
    <div
      v-if="mode !== 'collapsed'"
      class="border-t border-border/40 overflow-y-auto"
      :style="mode === 'preview' ? 'max-height: 10rem;' : 'max-height: none;'"
    >
      <!-- 控制流工具：专门的渲染组件 -->
      <component
        v-if="tool.info.control && controlComponent"
        :is="controlComponent"
        :control="tool.info.control"
        class="p-3"
      />

      <!-- web 工具（WebSearch/WebFetch）：渲染 input 卡片 + output 走 markdown -->
      <div v-else-if="tool.info.web" class="flex flex-col">
        <WebCard :info="tool.info.web" class="p-3" />
        <!-- output（搜索结果 / 抓取内容）走 markdown 渲染——比 pre 更易读 -->
        <MarkdownView
          v-if="tool.output?.output"
          :text="tool.output.output"
          class="text-[13px] text-foreground/90 border-t border-border/40 p-3"
        />
      </div>

      <!-- Task 工具：子 agent 摘要 + 运行计时/完成统计 -->
      <TaskCard
        v-else-if="tool.info.task"
        :task="tool.info.task"
        :tool="tool"
        :cwd="cwd"
        :show-thinking="showThinking ?? true"
        class="p-3"
      />

      <!-- 文件编辑：DiffView 渲染结构化 diff -->
      <DiffView v-else-if="tool.info.edit" :edit="tool.info.edit" />

      <!--
        shell_command：只显示 stdout（output），不显示 detail（命令本身）。
        header 已经显示了命令，再显示一遍 detail 是冗余。
        没 output 时（命令还在跑或没产出）就什么都不显示。
      -->
      <pre
        v-else-if="tool.info.kind === 'shell_command' && tool.output?.output"
        class="font-mono text-[12px] bg-terminal text-foreground/80 p-3 overflow-x-auto whitespace-pre-wrap"
        >{{ tool.output.output }}</pre>

      <!--
        其他工具（file_read/mcp/other）：优先显示 output，没 output 才显示 detail。
        跳过 detail === '{}'（空对象 JSON）——没意义的占位。
      -->
      <pre
        v-else-if="tool.output?.output"
        class="font-mono text-[12px] bg-terminal text-foreground/80 p-3 overflow-x-auto whitespace-pre-wrap"
        >{{ tool.output.output }}</pre>
      <pre
        v-else-if="tool.info.detail && tool.info.detail !== '{}'"
        class="font-mono text-[12px] bg-terminal text-foreground p-3 overflow-x-auto whitespace-pre-wrap"
        >{{ tool.info.detail }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { basename } from '@renderer/lib/path'
import type { NormalizedMessage } from '@shared/backend/types'
import {
  BotIcon,
  ChevronDownIcon,
  FileEditIcon,
  FileSearchIcon,
  GlobeIcon,
  ListTodoIcon,
  TerminalIcon,
  WrenchIcon,
} from 'lucide-vue-next'
import { computed, ref, type Component } from 'vue'

import EnterPlanModeCard from './control/EnterPlanModeCard.vue'
import ExitPlanModeCard from './control/ExitPlanModeCard.vue'
import TodoWriteCard from './control/TodoWriteCard.vue'
import DiffView from './DiffView.vue'
import MarkdownView from './MarkdownView.vue'
import TaskCard from './task/TaskCard.vue'
import WebCard from './web/WebCard.vue'

const props = defineProps<{
  tool: NonNullable<NormalizedMessage['toolBlocks']>[number]
  /** 工作区目录--子 agent 读 jsonl 需要 */
  cwd: string
  /** 是否显示思考块（透传给子 agent） */
  showThinking?: boolean
}>()

/**
 * 三态：collapsed / preview / expanded
 *
 * 默认 preview——内容展开但限高 max-h-40（约 10 行内滚动）。
 * 点 header 在 preview ↔ expanded 切换。
 * （未来如果需要 collapsed 态，再加单独的收起按钮。）
 */
const mode = ref<'collapsed' | 'preview' | 'expanded'>('preview')

function toggleExpand(): void {
  mode.value = mode.value === 'expanded' ? 'preview' : 'expanded'
}

/** kind → icon 映射。加新 kind 在这里加 case。
 *  control 类型按 control.type 细分（todo_write 用 ListTodoIcon，其他用 WrenchIcon）。
 */
function iconForKind(kind: string): Component {
  switch (kind) {
    case 'shell_command':
      return TerminalIcon
    case 'file_edit':
      return FileEditIcon
    case 'file_read':
      return FileSearchIcon
    case 'web':
      return GlobeIcon
    case 'task':
      return BotIcon
    case 'control':
      // control 按 control.type 进一步选 icon
      if (props.tool.info.control?.type === 'todo_write') return ListTodoIcon
      return WrenchIcon
    default:
      return WrenchIcon
  }
}

/** control.type → 渲染组件映射 */
const controlComponent = computed<Component | null>(() => {
  switch (props.tool.info.control?.type) {
    case 'enter_plan_mode':
      return EnterPlanModeCard
    case 'exit_plan_mode':
      return ExitPlanModeCard
    case 'todo_write':
      return TodoWriteCard
    default:
      return null
  }
})

/**
 * 从 tool.info.title 拆出"类型名"。
 *
 * 优先按 mapping 层带的"ToolName: ..."前缀（claude Edit/Write/MultiEdit/NotebookEdit 都是这个格式）；
 * 没前缀时按 kind 推断（shell_command → Bash、file_read → Read、mcp → MCP）。
 */
const typeName = computed(() => {
  const title = props.tool.info.title
  const m = title.match(/^(Edit|Write|MultiEdit|NotebookEdit|NotebookRead):\s*(.+)$/)
  if (m) return m[1]
  // WebSearch/WebFetch 走 web 前缀
  const wm = title.match(/^(WebSearch|WebFetch):\s*(.+)$/)
  if (wm) return wm[1]
  // Task 前缀
  const tm = title.match(/^Task:\s*(.+)$/)
  if (tm) return 'Task'
  switch (props.tool.info.kind) {
    case 'shell_command':
      return 'Bash'
    case 'file_read':
      return 'Read'
    case 'mcp':
      return 'MCP'
    case 'file_edit':
      return 'Edit'
    case 'web':
      // 兼容旧消息 fallback
      return title.startsWith('WebFetch') ? 'WebFetch' : 'WebSearch'
    case 'task':
      return 'Task'
    case 'control':
      // 按 control.type 给友好名称
      switch (props.tool.info.control?.type) {
        case 'enter_plan_mode':
          return 'Plan'
        case 'exit_plan_mode':
          return 'Plan'
        case 'todo_write':
          return 'Todo'
        default:
          return 'Action'
      }
    default:
      // 兼容旧消息（mapping 还没刷新时 kind 仍是 'other'，但 title 是工具名）：
      // 识别已知的控制流工具名，给个友好名称
      if (/^(EnterPlanMode|ExitPlanMode)$/.test(title)) return 'Plan'
      if (title === 'TodoWrite') return 'Todo'
      if (/^(WebSearch|WebFetch)$/.test(title)) return title
      if (title === 'Task') return 'Task'
      return 'Tool'
  }
})

/**
 * 从 title 拆出"路径/命令"——去掉 "ToolName:" 前缀后的剩余部分。
 *
 * 对 file_edit / file_read 类：只显示 basename（文件名），完整路径太长 truncate 会
 * 把文件名截没。完整路径仍可通过 hover tooltip 看到（displayPathTooltip）。
 *
 * 对 shell_command / mcp / web：显示完整内容（命令 / 工具名 / query / url）。
 */
const fullPath = computed(() => {
  const title = props.tool.info.title
  const m = title.match(/^(Edit|Write|MultiEdit|NotebookEdit|NotebookRead):\s*(.+)$/)
  if (m) return m[2]!
  const wm = title.match(/^(WebSearch|WebFetch):\s*(.+)$/)
  if (wm) return wm[2]!
  const tm = title.match(/^Task:\s*(.+)$/)
  if (tm) return tm[1]!
  // 控制流工具：不显示路径，fullPath 为空（typeName 已经表达了语义）
  if (props.tool.info.kind === 'control') return ''
  // 兼容旧消息：识别控制流工具名，fullPath 为空
  if (/^(EnterPlanMode|ExitPlanMode|TodoWrite)$/.test(title)) return ''
  // shell_command / mcp / file_read / other / task（无前缀时）：title 本身就是要显示的内容
  return title
})

const displayPath = computed(() => {
  const fp = fullPath.value
  if (!fp) return ''
  // file_edit / file_read 只显示 basename
  if (props.tool.info.kind === 'file_edit' || props.tool.info.kind === 'file_read') {
    return basename(fp)
  }
  // 其他（shell_command / mcp）显示完整内容
  return fp
})

/** hover tooltip——文件类工具显示完整路径 */
const displayPathTooltip = computed(() => {
  if (!fullPath.value) return undefined
  if (props.tool.info.kind === 'file_edit' || props.tool.info.kind === 'file_read') {
    return fullPath.value
  }
  return undefined
})
</script>
