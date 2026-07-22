<template>
  <!--
    历史 /compact 条目——分隔线 + 可折叠的压缩摘要。

    历史回放时 /compact 在 jsonl 里写成 user message（textBlocks[0]='/compact' +
    textBlocks[1]=摘要原文）。UI 上不展示 /compact 命令本身，改为：
      1. CompactDivider（"上下文已压缩"静态分隔线）
      2. 下方一个可折叠的摘要块——收起态只显示一行提示，展开后显示完整摘要
         （max-h 限高 + 滚动条，避免超长摘要撑爆屏幕）

    跟 live 流的 CompactDivider 区分：live 用 pending/done 两态动画；
    历史永远是 done 态（compact 已完成），且附带摘要内容。
  -->
  <div class="my-4">
    <CompactDivider state="done" />

    <!-- 可折叠摘要块 -->
    <div v-if="summary" class="mt-2">
      <button
        type="button"
        class="flex items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground transition-colors w-full text-left"
        @click="expanded = !expanded"
      >
        <ChevronDownIcon
          class="w-3 h-3 flex-shrink-0 transition-transform"
          :class="expanded ? 'rotate-180' : ''"
        />
        <span>{{ expanded ? '收起压缩摘要' : '查看压缩摘要' }}</span>
      </button>

      <!--
        摘要内容：max-h 限高（约 20rem = 320px），超出滚动。
        monospace + muted 文字 + 背景区分，跟普通消息拉开视觉层次。
        whitespace-pre-wrap 保留摘要里的换行/缩进结构（编号列表等）。
      -->
      <div
        v-if="expanded"
        class="mt-1.5 max-h-80 overflow-y-auto rounded-md border border-border/50 bg-muted/30 p-3 text-[12px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-words"
      >
        {{ summary }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ChevronDownIcon } from 'lucide-vue-next'
import { ref } from 'vue'

import CompactDivider from './CompactDivider.vue'

defineProps<{
  /** /compact 生成的会话压缩摘要原文（可能很长）。无摘要时不传。 */
  summary?: string | undefined
}>()

/** 折叠态——默认展开（用户希望一眼看到 /compact 后的上下文摘要） */
const expanded = ref(true)
</script>
