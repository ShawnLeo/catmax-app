/**
 * File Reference Detection:
 * 判断聊天消息里的一段文本是否"像文件引用"，值得标记为可点击预览。
 *
 * 设计参考 VS Code 的 terminalLocalLinkDetector / terminalLinkParsing：
 *   - 路径字符黑名单（ExcludedPathCharactersClause）：排除代码片段常见字符
 *   - 路径前缀白名单（PathPrefix）：~/ / ./ ../ / 和 file:/// 绝对路径前缀
 *   - 纯 basename 需匹配已知扩展名（VS Code 不识别纯 basename，我们为 AI 聊天场景放宽）
 *
 * 判断分层（每层只做自己的事，互不重叠）：
 *   1. 基础过滤：空 / 过长 / 含空白 → 否
 *   2. 路径字符黑名单：含代码片段常见字符 → 否
 *   3. 路径前缀形态：~/ / // / file:/// / ./ / ../ / Windows 盘符 开头 → 是
 *   4. 纯 dotfile 白名单 / 纯 basename 扩展名白名单 → 是
 *
 * 可扩展：新增路径形态在第 3 层加前缀判断；新增文件类型在第 4 层扩展白名单。
 */

/**
 * 路径中不应出现的字符（对齐 VS Code ExcludedPathCharactersClause）。
 * 这些字符在真实文件路径里几乎不出现，但在代码片段、变量、URL 查询串里很常见，
 * 出现即可高置信度排除：
 *   =  环境变量赋值（FOO=bar）
 *   ?  可选链（obj?.x）/ URL 查询串
 *   &  URL 查询参数
 *   *  glob / 指针 / 乘号
 *   ( ) 函数调用 foo(bar)
 *   ' " 引号包裹的字符串
 *   :  冗余冒号（file:// 协议除外，由前缀分支处理）
 *   ;  语句分隔符
 *   `  模板字符串
 *   |  管道 / shell
 *
 * 注意：行号后缀的 :line / #L10 由前缀/扩展名分支放行后才到达文本，
 * 这里检查的是整串原始值；含行号的引用在「路径前缀」或「basename.ext:line」形态下
 * 先被第 3/4 层放行，不会受此黑名单影响。
 */
const NON_PATH_CHARS = /[=?&*()'"`;|]/u

/**
 * 路径前缀形态：以下列前缀开头即认定为文件引用（足够明确）。
 * - ~/            家目录
 * - /             POSIX 绝对路径
 * - file:///      file URI（VS Code linkWithSuffixPathCharacters 支持）
 * - ./  ../       显式相对路径
 * - C:\  C:/      Windows 盘符绝对路径（大小写不敏感）
 */
const PATH_PREFIX = /^(?:~\/|\/|file:\/\/\/?|\.{0,2}\/|[a-zA-Z]:[\\/])/u

/**
 * 纯 dotfile 白名单（无扩展名结构的隐藏配置文件，如 `.env`、`.gitignore`）。
 * 这些文件 basename 以 `.` 开头且本身整体就是文件名，不套用 name.ext 规则。
 */
const DOTFILE_NAMES = new Set([
  '.env',
  '.gitignore',
  '.npmrc',
  '.nvmrc',
  '.editorconfig',
  '.prettierrc',
  '.eslintrc',
  '.bashrc',
  '.zshrc',
  '.profile',
  '.DS_Store',
  '.npmignore',
  '.dockerignore',
])

/**
 * 常见文件扩展名白名单（用于纯 basename 判断，如 `FilePreview.vue`）。
 * 仅收录代码、配置、文档、媒体等真实会出现在文件引用里的类型；
 * 排除 `.name`/`.cn`/`.url`/`.type` 等变量属性、域名后缀、类型标注。
 *
 * 命名约定：全小写，不含点。顺序按类型分组便于维护。
 */
const FILE_EXTENSIONS = new Set([
  // 代码
  'c',
  'cc',
  'cjs',
  'cpp',
  'cs',
  'css',
  'go',
  'h',
  'hpp',
  'htm',
  'html',
  'java',
  'js',
  'jsx',
  'kt',
  'lua',
  'mjs',
  'php',
  'py',
  'rb',
  'rs',
  'scss',
  'sh',
  'sql',
  'svelte',
  'swift',
  'ts',
  'tsx',
  'vue',
  'xml',
  'zsh',
  // 配置 / 数据
  'env',
  'ini',
  'json',
  'jsonc',
  'toml',
  'yaml',
  'yml',
  'lock',
  'log',
  // 文档
  'md',
  'mdx',
  'markdown',
  'csv',
  'tsv',
  'pdf',
  'txt',
  'rst',
  'tex',
  // 媒体
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'ico',
  'bmp',
  'avif',
  'mp3',
  'wav',
  'mp4',
  'mov',
  'webm',
  // 打包 / 字体 / 其他
  'zip',
  'gz',
  'tar',
  '7z',
  'woff',
  'woff2',
])

/**
 * 判断一段文本是否像文件引用。
 */
export function looksLikeFileReference(value: string): boolean {
  if (!value || value.length > 260 || /\s/.test(value)) return false
  if (NON_PATH_CHARS.test(value)) return false

  // 路径前缀形态：家目录、绝对、file URI、显式相对、Windows 盘符。足够明确，直接放行。
  if (PATH_PREFIX.test(value)) return true

  // 纯 dotfile（无扩展名结构）：.env、.gitignore 等已知隐藏配置文件。
  if (DOTFILE_NAMES.has(value)) return true

  // 纯 basename：末段必须是 name.ext，ext 在白名单内，可带行号/锚点后缀。
  return matchesBasenameWithExtension(value)
}

/**
 * 纯 basename 判断：`name.ext`、`.dotfile.ext`、`path/name.ext`，
 * 末段扩展名必须在白名单内，可附带 :line:col / :line-range / #L10 / (line) 行号后缀。
 *
 * 单独成函数便于测试和未来扩展。
 */
function matchesBasenameWithExtension(value: string): boolean {
  const match = value.match(
    /(?:^|\/)([^/]+\.[a-z][a-z0-9]{0,11})(?::\d+(?::\d+)?(?:-\d+)?|#L\d+(?:C\d+)?|\(\d+(?::\d+)?\))?$/i,
  )
  if (!match) return false
  // 取末段文件名（去掉可能的目录前缀和行号后缀）
  const fileName = match[1]!
  const ext = fileName.split('.').pop()!.toLowerCase()
  return FILE_EXTENSIONS.has(ext)
}
