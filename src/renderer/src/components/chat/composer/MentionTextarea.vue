<template>
  <!--
    File Mention: 带 `@路径` 高亮的输入框。

    为什么是「一层 div 垫在 textarea 底下」而不是富文本编辑器：
    textarea 是纯文本控件，没有任何办法只给其中一段文字上色；换成 contenteditable
    能做到，代价是中文输入法的组合态、光标位置、撤销栈、粘贴全部要自己重写——
    这个应用的主力用户就是中文输入，不值得拿 IME 去换一个高亮。

    所以真正接收输入的仍是原生 textarea（IME 完全不受影响），只是把它的文字设成
    透明、只留光标；底下垫一层字体度量完全一致的 div 渲染同一份文本，并把其中的
    `@路径` 包成带色的 span。两层必须逐像素对齐，靠的是共用 .mirror 这一套排版
    声明——改其中任何一条都要同时作用于两层，所以它们写在同一个选择器里，
    不要拆开。
  -->
  <div class="relative">
    <div ref="highlightRef" class="mirror absolute inset-0 overflow-hidden pointer-events-none">
      <!--
        末尾补一个换行：文本以 \n 结尾时 div 不会撑出最后一个空行，而 textarea 会，
        两层的滚动高度就此错开一行。
      -->
      <span v-for="(seg, i) in segments" :key="i" :class="seg.mention ? 'mention' : ''">{{
        seg.text
      }}</span
      >{{ '\n' }}
    </div>

    <textarea
      ref="textareaRef"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :rows="rows"
      class="mirror relative w-full bg-transparent resize-none focus:outline-none placeholder:text-muted-foreground/60 disabled:opacity-50"
      @input="onInput"
      @scroll="syncScroll"
      @keydown="emit('keydown', $event)"
      @paste="emit('paste', $event)"
      @keyup="emitCaret"
      @click="emitCaret"
      @focus="emitCaret"
      @blur="emit('blur')"
      @compositionstart="composing = true"
      @compositionend="onCompositionEnd"
    />
  </div>
</template>

<script setup lang="ts">
import { segmentFileMentions } from '@renderer/lib/file-mention'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string | undefined
    // Composer 自己的 disabled 就是可选的，透传下来必须容得下 undefined
    // （tsconfig 开了 exactOptionalPropertyTypes，省掉 `| undefined` 通不过）。
    disabled?: boolean | undefined
    rows?: number | undefined
  }>(),
  { placeholder: '', disabled: false, rows: 1 },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
  keydown: [event: KeyboardEvent]
  paste: [event: ClipboardEvent]
  blur: []
  /**
   * Composer Autocomplete: 光标位置变了。
   *
   * 联想要判断「光标是不是落在某个 `@…` 里」，光有文本不够——同一份文本，光标
   * 在 token 里和在句尾是两种状态。textarea 没有现成的「光标变了」事件，只能从
   * 输入 / 按键抬起 / 点击 / 聚焦四处推。
   */
  caret: [position: number]
}>()

const textareaRef = ref<HTMLTextAreaElement | null>(null)
const highlightRef = ref<HTMLElement | null>(null)

/*
 * Auto-resize: 输入框默认矮一点，内容超出时长高，但封顶到 maxHeightPx 再改内部滚动。
 *
 * 默认高度（单行/空输入）对应 rows=1 + padding；超过后随 scrollHeight 增长，
 * 到 MAX_HEIGHT_PX (12rem ≈ 192px) 为止——这之后 textarea 自己出滚动条。
 * 实现细节：
 *   - 改的是 textarea.style.height，底层高亮层是 absolute inset-0，会自动跟着
 *     外层 <div>（由 textarea 撑高）一起变高，无需单独同步高度。
 *   - 测量前先把 height 置成 'auto'，否则 scrollHeight 会停在当前已设的固定高度上，
 *     多删几行也不会缩回去。
 *   - 用 scrollHeight（包含 padding，不包含边框/外边距）作为目标高度，配合 box-sizing
 *     默认的 border-box 刚好能盖住 padding。
 */
const MIN_HEIGHT_PX = 44 // 一行 + py-3 的最小高度，避免空输入时压得太扁
const MAX_HEIGHT_PX = 192 // 12rem，约 8~9 行——超过后转内部滚动
function autoResize(): void {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  const next = Math.min(Math.max(el.scrollHeight, MIN_HEIGHT_PX), MAX_HEIGHT_PX)
  el.style.height = `${next}px`
  // 封顶后让 textarea 内部出滚动条；未封顶时恢复隐藏（删行回缩场景）。
  el.style.overflowY = el.scrollHeight > MAX_HEIGHT_PX ? 'auto' : 'hidden'
}

