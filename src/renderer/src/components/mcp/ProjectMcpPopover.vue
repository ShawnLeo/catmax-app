<template>
  <!-- Unified MCP Server Center: 新建会话页那一行里的「MCP N」。
       与技能同理——「这轮对话能用哪些 MCP 工具」正是开聊前该确认的事，等聊起来
       再去设置页翻就晚了。定位逻辑与 ProjectSkillsPopover 一致（Teleport + fixed +
       视口钳制/翻转），两个弹层的行为不该有差异。 -->
  <span ref="rootRef" class="relative inline-flex items-center gap-1.5">
    <span>MCP</span>
    <button
      ref="triggerRef"
      type="button"
      class="inline-flex items-center gap-1.5 rounded font-medium text-foreground/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      :aria-expanded="open"
      aria-haspopup="dialog"
      aria-label="查看当前工作区可用的 MCP server"
      title="项目为当前工作区的 MCP server；全局为所有会话都能用的"
      @click="toggle"
    >
      <PlugIcon class="h-3.5 w-3.5" />
      <span class="text-[length:var(--ui-text-d3)]">
        项目 {{ store.projectServers.length }} · 全局 {{ enabledGlobalCount }}
      </span>
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="panelRef"
        class="fixed z-[9999] w-[32rem] overflow-y-auto rounded-lg border border-border bg-popover p-2 text-left shadow-lg"
        :style="panelStyle"
        role="dialog"
        aria-label="当前工作区的 MCP server"
      >
        <p
          v-if="store.notice"
          class="mb-2 rounded-md border border-border bg-muted p-2 text-[length:var(--ui-text-d3)] text-foreground"
        >
          {{ store.notice.lines.join('；') }}
        </p>

        <div
          class="mb-2 grid grid-cols-2 gap-1 rounded-md bg-muted/60 p-1"
          role="tablist"
          aria-label="MCP server 作用域"
        >
          <button
            type="button"
            role="tab"
            :aria-selected="activeTab === 'project'"
            :class="tabClass(activeTab === 'project')"
            @click="activeTab = 'project'"
          >
            项目 <span class="opacity-70">{{ store.projectServers.length }}</span>
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="activeTab === 'global'"
            :class="tabClass(activeTab === 'global')"
            @click="activeTab = 'global'"
          >
            全局 <span class="opacity-70">{{ store.globalServers.length }}</span>
          </button>
        </div>

        <!-- 这里只做开关，不做同步/写入/删除：那几个都会改用户的配置文件，
             属于"坐下来处理"的操作，不该出现在一个开聊前顺手点开的弹层里。 -->
        <McpRow
          v-for="entry in activeEntries"
          :key="entry.id"
          :entry="entry"
          :busy="store.busyIds.has(entry.id)"
          :platform="platform"
          @reveal="store.reveal"
          @toggle="store.setEnabled"
          @trust="store.trustProject"
        />
        <p
          v-if="activeEntries.length === 0"
          class="px-1 py-3 text-[length:var(--ui-text-d3)] text-muted-foreground"
        >
          {{ activeTab === 'project' ? '当前工作区没有项目级 MCP server' : '没有全局 MCP server' }}
        </p>
      </div>
    </Teleport>
  </span>
</template>

<script setup lang="ts">
import McpRow from '@renderer/components/mcp/McpRow.vue'
import { useMcpStore } from '@renderer/stores/mcp'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import { PlugIcon } from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const store = useMcpStore()
const workspaceStore = useWorkspaceStore()
const open = ref(false)
const activeTab = ref<'project' | 'global'>('project')
const platform = ref('')
const rootRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
let releaseFocusRefresh: (() => void) | null = null

/**
 * 触发器上那个数字只算**启用的**。
 *
 * 它回答的是"这轮对话能用几个"，把关掉的也算进去就是虚报——而这个数字恰恰是用户
 * 唯一会扫一眼的地方，虚报比不显示更糟。
 */
const enabledGlobalCount = computed(() => store.globalServers.filter((e) => e.enabled).length)

const activeEntries = computed(() =>
  activeTab.value === 'project' ? store.projectServers : store.globalServers,
)

// 定位：与 ProjectSkillsPopover 完全一致——Teleport 到 body 后不能用 absolute，改 fixed；
// 水平贴边钳制、上方放不下就翻转向下，宽高随窗口自适应，小窗口下不被裁切。
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

function updatePosition(): void {
  const trigger = triggerRef.value
  if (!trigger) return
  const trigRect = trigger.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight

  const panel = panelRef.value
  const panelWidth = panel?.getBoundingClientRect().width ?? 512

  let left = trigRect.left + trigRect.width / 2 - panelWidth / 2
  const maxLeft = vw - panelWidth - PANEL_MARGIN
  if (left > maxLeft) left = maxLeft
  if (left < PANEL_MARGIN) left = PANEL_MARGIN

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
  panelMaxWidth.value = Math.min(512, vw - PANEL_MARGIN * 2)
  panelMaxHeight.value = Math.min(384, availableHeight)
}

onMounted(async () => {
  // 触发器上的数字在弹层打开之前就一直摆着，过期的数字会误导"这轮带了几个"，
  // 所以它也得跟着窗口聚焦重扫。
  releaseFocusRefresh = store.retainFocusRefresh()
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

// 切工作区必须重扫——项目级 server 来自工作区文件夹，不重扫会把上一个项目的
// 数字挂在新项目头上。
watch(
  () => workspaceStore.currentWorkspace?.id,
  () => void store.refresh(),
)

async function toggle(): Promise<void> {
  open.value = !open.value
  // 每次打开都重扫：MCP 配置是磁盘上的文件，用户可能刚在终端里 `claude mcp add` 过。
  // 两个后端都没有可靠的配置变更通知，所以"打开的瞬间"是唯一能保证列表是新的的时机。
  if (open.value) await store.refresh()
}

function handleResize(): void {
  if (open.value) updatePosition()
}

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
  // Teleport 后 panel 不在 rootRef 子树内，要单独判断。
  const target = event.target as Node
  if (triggerRef.value?.contains(target)) return
  if (panelRef.value?.contains(target)) return
  open.value = false
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') open.value = false
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
