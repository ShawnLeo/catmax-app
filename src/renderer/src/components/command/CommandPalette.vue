<template>
  <div
    v-if="visible"
    class="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/50"
    @click.self="close"
  >
    <div
      class="bg-popover text-popover-foreground rounded-lg shadow-xl w-full max-w-xl mx-4 overflow-hidden border border-border"
    >
      <!-- 搜索框 -->
      <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
        <SearchIcon class="w-4 h-4 text-muted-foreground" />
        <input
          ref="inputEl"
          v-model="query"
          placeholder="输入命令名或关键词..."
          class="flex-1 bg-transparent text-sm focus:outline-none text-foreground placeholder:text-muted-foreground"
          @keydown.esc="close"
          @keydown.enter="runSelected"
          @keydown.arrow-down="selectNext"
          @keydown.arrow-up="selectPrev"
        />
        <kbd class="text-xs text-muted-foreground px-1.5 py-0.5 border border-border rounded"
          >ESC</kbd
        >
      </div>

      <!-- 命令列表 -->
      <div v-if="results.length > 0" class="max-h-80 overflow-y-auto py-1">
        <button
          v-for="(cmd, i) in results"
          :key="cmd.id"
          :class="[
            'w-full flex items-center gap-3 px-4 py-2 text-left cursor-pointer',
            i === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
          ]"
          @click="run(cmd)"
        >
          <div class="flex-1 min-w-0">
            <div class="text-sm text-foreground truncate">{{ cmd.title }}</div>
            <div v-if="cmd.category" class="text-xs text-muted-foreground">{{ cmd.category }}</div>
          </div>
          <kbd v-if="cmd.shortcut" class="text-xs text-muted-foreground">{{ cmd.shortcut }}</kbd>
        </button>
      </div>
      <div v-else class="py-8 text-center text-sm text-muted-foreground">没有匹配的命令</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { commandRegistry, type Command } from '@renderer/lib/commandRegistry'
import { SearchIcon } from 'lucide-vue-next'
import { ref, computed, watch, nextTick } from 'vue'

const visible = defineModel<boolean>('visible', { default: false })

const query = ref('')
const selectedIndex = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)

const results = computed<Command[]>(() => commandRegistry.search(query.value))

watch(visible, async (v) => {
  if (v) {
    query.value = ''
    selectedIndex.value = 0
    await nextTick()
    inputEl.value?.focus()
  }
})

watch(query, () => {
  selectedIndex.value = 0
})

function close(): void {
  visible.value = false
}

async function run(cmd: Command): Promise<void> {
  close()
  await commandRegistry.run(cmd.id)
}

async function runSelected(): Promise<void> {
  if (results.value[selectedIndex.value]) {
    await run(results.value[selectedIndex.value]!)
  }
}

function selectNext(): void {
  if (selectedIndex.value < results.value.length - 1) {
    selectedIndex.value++
  }
}

function selectPrev(): void {
  if (selectedIndex.value > 0) {
    selectedIndex.value--
  }
}
</script>
