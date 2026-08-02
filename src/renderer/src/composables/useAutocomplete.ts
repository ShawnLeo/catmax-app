/**
 * Composer Autocomplete: 联想的状态机。
 *
 * 把「什么时候查、查完谁说了算、按键归谁管、选中后文本怎么变」集中在一处，
 * 弹层组件因此可以是纯受控的，provider 因此可以是纯异步函数。
 *
 * 三件必须做对、做错了都很隐蔽的事：
 *   1. 请求竞态——每敲一个字发一次搜索，慢的旧请求晚回来会盖掉新结果，表现为
 *      「输入框里是 abc，列表却是 ab 的结果」。用递增 token 挡住。
 *   2. 键盘归属——弹层开着时 Enter 是「确认候选」，关着时是「发送消息」。所以
 *      handleKeydown 返回布尔值，由 Composer 按「已消费就别再处理」接线，而不是
 *      在两处各写一遍条件。
 *   3. 输入法组合态——中文候选词面板也用 ↑↓ 和 Enter。组合期间一律不抢键，
 *      否则选中文候选词会变成选文件。
 */
import type {
  DetectedTrigger,
  SuggestionContext,
  SuggestionItem,
  SuggestionRegistry,
} from '@renderer/lib/autocomplete'
import { onScopeDispose, type Ref, ref } from 'vue'

/**
 * 搜索防抖。
 *
 * 文件搜索是一次有上限的磁盘遍历，逐字符发等于连打时一直在遍历工作区。
 * 120ms 大约是连续输入的间隔下沿——停顿一下就出结果，一直打字就不打扰。
 */
const SEARCH_DEBOUNCE_MS = 120

export interface UseAutocompleteOptions {
  registry: SuggestionRegistry
  /** 每次搜索前重新取一遍外部状态（工作区可能被切换） */
  context: () => SuggestionContext
  /** 应用候选：把新文本写回输入框，并把光标放到 caret 处 */
  onApply: (text: string, caret: number) => void
}

export interface AutocompleteApi {
  open: Ref<boolean>
  items: Ref<SuggestionItem[]>
  activeIndex: Ref<number>
  loading: Ref<boolean>
  emptyText: Ref<string>
  /** 文本或光标变化时调用——它自己判断该开该关 */
  refresh: (text: string, caret: number) => void
  /** 返回 true 表示这个按键已被联想消费，调用方不要再处理 */
  handleKeydown: (event: KeyboardEvent) => boolean
  applyAt: (index: number) => void
  setActive: (index: number) => void
  close: () => void
}

