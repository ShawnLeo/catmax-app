/**
 * File Mention: 从一次拖放里把「被拖的是哪些文件」抽出来。
 *
 * 四类来源，DataTransfer 上的形态完全不同：
 *
 * 1. 访达 / 资源管理器 / 桌面等 OS 文件管理器
 *      → `dataTransfer.files` 里是真的 File 对象，磁盘路径要靠 preload 桥去取
 *        （见 api.fs.getPathForFile 的 Electron 版本兼容说明）。
 * 2. VS Code 系编辑器（VS Code、Cursor、Trae、Windsurf……都是同一份 fork）
 *      → **不放 `Files`**。它们从资源管理器拖出去时只写自己那套私有 MIME 加上
 *        `text/uri-list`（见 VSCODE_RESOURCE_MIMES）。这些私有类型能跨应用传过来
 *        是因为两端都是 Chromium，走的是同一个私有剪贴板通道。
 * 3. JetBrains 系 IDE / 其它原生程序
 *      → 走真正的 OS 文件拖拽，跟第 1 类一样有 `files`。
 * 4. 应用内文件树
 *      → 自己 setData 的私有 MIME，直接带上已经算好的工作区相对路径，
 *        不用再往返一次 resolveFileReference。
 *
 * 返回的是「引用候选」而不是最终路径：外部来源只有绝对路径，要不要转成工作区
 * 相对路径由调用方走 resolveFileReference 决定。
 */

/** 应用内拖拽的私有 MIME——只有 catmax 自己认，跟外部拖拽彻底分开。 */
export const CATMAX_FILE_MIME = 'application/x-catmax-file'

/**
 * VS Code 系编辑器写的文件清单，按可靠性排序。
 *
 * 优先于 `text/uri-list` 使用，不只是偏好问题：VS Code 的 `text/uri-list` **只写
 * 第一个 URI**（`uriListEntries.slice(0, 1)`），多选拖拽时其余文件全在这两个私有
 * 类型里。先读 uri-list 会静默丢掉除第一个以外的所有文件。
 *
 * 两者载荷都是 JSON 字符串数组，元素可能是 `file://` URI 也可能是裸路径，
 * 由 toLocalPath 统一处理。
 */
const VSCODE_RESOURCE_MIMES = ['text/x-vscode-resources', 'CodeFiles'] as const

export interface DraggedFile {
  /** 磁盘绝对路径；应用内拖拽可能没有（只有相对路径） */
  absolutePath?: string
  /** 工作区相对路径；仅应用内拖拽直接带 */
  relativePath?: string
}

/** 应用内拖拽写进 dataTransfer 的载荷。 */
export interface CatmaxDragPayload {
  relativePath: string
  isDirectory: boolean
}

/**
 * 这次拖拽拖的是文件吗？
 *
 * dragenter/dragover 阶段出于安全限制读不到内容，只能看 `types`——所以判定必须
 * 基于类型名。没有这层判定，拖一段选中的文字也会弹出投放遮罩。
 *
 * 这里认的类型必须覆盖 readDraggedFiles 能解析的每一条通道，少一条就是个隐形
 * 死角：判定不通过 → dragover 不 preventDefault → **drop 事件根本不触发** →
 * 那条通道的解析代码永远跑不到。VS Code 系编辑器就是这么拖不进来的（它们不放
 * `Files`），症状是拖过去连遮罩都不亮。
 *
 * 唯一有意排除的是 `text/plain`：拖一段选中文字也走它，放进来会让遮罩在纯文本
 * 拖拽时误亮。它只作为 drop 阶段的最后回退，不参与判定。
 */
export function dragHasFiles(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false
  const types = Array.from(dt.types)
  if (types.includes('Files') || types.includes(CATMAX_FILE_MIME)) return true
  if (VSCODE_RESOURCE_MIMES.some((mime) => types.includes(mime))) return true
  // 标准类型，什么都可能塞——拖网页链接也是它。这时遮罩会亮但 drop 解析不出
  // 本地文件，等于白亮一次；比整类编辑器都拖不进来要好得多。
  return types.includes('text/uri-list')
}

