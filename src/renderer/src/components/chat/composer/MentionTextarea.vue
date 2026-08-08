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
    <!--
      必须是 overflow-auto，不能用 overflow-hidden：Chromium 对 hidden overflow 元素
      连续执行 scrollTop 同步后，原生鼠标滚轮会漏绘新露出的尾部行。pointer-events-none
      保证滚轮仍由 textarea 接收；滚动条在下方共享样式里隐藏。
    -->
    <div ref="highlightRef" class="mirror absolute inset-0 overflow-auto pointer-events-none">
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
      class="mirror relative w-full bg-transparent resize-none focus:outline-none placeholder:text-muted-foreground/45 disabled:opacity-50"
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
 *   - 测量用的 'auto' 会让 textarea 视口瞬间变矮（rows=1），光标若跌出视口浏览器会
 *     自动滚动让光标可见、改写 scrollTop——改完高度必须立即调 syncScroll() 把底层
 *     高亮层的 scrollTop 同步过来，否则两层垂直错位（上层光标跟着滚走了、底层文字
 *     没动，看起来就是"光标靠上一点"），内容越多越明显。
 */
const MIN_HEIGHT_PX = 44 // 一行 + py-3 的最小高度，避免空输入时压得太扁
const MAX_HEIGHT_PX = 192 // 12rem，约 8~9 行——超过后转内部滚动
function autoResize(): void {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  const contentHeight = el.scrollHeight
  const next = Math.min(Math.max(contentHeight, MIN_HEIGHT_PX), MAX_HEIGHT_PX)
  el.style.height = `${next}px`
  // 封顶后让 textarea 内部出滚动条；未封顶时恢复隐藏（删行回缩场景）。
  el.style.overflowY = contentHeight > MAX_HEIGHT_PX ? 'auto' : 'hidden'
  // Mirror Sync: 改高度会扰动 scrollTop，必须立即同步底层高亮层，否则两层错位。
  syncScroll()
  // 内容封顶滚动后，重算高度（auto→固定值）会抑制浏览器原生的"光标滚入视图"机制：
  // 输入新行时光标跌出可视区下方，但 textarea 不会自动下滚，于是光标所在的新行
  // （透明文字）留在可视区外，高亮层也跟着停在旧 scrollTop——用户看到的就是上半
  // 部分内容正常、下半部分一片空白（融入背景）。这里手动补上：光标不在可视区就滚
  // 到让它可见，再同步给高亮层。scrollTop 赋值本身不会触发 scroll 事件，所以仍要
  // 显式调 syncScroll。
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 21.7
  const padTop = parseFloat(getComputedStyle(el).paddingTop) || 0
  const cursorLine = el.value.slice(0, el.selectionStart).split('\n').length - 1
  const cursorY = padTop + cursorLine * lineHeight
  const viewTop = el.scrollTop
  const viewBottom = el.scrollTop + el.clientHeight
  if (cursorY >= viewBottom - lineHeight) {
    el.scrollTop = cursorY - el.clientHeight + lineHeight * 2
  } else if (cursorY < viewTop) {
    el.scrollTop = Math.max(0, cursorY - padTop)
  }
  syncScroll()
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
// 这时既要把底层高亮层的 scrollTop 对齐，也要重算 textarea 高度。
// 合并成一个 watch 而非两个：autoResize 内部已调 syncScroll，且必须保证它最后跑
// （它改高度会扰动 scrollTop），拆成两个会因注册顺序产生竞态。
watch(
  () => props.modelValue,
  () => {
    autoResize()
    syncScroll()
  },
  { flush: 'post' },
)

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
  /*
   * 两层都隐藏滚动条。textarea 的经典滚动条会占内容宽度，导致两层换行错位；
   * 高亮层现在是 overflow-auto 的真实滚动容器，也不能露出第二根滚动条。
   * 滚轮和键盘滚动仍由 textarea 正常接收。
   */
  scrollbar-width: none;
}

.mirror::-webkit-scrollbar {
  width: 0;
  height: 0;
}

/*
 * textarea 只留光标，文字交给底下那层画。
 *
 * 选中态的底色不能跟文字同色系——文字色继承自 --foreground（纯灰阶），选中底色若也
 * 取自 --primary（同样是灰阶）的半透明，混出来必然和某档灰阶文字低对比，亮色模式
 * 下白底深字尤其明显，选中后像被抹掉。所以选中底色用一个带明确色相的中性蓝：它在
 * 亮/暗两种模式下、对黑/白两种文字都有足够反差，也是用户对"选中"的视觉预期。
 * 这里没有复用 --color-info（它是侧边栏"未读活动"指示点的专用语义，见 themes.css
 * 注释），选中态另立一个 token，避免语义混用。
 */
textarea.mirror {
  color: transparent;
  caret-color: var(--color-foreground);
  /*
   * Mirror Sync: 必须显式设 display:block。
   *
   * textarea 在默认 UA 样式下是 inline（replaced）元素，自带 vertical-align:baseline，
   * 行盒下方会留出 descender 空隙（约 3px）——这会让它撑开的外层 .relative 容器比
   * textarea 自己的可视高度高出几像素。而底层高亮层是 absolute inset-0，钉死成
   * 外层容器的高度，于是高亮层 clientHeight > textarea clientHeight，两层最大可滚动
   * 距离（scrollHeight - clientHeight）不一致。内容封顶滚动后 syncScroll 把两层的
   * scrollTop 设成相同值，但因为 maxScroll 不同，高亮层实际显示的文字行和 textarea
   * 光标行逐行累积错位，底部那几行只剩 textarea 的透明文字、没有底色文字 → 看不见。
   *
   * display:block 去掉行盒，两层 clientHeight 严格相等，maxScroll 一致，scrollTop
   * 才能逐像素对齐。这是这个两层镜像结构能正常滚动的前提，删不得。
   */
  display: block;
}

textarea.mirror::selection {
  background-color: color-mix(in oklch, oklch(60% 0.18 255) 55%, transparent);
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
