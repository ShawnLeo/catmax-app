<template>
  <!-- Unified Skill Center: 新建会话页「工作区 | 后端 | 技能 N」里的那个 N。
       放在这里是因为"这轮对话带着哪些技能"正是开聊前该确认的事，等聊起来再去
       设置页翻就晚了。 -->
  <span ref="rootRef" class="relative inline-flex items-center gap-1.5">
    <span>技能</span>
    <button
      ref="triggerRef"
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

    <!--
      Teleport 到 body + fixed 定位：避免被新建会话页祖先容器的 overflow / 层叠上下文
      裁掉（小窗口下居中的 absolute 会被切掉）。位置由脚本根据触发按钮坐标 + 视口边界
      实时计算，贴边时水平钳制、垂直翻转，宽度/高度随窗口自适应。参照 WorkspaceSwitcher
      （trigger 锚定）与 ContextMenu（视口翻转）的既有模式。
    -->
    <Teleport to="body">
      <div
        v-if="open"
        ref="panelRef"
        class="fixed z-[9999] w-[32rem] overflow-y-auto rounded-lg border border-border bg-popover p-2 text-left shadow-lg"
        :style="panelStyle"
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
    </Teleport>
  </span>
</template>

<script setup lang="ts">
import SkillRow from '@renderer/components/skills/SkillRow.vue'
import { useSkillsStore } from '@renderer/stores/skills'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { SkillEntry } from '@shared/skills/types'
import { SparklesIcon } from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const store = useSkillsStore()
const workspaceStore = useWorkspaceStore()
const open = ref(false)
const activeTab = ref<'user' | 'system'>('user')
const platform = ref('')
const rootRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
let releaseFocusRefresh: (() => void) | null = null

// 弹层定位——基于触发按钮视口坐标实时计算。Teleport 到 body 后不能用 absolute，
// 改 fixed；水平贴边钳制、垂直放不下就翻转向下，宽高随窗口自适应，保证小窗口不裁切。
const PANEL_MARGIN = 8
const PANEL_GAP = 8
const panelTop = ref(0)
const panelLeft = ref(0)
const panelMaxWidth = ref(0)
const panelMaxHeight = ref(0)
const panelStyle = computed(() => ({
  top: `${panelTop.value}px`,
  left: `${panelLeft.value}px`,
  maxWidth: panelMaxWidth.value ? `${panelMaxWidth.value}px` : undefined,
  maxHeight: panelMaxHeight.value ? `${panelMaxHeight.value}px` : undefined,
}))

/**
 * 重新计算弹层位置。挂载首帧 panel 还没量到尺寸，先用估算宽度（32rem 基准）算一次，
 * nextTick 后再以真实尺寸修正——避免首帧闪现在错误位置。
 */
function updatePosition(): void {
  const trigger = triggerRef.value
  if (!trigger) return
  const trigRect = trigger.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight

  const panel = panelRef.value
  const panelWidth = panel?.getBoundingClientRect().width ?? 512 // w-[32rem] = 512px

  // 水平：以触发按钮中心对齐弹窗中心，贴边则钳制到视口内（两侧各留 margin）
  let left = trigRect.left + trigRect.width / 2 - panelWidth / 2
  const maxLeft = vw - panelWidth - PANEL_MARGIN
  if (left > maxLeft) left = maxLeft
  if (left < PANEL_MARGIN) left = PANEL_MARGIN

  // 垂直：默认向上展开（与原 bottom-full 一致），上方放不下则翻转向下
  const panelHeight = panel?.getBoundingClientRect().height ?? 0
  const upTop = trigRect.top - PANEL_GAP - panelHeight
  let top: number
  let availableHeight: number
  if (upTop >= PANEL_MARGIN) {
    top = upTop
    availableHeight = trigRect.top - PANEL_GAP - PANEL_MARGIN
  } else {
    top = trigRect.bottom + PANEL_GAP
    availableHeight = vh - trigRect.bottom - PANEL_GAP - PANEL_MARGIN
  }

  panelTop.value = top
  panelLeft.value = left
  // 宽度兜底：理想 32rem，但不能超过视口减去两侧 margin
  panelMaxWidth.value = Math.min(512, vw - PANEL_MARGIN * 2)
  // 高度兜底：可用空间与 24rem 上限取小（避免弹窗过高撑满屏幕，保留内部滚动）
  panelMaxHeight.value = Math.min(384, availableHeight)
}

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

async function toggle(): Promise<void> {
  open.value = !open.value
  // 每次打开都重扫：技能是磁盘上的文件，用户可能刚在外部编辑器里加了一个。
  // 两个后端都没有可靠的变更通知（claude 压根没有；codex 的 skills/changed 实测
  // 不由文件系统变更触发），所以"打开的瞬间"是唯一能保证列表是新的的时机。
  if (open.value) await store.refresh()
}

// 窗口缩放时重新定位——弹窗是 fixed 的，缩放过程中要始终贴着触发器、不溢出视口
function handleResize(): void {
  if (open.value) updatePosition()
}

// 打开时等 DOM 渲染完算一次真实位置，关闭时移除监听
watch(open, async (isOpen) => {
  if (isOpen) {
    await nextTick()
    updatePosition()
    window.addEventListener('resize', handleResize)
  } else {
    window.removeEventListener('resize', handleResize)
  }
})

function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return
  // Teleport 后 panel 不在 rootRef 子树内，要单独判断：点在触发按钮或弹层内都不算外部
  const target = event.target as Node
  if (triggerRef.value?.contains(target)) return
  if (panelRef.value?.contains(target)) return
  open.value = false
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') open.value = false
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
