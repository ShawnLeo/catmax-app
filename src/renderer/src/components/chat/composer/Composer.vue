<template>
  <!--
    底部输入区——圆角输入框悬浮风格（对齐 Claude Code）。

    外层无边框无背景（透明），跟主体聊天区背景完全贯通，
    圆角输入框视觉上悬浮在底部。内层带 border + rounded 的容器把附件区 /
    textarea / 底部配置行包在一起。

    底部配置行：Model / Effort / PermissionMode 三个 select 跟发送按钮平齐。
    这三个之前在 RuntimeConfigBar 顶部，下沉到这里更接近"发消息时随手调"的场景。

    宽度：内层用跟 MessageList 一致的响应式 max-width + mx-auto 居中，
    保证输入框跟上方消息列表左右对齐。
  -->
  <div>
    <div :class="[chatContentWidthClass(navRailVisible), 'p-3']">
      <!-- 圆角输入容器(@container:作为容器查询的锚点,底部配置行根据此容器实际宽度
           折叠/展开,而不是根据视口宽度——这样右侧面板挤压时能正确响应)。
           注意：不加 overflow-hidden——否则 DropdownMenu/ThinkingSlider 的弹层
           会被容器裁切（弹层在按钮上方时超出容器上边界）。内部子元素的圆角
           由各自的 rounded-* 控制，textarea/AttachmentBar 没有溢出元素，
           容器自身圆角不会露出直角。-->
      <!-- File Preview Tabs: 输入容器背景与左侧会话列表统一(bg-sidebar),
           跟主体聊天区(--background)形成轻微对比,呼应侧边栏的层次感。 -->
      <!-- relative:联想弹层(SuggestionPopover)以此为定位锚，贴在输入框正上方 -->
      <div
        class="relative rounded-2xl border border-border bg-sidebar focus-within:border-primary/50 transition-colors @container"
      >
        <!-- Composer Autocomplete: `@` 文件联想。候选来源由 lib/autocomplete 的
             registry 决定，这里只负责摆位置和转发事件。 -->
        <SuggestionPopover
          v-if="suggestOpen"
          :items="suggestItems"
          :active-index="suggestIndex"
          :loading="suggestLoading"
          :empty-text="suggestEmptyText"
          @select="applySuggestion"
          @hover="setSuggestActive"
        />

        <!-- 附件区 -->
        <AttachmentBar
          :attachments="chatInput.pendingAttachments"
          :file-mentions="chatInput.fileMentions"
          @remove="chatInput.removeAttachment"
          @remove-mention="chatInput.removeFileMention"
        />

        <!-- textarea（带 @路径 高亮，见 MentionTextarea） -->
        <MentionTextarea
          ref="mentionInput"
          v-model="prompt"
          :placeholder="disabled ? '后端未连接...' : hint"
          :disabled="disabled"
          :rows="3"
          @keydown="onKeyDown"
          @paste="onPaste"
          @caret="onCaret"
          @blur="closeSuggestions"
        />

        <!-- 底部配置行：Model / Effort / 权限(盾牌) + 发送按钮。
             用 @container 响应自身宽度(非视口),右面板挤压时优雅折叠:
               - 正常(宽):全部显示,带文字标签
               - 紧凑:Model 隐藏文字只留 chevron、Effort 隐藏文字+chevron 只留脑图标
               - 极窄:隐藏刷新按钮
               权限盾牌 + Model + Effort + 发送按钮 永不隐藏 -->
        <div class="flex items-center gap-2 px-3 py-2">
          <!--
            File Mention: 加号 = 选文件加进对话。拖放没有可见入口，这是它的
            按钮形态入口；跟 Model 一样永不折叠，窄屏下它只占一个图标的宽度。
          -->
          <button
            type="button"
            class="composer-add text-secondary-foreground/70 hover:text-secondary-foreground hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            :disabled="disabled"
            title="添加文件到对话"
            aria-label="添加文件到对话"
            @click="onPickFiles"
          >
            <PlusIcon class="w-4 h-4" />
          </button>

          <!-- Model(最高优先级,几乎一直显示;窄时只显图标) -->
          <DropdownMenu
            :model-value="modelValue.model"
            :options="[
              { value: null as string | null, label: '(default)' },
              ...backendStore.models.map((m) => ({
                value: m.id as string | null,
                label: m.displayName,
              })),
            ]"
            placement="top"
            title="模型"
            :trigger-width="120"
            class="composer-model-trigger"
            @update:model-value="onModelSelect"
          />

          <!-- 刷新模型列表--清 main 端 cachedModelsPromise，重新拉一次 model/list。
               低优先级:窄屏隐藏(composer-refresh,样式在 <style> 里用容器查询控制)。 -->
          <button
            type="button"
            class="composer-refresh text-secondary-foreground/60 hover:text-secondary-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            :disabled="refreshing"
            title="刷新模型列表"
            @click="onRefreshModels"
          >
            <RefreshCwIcon class="w-3 h-3" :class="refreshing ? 'animate-spin' : ''" />
          </button>

          <!-- 思考强度（合并了旧 effort select + thinking 开关到同一数轴）
               点击展开横向档位滑块；max 档启用紫色脉冲动画。 -->
          <ThinkingSlider
            :model-value="modelValue.effort ?? 'medium'"
            :supported="supportedEfforts"
            class="composer-effort-trigger"
            @update:model-value="onEffortSelect"
          />

          <!-- Permission Mode:盾牌图标 + 当前模式文字。
               Composer 宽度够时显示文字(默认/自动接受编辑/计划模式...),
               < 30rem 时只留盾牌图标(见下方容器查询)。
               bypassPermissions(完全跳过)时盾牌变 amber 警告色。 -->
          <PermissionShieldButton
            :model-value="modelValue.permissionMode"
            :options="
              supportedPermissionModes.map((m) => ({
                value: m,
                label: permissionLabel(m),
              }))
            "
            class="composer-perm"
            @update:model-value="onPermissionModeSelect"
          />

          <div class="flex-1" />

          <!--
            这里原本有一条写死的「Shift+Enter 换行」。提示改成在占位符里轮换后
            它就成了重复信息，而且是唯一一条永远不变的——留着反而显得占位符
            在乱跳。提示只有一个出口。
          -->

          <!--
            发送 / 停止按钮——方形带圆角（非纯圆）。
            黑白灰主题下用图标形态区分语义：发送=上箭头，停止=实心方块。
            发送按钮可点击时反相为 foreground/background（夜间白底黑箭头，日间黑底白箭头），
            禁用时保持弱化的 primary 灰阶。
          -->
          <Button
            v-if="messageStore.isRunning"
            size="icon"
            class="h-7 w-7 rounded-md"
            title="停止"
            @click="onInterrupt"
          >
            <SquareIcon class="w-3 h-3 fill-current" />
          </Button>
          <Button
            v-else
            size="icon"
            class="h-7 w-7 rounded-md"
            :class="canSend ? 'bg-foreground text-background hover:bg-foreground/90' : ''"
            :disabled="!canSend"
            title="发送 (Enter)"
            @click="onSend"
          >
            <ArrowUpIcon class="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import AttachmentBar from '@renderer/components/chat/composer/AttachmentBar.vue'
