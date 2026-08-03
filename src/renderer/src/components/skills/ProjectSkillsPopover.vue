<template>
  <!-- Unified Skill Center: 新建会话页「工作区 | 后端 | 技能 N」里的那个 N。
       放在这里是因为"这轮对话带着哪些技能"正是开聊前该确认的事，等聊起来再去
       设置页翻就晚了。 -->
  <span ref="rootRef" class="relative inline-flex items-center gap-1.5">
    <span>技能</span>
    <button
      type="button"
      class="inline-flex items-center gap-1.5 rounded font-medium text-foreground/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      :aria-expanded="open"
      aria-haspopup="dialog"
      aria-label="查看当前项目用户技能和系统技能数量"
      title="用户技能为当前项目技能；系统技能为设置页中的全局技能"
      @click="toggle"
    >
      <SparklesIcon class="h-3.5 w-3.5" />
      <span class="text-[length:var(--ui-text-d3)]">
        用户 {{ store.projectSkillCount }} · 系统 {{ store.systemSkillCount }}
      </span>
    </button>

    <div
      v-if="open"
      class="absolute bottom-full left-1/2 z-50 mb-2 max-h-96 w-[min(28rem,calc(100vw-3rem))] -translate-x-1/2 overflow-y-auto rounded-lg border border-border bg-popover p-2 text-left shadow-lg"
      role="dialog"
      aria-label="当前项目技能"
    >
      <p
        v-if="store.lastMessage"
        class="mb-2 rounded-md border border-border bg-muted p-2 text-[length:var(--ui-text-d3)] text-foreground"
      >
        {{ store.lastMessage }}
      </p>
      <div
        class="mb-2 grid grid-cols-2 gap-1 rounded-md bg-muted/60 p-1"
        role="tablist"
        aria-label="技能类型"
      >
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'user'"
          :class="tabClass(activeTab === 'user')"
          @click="activeTab = 'user'"
        >
          用户技能 <span class="opacity-70">{{ store.projectSkillCount }}</span>
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'system'"
          :class="tabClass(activeTab === 'system')"
          @click="activeTab = 'system'"
        >
          系统技能 <span class="opacity-70">{{ store.systemSkillCount }}</span>
        </button>
      </div>
      <div v-if="activeTab === 'user'" role="tabpanel" aria-label="用户技能">
        <SkillRow
          v-for="entry in store.projectSkills"
          :key="entry.id"
          :entry="entry"
          :busy="store.busyId === entry.id"
          :platform="platform"
          @toggle="onToggle"
          @open="store.openInEditor"
          @reveal="store.reveal"
          @mirror="store.mirror"
          @migrate="store.migrate"
          @remove="onRemove"
        />
        <p
          v-if="store.projectSkills.length === 0"
          class="px-2 py-4 text-center text-[length:var(--ui-text-d3)] text-muted-foreground"
        >
          当前项目没有用户技能。把技能放进
          <code class="font-mono">.agents/skills/</code> 就会出现在这里。
        </p>
      </div>
      <div v-else role="tabpanel" aria-label="系统技能">
        <SkillRow
          v-for="entry in store.systemSkills"
          :key="entry.id"
          :entry="entry"
          :busy="false"
          :platform="platform"
          readonly
          @open="store.openInEditor"
          @reveal="store.reveal"
        />
        <p
          v-if="store.systemSkills.length === 0"
          class="px-2 py-4 text-center text-[length:var(--ui-text-d3)] text-muted-foreground"
        >
          当前没有可读取的系统技能。
        </p>
      </div>
    </div>
  </span>
</template>

<script setup lang="ts">
import SkillRow from '@renderer/components/skills/SkillRow.vue'
import { useSkillsStore } from '@renderer/stores/skills'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { SkillEntry } from '@shared/skills/types'
import { SparklesIcon } from 'lucide-vue-next'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const store = useSkillsStore()
const workspaceStore = useWorkspaceStore()
const open = ref(false)
const activeTab = ref<'user' | 'system'>('user')
const platform = ref('')
const rootRef = ref<HTMLElement | null>(null)
let releaseFocusRefresh: (() => void) | null = null

onMounted(async () => {
  // 那个数字在 popover 打开之前就一直摆在界面上，过期的数字会误导"这轮带了几个
  // 技能"，所以它也得跟着窗口聚焦重扫，而不是只在点开时才对。
  releaseFocusRefresh = store.retainFocusRefresh()
  store.subscribeToBackendChanges()
  platform.value = (await window.api.system.platformInfo()).platform
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('keydown', onDocumentKeydown)
  await store.refresh()
})

onBeforeUnmount(() => {
  releaseFocusRefresh?.()
  releaseFocusRefresh = null
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  document.removeEventListener('keydown', onDocumentKeydown)
})

// 切工作区就得重扫——项目技能来自工作区文件夹，不重扫会把上一个项目的技能数
// 挂在新项目头上。
watch(
  () => workspaceStore.currentWorkspace?.id,
  () => void store.refresh(),
)

function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return
  if (rootRef.value?.contains(event.target as Node)) return
  open.value = false
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') open.value = false
}

async function toggle(): Promise<void> {
  open.value = !open.value
  // 每次打开都重扫：技能是磁盘上的文件，用户可能刚在外部编辑器里加了一个。
  // 两个后端都没有可靠的变更通知（claude 压根没有；codex 的 skills/changed 实测
  // 不由文件系统变更触发），所以"打开的瞬间"是唯一能保证列表是新的的时机。
  if (open.value) await store.refresh()
}

async function onToggle(entry: SkillEntry, enabled: boolean): Promise<void> {
  await store.setEnabled(entry, enabled)
}

async function onRemove(entry: SkillEntry): Promise<void> {
  if (!window.confirm(`确认删除技能「${entry.name}」？将删除 ${entry.primary.dir}`)) return
  await store.remove(entry)
}

function tabClass(active: boolean): string {
  return [
    'rounded px-2 py-1.5 text-[length:var(--ui-text-d3)] transition-colors',
    active
      ? 'bg-background text-foreground shadow-sm'
      : 'text-muted-foreground hover:text-foreground',
  ].join(' ')
}
</script>