export function useAutocomplete(options: UseAutocompleteOptions): AutocompleteApi {
  const { registry, context, onApply } = options

  const open = ref(false)
  const items = ref<SuggestionItem[]>([])
  const activeIndex = ref(0)
  const loading = ref(false)
  const emptyText = ref('没有匹配项')

  /** 当前触发段 + 它所属的那份文本快照——applyAt 要拿它算替换。 */
  let current: (DetectedTrigger & { text: string }) | null = null
  /** 上一次真正发出搜索的触发段标识，用来跳过「光标动了但查询词没变」的重查。 */
  let lastKey = ''
  /**
   * 被 Esc 明确关掉的那个触发段。
   *
   * 少了它 Esc 是关不掉弹层的：Esc 的 keyup 紧接着会让输入框再报一次光标位置，
   * 而光标仍停在同一个 `@…` 里，refresh 会立刻把弹层又打开。记住这一段、直到
   * 用户改动文本（触发段标识随之改变）为止。
   */
  let dismissedKey = ''
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 请求令牌：只有等于当前值的响应才允许写进 items。 */
  let token = 0

  function close(): void {
    open.value = false
    items.value = []
    activeIndex.value = 0
    loading.value = false
    current = null
    lastKey = ''
    // 令牌前进一格，在途的请求回来时会发现自己过期了，不会把列表又填回来。
    token += 1
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  /** 触发段的身份——provider + 起点 + 查询词，三者都没变就是同一段。 */
  function triggerKey(detected: DetectedTrigger): string {
    return [detected.provider.id, detected.match.start, detected.match.query].join(' ')
  }

  function refresh(text: string, caret: number): void {
    const detected = registry.detect(text, caret, context())
    if (!detected) {
      if (open.value) close()
      return
    }

    const key = triggerKey(detected)
    if (key === dismissedKey) {
      if (open.value) close()
      return
    }

    current = { ...detected, text }
    open.value = true
    emptyText.value = detected.provider.emptyText ?? '没有匹配项'

    // 触发段没变（光标在同一个 token 内挪动、或外部重新同步了一次）就不重查——
    // 重查会让列表闪一下 loading，且白发一次 IPC。
    if (key === lastKey) return
    lastKey = key

    if (timer) clearTimeout(timer)
    loading.value = true
    const myToken = ++token
    timer = setTimeout(() => {
      void run(detected, myToken)
    }, SEARCH_DEBOUNCE_MS)
  }

  async function run(detected: DetectedTrigger, myToken: number): Promise<void> {
    let result: SuggestionItem[] = []
    try {
      result = await detected.provider.search(detected.match, context())
    } catch (error) {
      // provider 不必自己防御瞬时错误（工作区被删、后端没起来），这里兜住。
      console.warn('[autocomplete] provider 搜索失败:', detected.provider.id, error)
    }
    if (myToken !== token) return
    loading.value = false
    items.value = result
    activeIndex.value = 0
  }

  function setActive(index: number): void {
    if (index < 0 || index >= items.value.length) return
    activeIndex.value = index
  }

  function move(delta: number): void {
    const total = items.value.length
    if (total === 0) return
    // 循环而不是撞墙：候选很少时来回按方向键比翻页更常见。
    activeIndex.value = (activeIndex.value + delta + total) % total
  }

  function applyAt(index: number): void {
    const item = items.value[index]
    if (!item || !current) return
    const { text, match } = current
    const next = text.slice(0, match.start) + item.insert + text.slice(match.end)
    const caret = match.start + item.insert.length

    if (item.keepOpen) {
      // 目录：写回后立刻按新文本重新联想，用户就能接着往下钻。
      // lastKey 清掉，否则新旧触发段起点相同、query 又是「旧 query + 一段」时
      // 有极小概率撞上去重判定。
      lastKey = ''
      onApply(next, caret)
      refresh(next, caret)
      return
    }

    close()
    /*
     * 刚插完的这一段不许自己弹回来。
     *
     * 文件候选靠尾随空格自然收尾（`@a.ts ` 之后光标前面是空白，检测不到触发段），
     * 但不带参数的斜杠命令没有尾随空格——插完 `/context` 光标仍落在同一个触发段
     * 里，紧随其后的光标事件会把弹层又打开，显示的还是刚选完的那一条。
     * 跟 Esc 用同一个 dismissedKey 机制：记住这一段，直到用户改动文本为止。
     */
    const after = registry.detect(next, caret, context())
    if (after) dismissedKey = triggerKey(after)
    onApply(next, caret)
  }

  function handleKeydown(event: KeyboardEvent): boolean {
    if (!open.value) return false
    // 输入法组合中：↑↓ / Enter 属于候选词面板，抢了就选不了中文。
    if (event.isComposing) return false

    switch (event.key) {
      case 'ArrowDown':
        move(1)
        break
      case 'ArrowUp':
        move(-1)
        break
      case 'Enter':
        // Shift+Enter 永远是换行，不参与联想。
        if (event.shiftKey) return false
        // 列表空着（还在搜 / 真没结果）时不拦 Enter——否则消息发不出去，
        // 而用户完全看不出是被什么挡住的。
        if (items.value.length === 0) return false
        applyAt(activeIndex.value)
        break
      case 'Tab':
        if (items.value.length === 0) return false
        applyAt(activeIndex.value)
        break
      case 'Escape':
        // 记下这一段已被明确关掉，否则紧随其后的光标事件会把弹层又打开。
        if (current) dismissedKey = triggerKey(current)
        close()
        break
      default:
        return false
    }
    event.preventDefault()
    return true
  }

  onScopeDispose(() => {
    if (timer) clearTimeout(timer)
  })

  return {
    open,
    items,
    activeIndex,
    loading,
    emptyText,
    refresh,
    handleKeydown,
    applyAt,
    setActive,
    close,
  }
}