import MentionTextarea from '@renderer/components/chat/composer/MentionTextarea.vue'
import PermissionShieldButton from '@renderer/components/chat/composer/PermissionShieldButton.vue'
import SuggestionPopover from '@renderer/components/chat/composer/SuggestionPopover.vue'
import ThinkingSlider from '@renderer/components/chat/composer/ThinkingSlider.vue'
import { Button } from '@renderer/components/ui/button'
import { DropdownMenu } from '@renderer/components/ui/dropdown-menu'
import { useAutocomplete } from '@renderer/composables/useAutocomplete'
import { composerSuggestions, type SuggestionCommand } from '@renderer/lib/autocomplete'
import { chatContentWidthClass } from '@renderer/lib/chat-layout'
import { shuffledHints } from '@renderer/lib/composer-hints'
import { mentionPathFor } from '@renderer/lib/mention-path'
import { useBackendStore } from '@renderer/stores/backend'
import { useChatInputStore } from '@renderer/stores/chat-input'
import { useMessageStore } from '@renderer/stores/message'
import { useSettingsStore } from '@renderer/stores/settings'
import { useSlashCommandStore } from '@renderer/stores/slash-commands'
import { useWorkspaceStore } from '@renderer/stores/workspace'
import type { ContextBlock, EffortLevel, PermissionMode } from '@shared/backend/types'
import { ArrowUpIcon, PlusIcon, RefreshCwIcon, SquareIcon } from 'lucide-vue-next'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