/**
 * 输入法组合中。组合期间不报光标——那时候文本里躺着的是未确认的拼音，
 * 拿它去搜文件既搜不到，还会让弹层在每个拼音字母上闪一次。
 */
const composing = ref(false)

const segments = computed(() => segmentFileMentions(props.modelValue))

function onInput(e: Event): void {
  const el = e.target as HTMLTextAreaElement
  // 顺序不能反：update 的接收方是 computed setter，同步就把新文本写进了 store，
  // 之后发的 caret 才和它配得上。反过来会让联想拿旧文本 + 新光标去算触发段。
  emit('update:modelValue', el.value)
  if (!composing.value) emit('caret', el.selectionStart)
  // Auto-resize: 输入即重算高度
  autoResize()
}

function emitCaret(): void {
  const el = textareaRef.value
  if (!el || composing.value) return
  emit('caret', el.selectionStart)
}

function onCompositionEnd(): void {
  composing.value = false
  // 组合结束后 Chromium 还会补一次 input，这里主动报一次是为了万一没补上。
  emitCaret()
}

/** 文本超过可视高度后 textarea 会滚动，垫在底下的那层必须跟着滚，否则立刻错位。 */
function syncScroll(): void {
  if (highlightRef.value && textareaRef.value) {
    highlightRef.value.scrollTop = textareaRef.value.scrollTop
    highlightRef.value.scrollLeft = textareaRef.value.scrollLeft
  }
}

// 外部改写文本（拖放 / 右键加引用）不经过 scroll 事件，但会改变内容高度——
// 这时同样要对齐一次，否则 textarea 自动滚到底而高亮层还停在原处。
watch(() => props.modelValue, syncScroll, { flush: 'post' })
// Auto-resize: 外部改写文本（拖放 / 右键加引用 / 候选应用）也要重算高度
watch(() => props.modelValue, autoResize, { flush: 'post' })

onMounted(() => {
  autoResize()
  window.addEventListener('resize', autoResize)
})
onUnmounted(() => {
  window.removeEventListener('resize', autoResize)
})

defineExpose({
  focus: () => textareaRef.value?.focus(),
  el: textareaRef,
  /**
   * 把光标放到指定位置——联想应用候选之后必须调，否则光标会停在文本末尾，
   * 而插入点可能在句子中间。
   */
  setCaret: (position: number) => {
    const el = textareaRef.value
    if (!el) return
    el.focus()
    el.setSelectionRange(position, position)
    emit('caret', position)
  },
})
</script>

<style scoped>
@reference "../../../assets/styles/main.css";

/*
 * 两层共用的排版声明——任何一条不一致，光标和高亮就会随着行数累积漂移。
 *
 * line-height 必须写死。默认的 `normal` 由字体度量决定，两层虽然指定了同一个
 * font-family，但 textarea 和 div 在字体回退链上的表现不保证一致，写死是唯一
 * 能担保的做法。
 */
.mirror {
  @apply font-chat text-[length:var(--chat-text-u2)] px-4 py-3;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: break-word;
  tab-size: 4;
  border: 0;
}

/*
 * textarea 只留光标，文字交给底下那层画。
 *
 * 选中态的底色必须是半透明的：::selection 画在 textarea 这一层，也就是高亮层
 * 之上，用不透明底色会把选中范围内的文字整段盖掉，看起来像被抹掉了。
 */
textarea.mirror {
  color: transparent;
  caret-color: var(--color-foreground);
  /*
   * 藏掉滚动条——不是为了好看，是为了对齐。经典滚动条（Windows）会从 textarea 的
   * 内容宽度里切走十几个像素，而底下的高亮层是 overflow:hidden、不会跟着缩，
   * 文本一旦超过三行两层就横向错位。macOS 的浮层滚动条不占宽度，所以这个问题
   * 只在 Windows 上出现，也正因如此很容易漏测。滚轮和键盘滚动不受影响。
   */
  scrollbar-width: none;
}

textarea.mirror::-webkit-scrollbar {
  width: 0;
  height: 0;
}

textarea.mirror::selection {
  background-color: color-mix(in oklch, var(--color-primary) 28%, transparent);
}

.mirror .mention {
  color: var(--color-primary);
  background-color: color-mix(in oklch, var(--color-primary) 12%, transparent);
  border-radius: 0.25rem;
  /*
   * 只加左右内边距，不加上下——上下 padding 会撑高行盒，把这一行的文字顶得跟
   * textarea 里对应的行错开。负 margin 抵消左右的宽度增量，保证后续字符的
   * 水平位置不变。
   */
  padding-left: 0.125rem;
  padding-right: 0.125rem;
  margin-left: -0.125rem;
  margin-right: -0.125rem;
}
</style>
