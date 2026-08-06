/**
 * File Reference DOM Decoration:
 * 把渲染完的 markdown DOM 里"看起来是文件"的部分标记成可点击预览
 * （加 `data-file-reference`，由 MarkdownView 的 click 委托打开文件面板）。
 *
 * 三类来源，判定都收敛到 `looksLikeFileReference` 同一份白名单：
 *   1. inline code —— `` `src/foo.ts` ``，最明确的写法
 *   2. 非外链锚点 —— `[规范](CLAUDE.md)`，href 就是路径
 *   3. 正文纯文本 —— "根目录的 CLAUDE.md 写了规范"，AI 回复里最常见的形态
 *
 * 第 3 类是这里唯一有风险的：它要在自由文本里"猜"哪一段是文件名。两道防线——
 * 候选切分只认 ASCII 路径字符（中文标点、空格、`=`、`(` 天然成为边界），
 * 切出来的候选再过一遍 `looksLikeFileReference`，宁可漏判不可错标。
 *
 * 之前这段逻辑在 base/ 和 codex/ 两个 MarkdownView.vue 里各抄了一份；
 * 判定规则必须两边一致（否则同一句话在不同后端下可点性不同），故提到这里共享。
 */
import { looksLikeFileReference } from './file-reference'

/**
 * 纯文本扫描要跳过的容器：
 * - `a` / `code` / `pre` / `kbd` —— 已由前两类处理，或本就是代码原文
 * - `[data-file-reference]` —— 已标记过。装饰可能在同一份 DOM 上跑第二次
 *   （文本没变但组件重新装饰），没有这条会把 span 里的文本再包一层。
 */
const SKIP_SELECTOR = 'a, code, pre, kbd, script, style, [data-file-reference]'

/**
 * 候选 token 的字符集——只收 ASCII 路径可能出现的字符。
 *
 * 这是中文场景下能否正确切词的关键：中文没有空格分词，"根目录的CLAUDE.md文件"
 * 必须靠"中文字符不在这个集合里"来定位出 `CLAUDE.md`。同理 `=`、`(`、`,`、
 * 全角标点都不在集合里，天然成为边界，`FOO=bar.ts` 这类会被切开而不是整体误判。
 *
 * 含 `:` 和 `#` 是为了保住行号后缀（`foo.ts:42`、`foo.ts#L10`）——文件面板靠它定位行。
 */
const CANDIDATE_RE = /[A-Za-z0-9~@._/\\:#+-]{2,260}/g

/**
 * 候选尾部要剥掉的标点。集合里只有 `.` `:` `#` 需要处理——其余标点（`,` `)` `!`
 * 以及所有全角标点）本就不在 CANDIDATE_RE 的字符集里，不会进到候选末尾。
 * 典型输入："改 foo.ts。" → 中文句号是边界；"see README.md." → 尾部 `.` 在这里剥掉。
 */
const TRAILING_PUNCT_RE = /[.:#]+$/

/** 纯文本里命中的一段文件引用（相对所在文本节点的偏移）。 */
export interface FileReferenceHit {
  start: number
  end: number
  reference: string
}

/**
 * 从一段自由文本里找出所有文件引用。
 * 纯函数、不碰 DOM——扫描规则的正确性全部由它的单测覆盖。
 */
export function findFileReferences(text: string): FileReferenceHit[] {
  const hits: FileReferenceHit[] = []
  CANDIDATE_RE.lastIndex = 0
  for (let match = CANDIDATE_RE.exec(text); match !== null; match = CANDIDATE_RE.exec(text)) {
    const raw = match[0]
    const trailing = TRAILING_PUNCT_RE.exec(raw)?.[0].length ?? 0
    const reference = trailing > 0 ? raw.slice(0, raw.length - trailing) : raw
    if (!reference || !looksLikeFileReference(reference)) continue
    hits.push({ start: match.index, end: match.index + reference.length, reference })
  }
  return hits
}

/** 给元素打上可点击文件引用的标记（三类来源共用）。 */
export function markFileReference(element: HTMLElement, reference: string): void {
  element.dataset.fileReference = reference
  element.classList.add('file-reference')
  element.title = `在文件面板中预览 ${reference}`
}

/**
 * 装饰整个 markdown 容器。渲染后（nextTick）调用；
 * 每次 v-html 重设都会丢弃旧 DOM，因此无需清理上一轮的标记。
 */
export function decorateFileReferences(container: HTMLElement): void {
  decorateInlineCode(container)
  decorateAnchors(container)
  decoratePlainText(container)
}

// inline code：跳过代码块（pre 内），整段文本作为候选。
function decorateInlineCode(container: HTMLElement): void {
  for (const code of container.querySelectorAll('code')) {
    if (code.closest('pre')) continue
    const reference = code.textContent?.trim() ?? ''
    if (looksLikeFileReference(reference)) markFileReference(code as HTMLElement, reference)
  }
}

// 非外链锚点：href 本身就是路径，不必再猜。
function decorateAnchors(container: HTMLElement): void {
  for (const anchor of container.querySelectorAll('a')) {
    const href = anchor.getAttribute('href') ?? ''
    if (!href || /^(https?:|mailto:|#)/i.test(href)) continue
    markFileReference(anchor as HTMLElement, href)
  }
}

// 正文纯文本：把命中的片段切出来包成 span。
function decoratePlainText(container: HTMLElement): void {
  // 先收集再替换：replaceChild 会改动树结构，边遍历边改会漏掉后续节点。
  const targets: Text[] = []
  collectScannableTextNodes(container, targets)
  for (const node of targets) replaceTextNode(node)
}

/**
 * 递归收集可扫描的文本节点。
 *
 * 这里没用 TreeWalker：happy-dom 的实现对 `whatToShow` 和 `FILTER_SKIP` 都不正确
 *（SHOW_TEXT 一个节点都走不到，SKIP 不会深入子节点），Electron 里没问题但测试跑不通。
 * 显式递归行为跨环境确定，也没慢到需要在意——跳过的容器整棵子树都不进。
 */
function collectScannableTextNodes(element: Element, out: Text[]): void {
  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.nodeValue
      // 便宜的预筛：文件引用必然含 `.` 或 `/`，绝大多数文本节点在这里就挡掉了，
      // 不用为每个节点跑正则——流式渲染时这个容器会被反复重扫。
      if (text && (text.includes('.') || text.includes('/'))) out.push(child as Text)
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const el = child as Element
    if (el.matches(SKIP_SELECTOR)) continue
    collectScannableTextNodes(el, out)
  }
}

function replaceTextNode(node: Text): void {
  const text = node.nodeValue ?? ''
  const hits = findFileReferences(text)
  if (hits.length === 0) return

  const fragment = document.createDocumentFragment()
  let cursor = 0
  for (const hit of hits) {
    if (hit.start > cursor) {
      fragment.appendChild(document.createTextNode(text.slice(cursor, hit.start)))
    }
    const span = document.createElement('span')
    span.textContent = hit.reference
    markFileReference(span, hit.reference)
    // 正文里的引用走轻量样式变体（不做成 inline code 那样的灰底胶囊），详见 MarkdownView 样式注释。
    span.classList.add('file-reference-text')
    fragment.appendChild(span)
    cursor = hit.end
  }
  if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)))
  node.parentNode?.replaceChild(fragment, node)
}