interface RuntimeConfigValue {
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode
}

const props = defineProps<{
  disabled?: boolean
  modelValue: RuntimeConfigValue
  navRailVisible?: boolean
}>()
const emit = defineEmits<{
  send: [text: string, attachments: ContextBlock[]]
  /**
   * 斜杠命令被选中——codex 的命令是动作不是文本，见 SuggestionItem.command。
   * 输入框在派发前已被清空，使用方不必再管它。
   */
  command: [command: SuggestionCommand]
  'update:modelValue': [value: RuntimeConfigValue]
}>()

const messageStore = useMessageStore()
const settingsStore = useSettingsStore()
const backendStore = useBackendStore()
const workspaceStore = useWorkspaceStore()
const chatInput = useChatInputStore()
const slashCommandStore = useSlashCommandStore()
// File Mention: 输入框文本住在 store 里——拖放遮罩、文件树右键菜单这些跟 Composer
// 没有父子关系的地方都要往里写引用，见 chat-input store 的说明。
const prompt = computed({
  get: () => chatInput.text,
  set: (value: string) => {
    chatInput.text = value
  },
})

/*
 * Composer Autocomplete: `@` 文件联想 + `/` 斜杠命令。
 *
 * Composer 在这条链路上只做三件事——把光标位置转进去、把按键优先让给它、
 * 把它算好的文本写回来。搜什么、怎么排、插入什么形态全在 lib/autocomplete 里，
 * 再加一种联想时这段接线一行都不用改。
 */
const mentionInput = ref<InstanceType<typeof MentionTextarea> | null>(null)

const {
  open: suggestOpen,
  items: suggestItems,
  activeIndex: suggestIndex,
  loading: suggestLoading,
  emptyText: suggestEmptyText,
  refresh: refreshSuggestions,
  handleKeydown: handleSuggestKeydown,
  applyAt: applySuggestion,
  setActive: setSuggestActive,
  close: closeSuggestions,
} = useAutocomplete({
  registry: composerSuggestions,
  // 每次检测/搜索都重新取——切工作区、切会话（会话的后端不可变，打开会话时
  // backendStore 会切过去）都要立刻反映到候选内容上。
  context: () => ({
    workspaceId: workspaceStore.currentWorkspace?.id,
    ...(workspaceStore.currentWorkspace?.folders !== undefined && {
      workspaceFolders: workspaceStore.currentWorkspace.folders,
    }),
    backendId: backendStore.currentId,
  }),
  onApply: (text, caret) => {
    prompt.value = text
    // 等 textarea 拿到新文本再挪光标——DOM 还是旧值时 setSelectionRange 会被
    // 随后的值更新重置到末尾。
    void nextTick(() => mentionInput.value?.setCaret(caret))
  },
  onCommand: (command) => emit('command', command),
})

function onCaret(caret: number): void {
  refreshSuggestions(prompt.value, caret)
}

/*
 * Composer Autocomplete: 斜杠命令表预取。
 *
 * 首次取要冷启一次 SDK 握手（实测 2.1–2.6 秒），等用户敲下 `/` 再拉的话弹层会先
 * 空着两秒。所以在后端/工作区确定的那一刻就后台拉，用户打字时命令表已经是热的。
 *
 * immediate + watch 而不是 onMounted：Composer 挂载时工作区可能还没加载完，
 * 而切工作区、切会话（会话的后端不可变，打开会话时 backendStore 会切过去）
 * 都要重新取——项目级 Skill 来自 <cwd>/.claude/skills/，换目录内容就变。
 */