/** 这次拖拽来自应用内的文件树（而不是外部程序）。 */
export function isInternalDrag(dt: DataTransfer | null | undefined): boolean {
  return !!dt && Array.from(dt.types).includes(CATMAX_FILE_MIME)
}

/**
 * 从 drop 事件的 dataTransfer 里读出被拖的文件。
 *
 * 只在 drop 阶段有效——早于 drop 读不到内容。按来源可靠性取第一个有结果的通道，
 * 不做合并：同一次拖拽往往在多个通道里重复出现同一批文件，合并只会得到重复项。
 */
export function readDraggedFiles(dt: DataTransfer | null | undefined): DraggedFile[] {
  if (!dt) return []

  // 1. 应用内文件树
  const internal = dt.getData(CATMAX_FILE_MIME)
  if (internal) {
    try {
      const parsed = JSON.parse(internal) as CatmaxDragPayload | CatmaxDragPayload[]
      const items = Array.isArray(parsed) ? parsed : [parsed]
      const out = items
        .filter((it) => typeof it?.relativePath === 'string')
        .map((it) => ({ relativePath: it.relativePath }))
      if (out.length > 0) return out
    } catch {
      // 载荷坏了就当这条通道不存在，继续往下试
    }
  }

  // 2. OS 拖拽的真实 File 对象
  const files = Array.from(dt.files ?? [])
  if (files.length > 0) {
    const getPath = window.api.fs.getPathForFile
    const out = files
      .map((f) => (typeof getPath === 'function' ? getPath(f) : ''))
      .filter((p): p is string => p.length > 0)
      .map((absolutePath) => ({ absolutePath }))
    if (out.length > 0) return out
  }

  // 3. VS Code 系的完整文件清单（必须排在 uri-list 之前，见 VSCODE_RESOURCE_MIMES）
  for (const mime of VSCODE_RESOURCE_MIMES) {
    const raw = dt.getData(mime)
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!Array.isArray(parsed)) continue
      const out = parsed
        .filter((entry): entry is string => typeof entry === 'string')
        .map(toLocalPath)
        .filter((p): p is string => p !== null)
        .map((absolutePath) => ({ absolutePath }))
      if (out.length > 0) return out
    } catch {
      // 换下一个通道
    }
  }

  // 4. text/uri-list（标准通道，跨应用一定在）
  const uriList = dt.getData('text/uri-list')
  if (uriList) {
    const out = uriList
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
      .map(toLocalPath)
      .filter((p): p is string => p !== null)
      .map((absolutePath) => ({ absolutePath }))
    if (out.length > 0) return out
  }

  // 5. 裸路径文本
  const plain = dt.getData('text/plain').trim()
  if (plain && looksLikePath(plain)) return [{ absolutePath: plain }]

  return []
}

/**
 * 一条来源不明的字符串 → 本地绝对路径，不是本地文件返回 null。
 *
 * 同时处理两种形态，因为各家写的不一样：`file:///Users/me/a%20b.txt` 要解码，
 * 裸路径原样通过。非 file: 协议（http、vscode-remote 之类）一律丢弃——它们不是
 * 本机文件，拿去解析只会得到一条打不开的引用。
 */
function toLocalPath(raw: string): string | null {
  if (raw.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(raw).pathname)
    } catch {
      return null
    }
  }
  if (/^[a-zA-Z][\w+.-]*:\/\//.test(raw)) return null
  return looksLikePath(raw) ? raw : null
}

/**
 * 保守判断一段文本像不像本地路径——只放行绝对路径和 `~/`。
 *
 * text/plain 是什么都可能塞的通道（拖一段文字过来也走它），这里宁可漏判：
 * 漏了用户还能手动打 `@`，误判则会把一段正文当成路径插进输入框。
 */
function looksLikePath(text: string): boolean {
  if (text.includes('\n')) return false
  return text.startsWith('/') || text.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(text)
}
