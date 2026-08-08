/**
 * Composer Hints: 输入框占位符的提示池，定时轮换。
 *
 * 原来写死一句「Shift+Enter 换行」，那条信息看两次就没用了，之后一直占着屏幕上
 * 最显眼的一块空白。轮换是为了让这块空间持续有用——所以每一条都必须是这个应用
 * 真实存在的能力，凑数的漂亮话比写死那句还糟。
 *
 * 每条都对照过代码：
 * - 拖放 / 右键添加：useChatFileDrop、FileTree 的右键菜单
 * - `@路径`：file-mention.ts（拖放和右键写进去的就是它，手打会触发联想，见 lib/autocomplete）
 * - 「粘贴代码成片段」已随 Composer.onPaste 一并停用（见 Composer.vue），提示条目暂注释掉，避免宣传已不存在的能力
 * - `/compact`：ChatView.onSend 里对 `/compact` 的特判
 * - Shift+Enter：仅在 sendOnEnter 打开时成立，所以由调用方按设置过滤（见 ENTER_HINT）
 */

/**
 * 只在「回车发送」打开时才成立的一条。设置里关掉后 Enter 就是换行，
 * 这句会变成假话，所以单独拎出来由调用方决定加不加。
 */
export const ENTER_HINT = 'Shift+Enter 换行，Enter 发送'

/** 任何设置下都成立的提示。 */
export const COMPOSER_HINTS = [
  '把文件拖进来，自动变成 @路径 引用',
  '拖一个文件夹进来，让我看看整个目录',
  '在文件树上右键，可以直接添加到对话',
  '输入 @ 就能搜工作区里的文件，↑↓ 选，回车确认',
  // 「粘贴代码自动收成片段附件」提示已停用——对应功能 Composer.onPaste 当前被注释掉，不再宣传该能力
  // '粘贴一段多行代码，会自动收成一个片段附件',
  '输入 /compact 可以压缩当前上下文',
  '描述你想做什么，不用先想好怎么做',
] as const

/**
 * 按当前设置组装可用的提示，并从一个随机位置开始排列。
 *
 * 随机起点而不是每次随机取一条：随机取会重复（连着两次抽到同一条看起来像卡住了），
 * 从随机位置开始顺序轮换则既保证每次打开应用看到的第一条不同，又保证轮一圈内
 * 不重样。
 */
export function shuffledHints(sendOnEnter: boolean): string[] {
  const pool = sendOnEnter ? [ENTER_HINT, ...COMPOSER_HINTS] : [...COMPOSER_HINTS]
  const offset = Math.floor(Math.random() * pool.length)
  return [...pool.slice(offset), ...pool.slice(0, offset)]
}