watch(
  () => [backendStore.currentId, workspaceStore.currentWorkspace?.path] as const,
  ([backendId, cwd]) => {
    if (!cwd) return
    void slashCommandStore.prefetch(backendId, cwd)
  },
  { immediate: true },
)

/*
 * Composer Hints: 占位符定时轮换，见 lib/composer-hints.ts。
 *
 * 只在输入框为空时走——有文字时占位符本来就看不见，转它纯属白转，
 * 而且用户回到空输入框时看到的会是一条刚换过的，像没轮换。
 */
const hints = ref<string[]>([])
const hintIndex = ref(0)
const hint = computed(() => hints.value[hintIndex.value % hints.value.length] ?? '发送消息…')

let hintTimer: ReturnType<typeof setInterval> | null = null
const HINT_ROTATE_MS = 9000

// 设置里的「回车发送」决定 Shift+Enter 那条成不成立，改了要重新组装提示池。
watch(
  () => settingsStore.settings?.sendOnEnter ?? true,
  (sendOnEnter) => {
    hints.value = shuffledHints(sendOnEnter)
    hintIndex.value = 0
  },
  { immediate: true },
)

onMounted(() => {
  hintTimer = setInterval(() => {
    if (prompt.value.length > 0) return
    hintIndex.value = (hintIndex.value + 1) % hints.value.length
  }, HINT_ROTATE_MS)
})

onUnmounted(() => {
  if (hintTimer) clearInterval(hintTimer)
})

/**
 * File Mention: 「+」按钮——选文件加进对话。
 *
 * 走的是跟拖放同一个落地路径（mentionPathFor + addFileMention），所以同一个文件
 * 不管从哪个入口进来，写进输入框的都是同一条引用，不会出现两个看着不同的 pill。
 *
 * 对话框只开 openFile：macOS 允许一个对话框同时选文件和目录，Windows 不允许，
 * 混着写会在 Windows 上静默退化。目录仍可以拖进来或在文件树上右键添加。
 */
async function onPickFiles(): Promise<void> {
  const result = await window.api.system.openDialog({
    title: '选择要加入对话的文件',
    properties: ['openFile', 'multiSelections'],
  })
  if (result.canceled) return
  const workspaceId = workspaceStore.currentWorkspace?.id
  for (const absolutePath of result.filePaths) {
    chatInput.addFileMention(await mentionPathFor(workspaceId, absolutePath))
  }
}

const refreshing = ref(false)
async function onRefreshModels(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await backendStore.refreshModels()
  } finally {
    refreshing.value = false
  }
}

const canSend = computed(
  () =>
    (prompt.value.trim().length > 0 || chatInput.pendingAttachments.length > 0) && !props.disabled,
)

const supportedEfforts = computed<EffortLevel[]>(() => {
  return backendStore.current?.capabilities.supportedEfforts ?? ['low', 'medium', 'high']
})

const supportedPermissionModes = computed<PermissionMode[]>(() => {
  return (
    backendStore.current?.capabilities.supportedPermissionModes ?? [
      'default',
      'acceptEdits',
      'auto',
      'plan',
      'dontAsk',
      'bypassPermissions',
    ]
  )
})

function permissionLabel(m: PermissionMode): string {
  return {
    default: '每次问',
    acceptEdits: '自动接受编辑',
    auto: '自动',
    plan: '计划模式',
    dontAsk: '不问',
    bypassPermissions: '完全跳过权限',
  }[m]
}

