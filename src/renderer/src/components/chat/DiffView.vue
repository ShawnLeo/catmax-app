<template>
  <!--
    文件编辑的结构化 diff 渲染。

    三种来源对应三种渲染：
    - unified_diff（codex）：标准 unified diff 文本，按行 +/- 前缀分色
    - string_replace（claude Edit/MultiEdit）：原/新两段对比，红色块=原文、绿色块=新文
    - full_content（claude Write）：整文件内容预览（大文件折叠）

    ToolCallCard 在 tool.info.edit 存在时优先用本组件；否则回退到 <pre> detail。
  -->
  <div class="text-[12px] font-mono">
    <!-- A. unified_diff：解析 git diff 文本 -->
    <template v-if="edit.type === 'unified_diff' && unifiedLines.length > 0">
      <div class="overflow-x-auto bg-code-block">
        <div
          v-for="(line, i) in unifiedLines"
          :key="i"
          :class="[
            'px-3 leading-relaxed whitespace-pre',
            line.kind === 'add' && 'bg-success/15 text-success',
            line.kind === 'del' && 'bg-destructive/15 text-destructive',
            line.kind === 'hunk' && 'text-muted-foreground bg-muted/30',
            line.kind === 'normal' && 'text-foreground/90',
          ]"
        >
          <span class="select-none inline-block w-4 text-muted-foreground/70">{{
            line.prefix
          }}</span
          ><span>{{ line.text }}</span>
        </div>
      </div>
    </template>

    <!-- B. string_replace：单组或多组 old/new 对比 -->
    <template v-else-if="edit.type === 'string_replace'">
      <!-- MultiEdit：多组 -->
      <template v-if="edit.edits && edit.edits.length > 1">
        <div
          v-for="(e, i) in edit.edits"
          :key="i"
          class="border-b border-border/50 last:border-b-0"
        >
          <div
            class="px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground bg-muted/50"
          >
            Edit {{ i + 1 }} / {{ edit.edits.length }}
          </div>
          <DiffReplaceBlock :old-string="e.oldString" :new-string="e.newString" />
        </div>
      </template>
      <!-- 单组 Edit -->
      <DiffReplaceBlock
        v-else-if="edit.oldString !== undefined || edit.newString !== undefined"
        :old-string="edit.oldString ?? ''"
        :new-string="edit.newString ?? ''"
      />
    </template>

    <!-- C. full_content：整文件预览，大文件折叠 -->
    <template v-else-if="edit.type === 'full_content'">
      <div
        class="px-3 py-1 text-[11px] text-muted-foreground border-b border-border/50 bg-muted/30"
      >
        写入 {{ edit.content ? edit.content.length : 0 }} 字符
      </div>
      <pre
        v-if="edit.content"
        class="px-3 py-2 text-foreground/90 whitespace-pre-wrap overflow-x-auto bg-code-block"
        :class="{ 'max-h-96 overflow-y-auto': isLargeContent }"
        >{{
          isLargeContent ? edit.content.split('\n').slice(0, 200).join('\n') : edit.content
        }}</pre>
      <button
        v-if="isLargeContent"
        class="w-full px-3 py-1 text-[11px] text-primary hover:underline bg-muted/30 border-t border-border/50 text-left"
        @click="showFullContent = !showFullContent"
      >
        {{ showFullContent ? '收起' : `展开全部 (${edit.content?.split('\n').length ?? 0} 行)` }}
      </button>
    </template>

    <!-- fallback：edit 字段存在但数据不全（极端情况） -->
    <pre v-else class="px-3 py-2 text-foreground/90 whitespace-pre-wrap bg-code-block">{{
      edit.filePath
    }}</pre>
  </div>
</template>

<script setup lang="ts">
import type { ToolEditInfo } from '@shared/backend/types'
import { computed, ref } from 'vue'

import DiffReplaceBlock from './DiffReplaceBlock.vue'

const props = defineProps<{ edit: ToolEditInfo }>()

const showFullContent = ref(false)

const isLargeContent = computed(() => {
  if (props.edit.type !== 'full_content') return false
  const lines = props.edit.content?.split('\n').length ?? 0
  return lines > 200 && !showFullContent.value
})

/**
 * 解析 unified diff 文本为带类型的行数组。
 *
 * 只识别：
 * - `++ ` / `@@ ... @@` → hunk 头（灰）
 * - `+xxx` → 新增行（绿）
 * - `-xxx` → 删除行（红）
 * - ` xxx` / 其他 → 普通行
 * 跳过 diff 元信息（index / --- / +++）让阅读区更干净。
 */
interface UnifiedLine {
  prefix: string
  text: string
  kind: 'add' | 'del' | 'hunk' | 'normal'
}

const unifiedLines = computed<UnifiedLine[]>(() => {
  if (props.edit.type !== 'unified_diff' || !props.edit.diff) return []
  const out: UnifiedLine[] = []
  for (const raw of props.edit.diff.split('\n')) {
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('index ')) continue
    if (raw.startsWith('@@')) {
      out.push({ prefix: ' ', text: raw, kind: 'hunk' })
    } else if (raw.startsWith('+')) {
      out.push({ prefix: '+', text: raw.slice(1), kind: 'add' })
    } else if (raw.startsWith('-')) {
      out.push({ prefix: '-', text: raw.slice(1), kind: 'del' })
    } else {
      // 行首可能是空格（unified diff 的 context line）或空字符串
      const text = raw.startsWith(' ') ? raw.slice(1) : raw
      out.push({ prefix: ' ', text, kind: 'normal' })
    }
  }
  return out
})
</script>
