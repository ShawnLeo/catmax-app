<template>
  <!--
    Composer Autocomplete: 候选列表弹层。

    纯受控——自己不搜索、不记选中项、不监听键盘，全部由 useAutocomplete 决定。
    这样同一个弹层能直接服务下一期的斜杠命令/技能/MCP，不用为每种联想复制一份。

    定位固定在输入框正上方、跟输入框同宽，不跟随光标：跟随光标要在镜像层里
    测字符坐标，而它换来的收益只有「弹层离光标近一点」。左对齐 + 同宽在窄面板
    下也不会溢出容器。
  -->
  <div class="absolute bottom-full left-0 right-0 z-20 mb-2">
    <div
      ref="listRef"
      class="max-h-60 overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-lg"
      role="listbox"
    >
      <button
        v-for="(item, i) in items"
        :key="item.id"
        type="button"
        role="option"
        :data-index="i"
        :aria-selected="i === activeIndex"
        :class="[
          'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left',
          i === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
        ]"
        @mouseenter="emit('hover', i)"
        @mousedown.prevent="emit('select', i)"
      >
        <!-- mousedown.prevent 而不是 click：click 之前 textarea 会先失焦，
             失焦会把弹层关掉，等 click 到达时已经没有这一项了。 -->
        <FileTypeIcon
          v-if="item.icon && item.icon.kind === 'file'"
          :name="item.icon.name"
          :is-directory="item.icon.isDirectory"
          class="h-4 w-4 flex-shrink-0"
        />
        <component
          :is="item.icon.component"
          v-else-if="item.icon && item.icon.kind === 'lucide'"
          class="h-4 w-4 flex-shrink-0 text-muted-foreground"
        />

        <span class="truncate font-mono text-[length:var(--chat-text-d1)] text-foreground">
          {{ item.label }}
        </span>
        <!-- 次要信息靠右，且优先被压缩——文件名才是用来认人的那一段 -->
        <span
          v-if="item.detail"
          class="ml-auto min-w-0 truncate text-[length:var(--ui-text-d3)] text-muted-foreground"
        >
          {{ item.detail }}
        </span>
      </button>

      <div
        v-if="items.length === 0"
        class="px-3 py-2 text-[length:var(--ui-text-d3)] text-muted-foreground"
      >
        {{ loading ? '搜索中…' : emptyText }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import FileTypeIcon from '@renderer/components/panel/FileTypeIcon.vue'
import type { SuggestionItem } from '@renderer/lib/autocomplete'
import { ref, watch } from 'vue'

const props = defineProps<{
  items: SuggestionItem[]
  activeIndex: number
  loading: boolean
  emptyText: string
}>()

const emit = defineEmits<{
  select: [index: number]
  hover: [index: number]
}>()

const listRef = ref<HTMLElement | null>(null)

/*
 * 键盘选到可视区外的项时要跟着滚。
 *
 * block: 'nearest' 而不是 'center'——后者会在每次按方向键时把整个列表重新居中，
 * 看起来像列表自己在跳。
 *
 * 按 data-index 查而不是收集 v-for 的 ref 数组：Vue 3.5 起那个数组的顺序不再
 * 保证跟数据源一致，按下标取会取到别的项。
 */
watch(
  () => props.activeIndex,
  (index) => {
    listRef.value?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  },
)
</script>