function onKeyDown(e: KeyboardEvent): void {
  // 联想弹层开着时它先吃键(↑↓ 选择、Enter/Tab 确认、Esc 关闭)。返回 true =
  // 已消费，下面的发送逻辑必须让开——否则选候选会变成发消息。
  if (handleSuggestKeydown(e)) return

  const sendOnEnter = settingsStore.settings?.sendOnEnter ?? true
  if (e.key === 'Enter') {
    if (e.shiftKey) {
      // 让默认换行行为发生
      return
    }
    if (sendOnEnter) {
      e.preventDefault()
      onSend()
    }
  }
}

function onSend(): void {
  if (!canSend.value) return
  const text = prompt.value.trim()
  /*
   * File Mention: 文本里的 `@路径` 原样留在 prompt 里，另外再附一份结构化的
   * ide_opened_file。两者都要——`@路径` 保住引用在句子里的位置（"照着 @a.ts
   * 改 @b.ts" 换成一串标签就读不出谁是谁了），而标签让后端拿到明确的文件清单，
   * 也让消息气泡能渲染出可点击的文件 pill（复用已有的 FilePill）。
   */
  const mentionBlocks = chatInput.fileMentions.map<ContextBlock>((m) => ({
    tag: 'ide_opened_file',
    data: { filePath: m.path },
  }))
  const attachments = [...chatInput.drain(), ...mentionBlocks]
  prompt.value = ''
  closeSuggestions()
  emit('send', text, attachments)
}

/**
 * 粘贴处理：剪贴板是"看起来像代码"的多行文本时，自动作为 ide_selection 附件，
 * 不进 textarea。启发式判断（保守）：至少 2 行 + 含明显代码符号。
 * 加 attachments 时若有重复内容直接跳过。
 */
function onPaste(e: ClipboardEvent): void {
  const text = e.clipboardData?.getData('text/plain')
  if (!text) return

  const lineCount = text.split('\n').length
  if (lineCount < 2) return

  // 多行 + 含代码符号才认作代码片段
  const codeIndicators = /[{};=>]|function |class |def |import |const |let |var |public |private /
  if (!codeIndicators.test(text)) return

  // 已有相同附件，避免重复
  const dup = chatInput.pendingAttachments.some(
    (a: ContextBlock) => a.tag === 'ide_selection' && (a.data as { code: string }).code === text,
  )
  if (dup) {
    e.preventDefault()
    return
  }

  e.preventDefault()
  chatInput.addAttachment({
    tag: 'ide_selection',
    data: {
      // 粘贴的代码没有原始文件路径，用占位
      filePath: '(pasted snippet)',
      startLine: 1,
      endLine: lineCount,
      code: text,
    },
  })
}

async function onInterrupt(): Promise<void> {
  if (messageStore.currentTurnId) {
    await window.api.backend.interruptTurn({ turnId: messageStore.currentTurnId })
  }
}

function onModelSelect(value: string | null): void {
  emit('update:modelValue', { ...props.modelValue, model: value })
}

function onEffortSelect(value: EffortLevel): void {
  emit('update:modelValue', { ...props.modelValue, effort: value })
}

function onPermissionModeSelect(value: PermissionMode): void {
  emit('update:modelValue', { ...props.modelValue, permissionMode: value })
}
</script>

<style scoped>
/*
 * 底部配置行样式统一——所有 trigger 按钮(Model/Effort/权限盾牌)和发送按钮:
 *   1. 高度统一 h-7(28px),垂直对齐
 *   2. 背景透明(融入 Composer 的 bg-sidebar),hover 时才有 bg-accent 反馈
 *      之前用 bg-secondary(更深)会在 Composer 上形成色块,不协调
 *
 * 通过 :deep() 穿透到 DropdownMenu/ThinkingSlider/PermissionShieldButton 的内部 button,
 * 只影响 Composer 内的实例(这些组件本体不改,避免影响其他使用方)。
 */
/*
 * 注意::deep(button) 会匹配 trigger button + 弹层内的所有 button(选项/圆点),
 * 会误伤弹层。所以只匹配 trigger button:
 *   - Model/权限:弹层 button 在 :deep 里也会被匹配,但它们不受 height/padding 影响
 *     (弹层 button 有自己的 w-full + py-2)。这里只调 trigger 的视觉。
 *   - Effort:必须用精确的 .effort-trigger-btn,否则弹层圆点 span 被隐藏。
 * 用 > button(直接子 button)缩小范围——弹层在 trigger button 之后,不是直接子。
 */
