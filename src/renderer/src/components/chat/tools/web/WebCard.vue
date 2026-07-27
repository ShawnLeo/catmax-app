<template>
  <!--
    Web 工具卡片（WebSearch / WebFetch）。

    WebSearch：显示 query + 域名过滤（如有）
    WebFetch：显示 url + 可选 prompt

    output（结果摘要 / 抓取到的内容）由 ToolCallCard 外层统一渲染——
    Claude Code 里 WebSearch 返回的搜索结果列表常常是 markdown，所以走 MarkdownView。
    本组件只渲染 input（query/url/prompt），跟 control/* 的设计一致。
  -->
  <div class="space-y-1.5 py-0.5">
    <!-- query / url -->
    <div class="flex items-start gap-1.5 text-[13px]">
      <span class="text-muted-foreground flex-shrink-0 mt-0.5">{{
        info.type === 'search' ? '🔍' : '🔗'
      }}</span>
      <span class="font-mono text-foreground break-all">{{ info.query }}</span>
    </div>

    <!-- WebFetch 的 prompt -->
    <div v-if="info.prompt" class="text-[12px] text-muted-foreground italic pl-5">
      指令：{{ info.prompt }}
    </div>

    <!-- 域名过滤 -->
    <div
      v-if="info.type === 'search' && (info.allowedDomains?.length || info.blockedDomains?.length)"
      class="flex flex-wrap gap-1 pl-5"
    >
      <span
        v-for="d in info.allowedDomains ?? []"
        :key="`a-${d}`"
        class="text-[10px] px-1.5 py-0.5 rounded bg-success/10 text-success border border-success/20 font-mono"
      >
        + {{ d }}
      </span>
      <span
        v-for="d in info.blockedDomains ?? []"
        :key="`b-${d}`"
        class="text-[10px] px-1.5 py-0.5 rounded bg-destructive/10 text-destructive border border-destructive/20 font-mono"
      >
        − {{ d }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ToolWebInfo } from '@shared/backend/types'

defineProps<{ info: ToolWebInfo }>()
</script>
