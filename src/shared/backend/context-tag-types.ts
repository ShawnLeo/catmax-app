/**
 * Context Tag 类型契约——可扩展的 IDE/环境上下文标签系统。
 *
 * 用途：user 消息文本里可能携带结构化 context 标签（Claude/Codex IDE 集成注入的），
 *   比如 <ide_selection>...</ide_selection>、<ide_opened_file>...</ide_opened_file>、
 *   <environment_context>...</environment_context>。
 *
 * 设计：注册表 + 三段式 handler（tag 名 + extract 提取函数 + 渲染组件）。
 *   加新 tag 类型不动 history-mapping / MessageItem，只动 handler 注册表。
 *
 * 分层：本文件只放"纯类型 + 纯函数 handler 定义"，不放 Vue 组件——
 *   component 字段由 renderer 侧绑（main 进程 import 不到 Vue 组件）。
 *   后端 history-mapping 用 ContextTagExtractor（不带 component 的简化版）。
 */

/**
 * 一个 context tag 在原文本中的匹配位置 + 提取出的结构化数据。
 * 用于切片：把 text 切成 "前文 + tag + 后文" 三段。
 */
export interface ContextTagMatch<T = unknown> {
  /** 在原 text 中的字节起始位置（闭区间） */
  start: number
  /** 在原 text 中的字节结束位置（开区间，方便 slice） */
  end: number
  /** 提取出的结构化数据，原样塞到 ContextBlock.data */
  data: T
}

/**
 * 后端用：只关心提取，不关心渲染。
 * renderer 的 ContextTagHandler 在此基础上多一个 component 字段。
 */
export interface ContextTagExtractor<T = unknown> {
  /** tag 名，如 'ide_selection' / 'ide_opened_file' / 'environment_context' */
  tag: string
  /** 从 user 文本里提取所有这种 tag 的实例 */
  extract: (text: string) => ContextTagMatch<T>[]
  /**
   * 提取后是否从原文本中移除该段（默认 true）。
   * - ide_selection / ide_opened_file：true → 拆出来单独渲染，原文不留
   * - environment_context：true → 完全隐藏（连拆出来的 contextBlock 都不渲染）
   *   实现方式：component 返回 null（renderer 决定）
   */
  removeFromText?: boolean
}

/**
 * Context tag 块——NormalizedMessage.contextBlocks[] 的元素。
 * 跟 textBlocks / toolBlocks 平级，UI 按 tag 分发到对应组件渲染。
 */
export interface ContextBlock {
  /** 哪种 tag，对应 ContextTagHandler.tag */
  tag: string
  /** handler.extract 返回的结构化数据，UI 按 tag 类型 cast 成具体形状 */
  data: unknown
}

// ============ 三个内置 tag 的数据形状 ============
// 放这里而不是各自的 handler 文件，是为了让 backend 也能 import 这些类型
// 做 cast（history-mapping 不需要，但 mapping 测试可能要）。

/** <ide_selection> 提取出的数据 */
export interface IdeSelectionData {
  filePath: string
  startLine: number
  endLine: number
  /** 选中的代码原文（用于展开预览） */
  code: string
}

/** <ide_opened_file> 提取出的数据 */
export interface IdeOpenedFileData {
  filePath: string
}

/** <environment_context> 提取出的数据（codex 注入的 cwd/shell/model 等） */
export interface EnvironmentContextData {
  /** 原始 XML 内容，debug 时可看；UI 默认完全隐藏 */
  raw: string
}