.composer-model-trigger > :deep(button),
.composer-effort-trigger > :deep(button.effort-trigger-btn),
.composer-perm > :deep(button.perm-trigger-btn) {
  height: 1.75rem; /* h-7 = 28px,与发送按钮一致 */
  padding-top: 0;
  padding-bottom: 0;
  background-color: transparent;
  border-radius: 0.375rem;
}
.composer-model-trigger > :deep(button:hover),
.composer-effort-trigger > :deep(button.effort-trigger-btn:hover),
.composer-perm > :deep(button.perm-trigger-btn:hover) {
  background-color: var(--color-accent);
  color: var(--color-accent-foreground);
}

/* 刷新按钮和加号按钮也统一高度 + 透明背景 */
.composer-refresh,
.composer-add {
  height: 1.75rem;
  width: 1.75rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.375rem;
}

/*
 * 底部配置行响应式收窄——基于 CSS 容器查询(@container),而非 media query。
 * 容器是 template 里带 @container class 的圆角输入框(Tailwind v4 的 @container
 * 会自动设 container-type: inline-size),它会被右侧面板挤压变窄。
 *
 * 为什么不用 media query:右侧面板挤压时,中间列实际宽度 < 视口宽度,
 * media query 看的是视口,无法感知实际可用宽度。容器查询直接量自身容器。
 *
 * 折叠策略(按容器实际宽度,从宽到窄逐级折叠):
 *   - ≥512px (32rem):全部正常显示
 *   - 紧凑:Model/Effort trigger 收窄
 *   - 极窄:刷新按钮隐藏
 *   权限盾牌 + Model + Effort + 发送按钮 永不隐藏
 */

/* ---- 刷新按钮:< 28rem 隐藏(优先级低于 Model/Effort/权限) ---- */
.composer-refresh {
  @container (width < 28rem) {
    display: none;
  }
}

/*
 * Model trigger:< 32rem 收窄,去掉下拉箭头(chevron),只保留模型名文字。
 * 用 > button(直接子)避免匹配弹层内的选项 button。
 * chevron 是 button 内最后一个 svg(svg:last-child),隐藏后 label span 可占满 trigger。
 */
.composer-model-trigger > :deep(button) {
  @container (width < 32rem) {
    max-width: 80px;
  }
}
.composer-model-trigger > :deep(button > span) {
  @container (width < 32rem) {
    max-width: 64px;
  }
}
.composer-model-trigger > :deep(button > svg:last-child) {
  @container (width < 32rem) {
    display: none;
  }
}

/*
 * Effort (ThinkingSlider) trigger:< 30rem 隐藏档位文字 + chevron,只留脑图标。
 * 必须用 .effort-trigger-btn 精确匹配——否则 :deep(button > span) 会匹配到
 * 弹层里圆点 button 内的 span(圆点本身),把圆点 display:none 掉。
 */
.composer-effort-trigger :deep(button.effort-trigger-btn > span) {
  @container (width < 30rem) {
    display: none;
  }
}
.composer-effort-trigger :deep(button.effort-trigger-btn > svg:last-child) {
  @container (width < 30rem) {
    display: none;
  }
}

/*
 * Permission Mode trigger:< 30rem 隐藏模式文字,只留盾牌图标。
 * 必须用 .perm-label 精确匹配——否则 :deep(button > span) 会匹配到弹层里
 * 选项 button 内的 span(选项文字/对勾占位),把它们也隐藏掉。
 * 与 Effort 同档(30rem)收窄,保持两个 trigger 在窄屏下视觉一致。
 */
.composer-perm :deep(button.perm-trigger-btn > .perm-label) {
  @container (width < 30rem) {
    display: none;
  }
}
</style>
