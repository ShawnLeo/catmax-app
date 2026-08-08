<template>
  <!--
    选中态与 hover 共用 sidebar-hover——都是轻量反馈，不需要"已选中"比"划过"更重的色块。
    侧栏专用色（不复用主区 muted），避免侧栏背景压暗后撞色看不清。
  -->
  <div
    :class="[
      'group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer',
      // 选中常驻、hover 临时——同色，靠是否常驻而非深浅来区分状态。
      active ? 'bg-sidebar-hover' : 'hover:bg-sidebar-hover',
    ]"
    @click="onClick"
    @contextmenu.prevent="$emit('contextmenu', $event)"
  >
    <!--
      会话状态指示器 + backend 图标（混排列表里用图标区分 codex / claude）。

      四态（按优先级）：
        1. running：旋转的 Loader2Icon（后台 turn 正在跑）
        2. unreadActivity：小蓝点（后台 turn 跑完了用户还没看）
           - 蓝色而非绿色：用户不知道任务成败，绿色暗示"成功"有误导
           - 用户切到该 session 时自动清掉（setCurrentSession 清 unreadActivity）
        3. 默认：显示 backend 图标（淡 muted 色，区分 codex/claude）
        4. 当前会话：也显示 backend 图标

      running 状态由 messageStore.sessionStates 跟踪——applyEvent 按 sessionId
      路由事件，所以后台 session 的 isRunning 也能正确更新。
      unreadActivity 在 turn_completed 且非当前 session 时置 true。
    -->
    <div class="w-4 h-4 flex-shrink-0 flex items-center justify-center">
      <Loader2Icon v-if="running" class="w-3.5 h-3.5 text-muted-foreground animate-spin" />
      <span
        v-else-if="unreadActivity && !active"
        class="block w-2 h-2 rounded-full bg-info"
        title="有新活动"
      />
      <BackendIcon
        v-else
        :backend="backend"
        :class="['w-3.5 h-3.5', active ? 'text-foreground' : 'text-muted-foreground']"
        :title="backend"
      />
    </div>

    <div class="flex-1 min-w-0">
      <!--
        Session Rename: 就地编辑——不弹对话框，输入框直接顶掉标题那一行。
        Enter / 失焦提交，Esc 取消。失焦也提交是刻意的：用户点到别处通常意味着
        "改好了"，弹窗式的"必须点确定"在这种一次改一个词的场景里是多余的一步。
      -->
      <input
        v-if="renaming"
        ref="renameInput"
        v-model="draftTitle"
        class="w-full bg-background border border-ring rounded px-1 py-0 text-[length:var(--ui-text-base)] text-foreground outline-none"
        @click.stop
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="cancelRename"
        @blur="commitRename"
      />
      <div v-else class="flex items-center gap-1">
        <!-- Session Pin: 置顶标记——图钉常驻显示，是列表顺序被打乱的唯一解释 -->
        <PinIcon
          v-if="session.pinnedAt !== null"
          class="w-3 h-3 flex-shrink-0 text-muted-foreground"
          title="已置顶"
        />
        <span class="text-[length:var(--ui-text-base)] text-foreground truncate">
          {{ session.title || '(新会话)' }}
        </span>
      </div>
      <div class="text-[length:var(--ui-text-d3)] text-muted-foreground">
        {{ formatRelativeTime(session.lastActiveAt) }}
      </div>
    </div>

    <!--
      更多操作（hover 显示）——点开的菜单跟右键完全一致，只是入口不同：
      右键适合快，这个按钮适合"知道有操作但想不起来右键"的路径，触屏/触控板也友好。

      menuOpen 时强制可见：菜单开着的时候鼠标已经离开这一行移到菜单上了，
      按钮跟着淡出会让人以为点错了地方。
    -->
    <button
      class="p-1 rounded transition-opacity hover:text-foreground cursor-pointer"
      :class="menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
      title="更多操作"
      aria-label="更多操作"
      @click.stop="$emit('menu', $event)"
    >
      <MoreVerticalIcon class="w-3.5 h-3.5" />
    </button>
  </div>
</template>

<script setup lang="ts">
import BackendIcon from '@renderer/components/icons/BackendIcon.vue'
import { formatRelativeTime } from '@renderer/lib/format'
import type { BackendId } from '@shared/constants'
import type { SessionView } from '@shared/domain'
import { Loader2Icon, MoreVerticalIcon, PinIcon } from 'lucide-vue-next'
import { nextTick, ref, watch } from 'vue'

const props = defineProps<{
  session: SessionView
  active: boolean
  /** 会话所属 backend——显示对应品牌图标区分 codex/claude */
  backend: BackendId
  /** 该会话是否有 turn 在后台跑（messageStore.sessionStates 跟踪） */
  running?: boolean
  /** 后台 turn 完成但用户还没查看（显示小蓝点提示） */
  unreadActivity?: boolean
  /** Session Rename: 由父组件控制是否进入就地编辑态（同一时刻只允许一条） */
  renaming?: boolean
  /** 操作菜单当前是否为这一条打开着——决定「更多」按钮要不要常驻可见 */
  menuOpen?: boolean
}>()

const emit = defineEmits<{
  click: []
  contextmenu: [event: MouseEvent]
  /** 点了「更多」按钮——父组件弹出跟右键一样的菜单 */
  menu: [event: MouseEvent]
  /** 提交新标题。父组件负责调 IPC，失败时自行决定是否退出编辑态 */
  rename: [title: string]
  /** 用户放弃编辑（Esc / 标题没变 / 空标题） */
  'rename-cancel': []
}>()

const draftTitle = ref('')
const renameInput = ref<HTMLInputElement | null>(null)
/**
 * blur 会在 Enter 提交后再触发一次（输入框被 v-if 移除时），Esc 同理。
 * 没有这个闸门就会 emit 两次 rename，多打一次 IPC。
 */
let submitted = false

watch(
  () => props.renaming,
  async (isRenaming) => {
    if (!isRenaming) return
    draftTitle.value = props.session.title ?? ''
    submitted = false
    await nextTick()
    renameInput.value?.focus()
    renameInput.value?.select()
  },
  { immediate: true },
)

function onClick(): void {
  // 编辑态下点自己不切换会话——否则刚点进输入框就触发一次会话加载
  if (props.renaming) return
  emit('click')
}

function commitRename(): void {
  if (submitted) return
  submitted = true
  const title = draftTitle.value.trim()
  // 空标题或没改动都按取消处理——不值得为"改了个寂寞"打一次 IPC
  if (!title || title === props.session.title) {
    emit('rename-cancel')
    return
  }
  emit('rename', title)
}

function cancelRename(): void {
  if (submitted) return
  submitted = true
  emit('rename-cancel')
}
</script>
