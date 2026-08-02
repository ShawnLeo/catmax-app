/**
 * Composer Autocomplete: 输入框快捷联想的类型契约。
 *
 * 这一层刻意跟「文件引用」解耦——第一期只有 `@文件` 一个 provider，但下一期的
 * `/` 斜杠命令、技能、MCP 工具走的是同一条链路：检测触发段 → 拿候选 → 替换文本。
 * 三者唯一的差别在 provider 内部，所以扩展一种联想 = 新增一个 provider 文件 +
 * 在 index.ts 里注册一行，这一层和 composable、弹层组件都不用动。
 *
 * 有意不放进契约里的东西：
 * - 不带「当前光标像素坐标」——弹层固定贴在输入框上方，不跟随光标。跟随光标要
 *   测量镜像层的字符位置，成本远高于收益（Claude Code 的终端联想也是固定位置）。
 * - provider 不直接读 store——工作区 id 这类外部状态从 SuggestionContext 传进来，
 *   provider 才能在测试里脱离 Pinia 单独跑。
 */
import type { BackendId } from '@shared/constants'
import type { Component } from 'vue'

/** 光标所处的触发段——`@src/comp` 中 `@` 到光标之间的那一截。 */
export interface TriggerMatch {
  /** 触发字符本身，provider 同时支持多个触发字符时用它区分 */
  char: string
  /** 触发段起始偏移（指向触发字符） */
  start: number
  /** 触发段结束偏移（= 光标位置，开区间） */
  end: number
  /** 触发字符之后到光标之间的文本，即用户正在打的查询词 */
  query: string
}

/**
 * `(text, caret, ctx) → 触发段`，不在触发段里就返回 null。
 *
 * 带 ctx 是因为「这个触发字符在当前环境下有没有意义」本身依赖上下文：斜杠命令
 * 在 codex 会话里根本不存在（codex 的 app-server 没有斜杠命令这一层），此时
 * `/` 就不该是触发字符。让它在检测阶段返回 null，比先弹出来再显示「没有匹配项」
 * 干净——后者会在每条以 `/` 开头的消息上闪一下空列表。
 */
export type TriggerDetector = (
  text: string,
  caret: number,
  ctx: SuggestionContext,
) => TriggerMatch | null

/**
 * 候选项的图标。
 *
 * 用可辨识联合而不是直接传组件，是为了让弹层保持受控：文件项必须走
 * FileTypeIcon（跟文件树同一套 material 图标），命令/技能项用 lucide 就够。
 * 加新类型时在这里加一个分支，弹层里加一个 v-else-if。
 */
export type SuggestionIcon =
  { kind: 'file'; name: string; isDirectory: boolean } | { kind: 'lucide'; component: Component }

/** 一条候选。 */
export interface SuggestionItem {
  /** 列表 key，在同一次结果里唯一即可 */
  id: string
  /** 主文本（文件名 / 命令名） */
  label: string
  /** 次要文本（所在目录 / 命令说明），窄屏会被截断 */
  detail?: string
  icon?: SuggestionIcon
  /**
   * 选中后用来替换整个触发段的文本，**含触发字符**。
   *
   * 也就是说 provider 完全掌控插入形态：文件 provider 给 `@src/a.ts `（带尾随
   * 空格终结这一段），目录给 `@src/`（不带空格，好接着往下钻）。
   */
  insert: string
  /**
   * 分组标题。
   *
   * 相邻的同名 group 会合并成一段并显示一次标题——所以 provider 必须**先按分组
   * 排好序**再返回，否则同一个标题会重复出现。不设 = 不分组（文件联想就不需要）。
   *
   * 分组是给数量大的列表用的：claude 的命令表混着几十条用户 Skill，平铺会把
   * `/compact` 这类常用命令淹掉。
   */
  group?: string
  /**
   * 应用后保持弹层打开并按新文本重新联想。
   *
   * 目录用它实现「选中目录 → 继续列子项」。只有当 insert 之后光标仍落在一个
   * 合法触发段里才有意义，否则弹层会立刻自己关掉（无害，但白闪一下）。
   */
  keepOpen?: boolean
}

/** provider（检测和搜索时）能拿到的外部状态。 */
export interface SuggestionContext {
  /** 当前工作区 id；没打开工作区时为 undefined，provider 应返回空结果 */
  workspaceId: string | undefined
  /**
   * 当前会话所属后端。
   *
   * 联想内容是按后端分的——同一个 `/`，claude 有一整套命令，codex 一个都没有
   * （详见 commands/index.ts）。会话的后端不可变，打开会话时 backendStore
   * 会切过去，所以直接取 backendStore.currentId 即可。
   */
  backendId: BackendId | undefined
}

/** 一种联想来源。 */
export interface SuggestionProvider {
  /** 唯一 id，用于日志和「触发段没变就不重查」的判定 */
  id: string
  /** 判断光标是否落在本 provider 的触发段里，见 charTrigger 工厂 */
  detect: TriggerDetector
  /**
   * 取候选。抛异常等价于返回空结果（composable 会兜住并打日志）——
   * provider 不必为「工作区被删了」这类瞬时错误写防御代码。
   */
  search(match: TriggerMatch, ctx: SuggestionContext): Promise<SuggestionItem[]>
  /** 没有候选时弹层显示的文案 */
  emptyText?: string
}
