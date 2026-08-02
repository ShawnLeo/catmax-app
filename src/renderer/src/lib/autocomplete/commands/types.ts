/**
 * Composer Autocomplete: 斜杠命令的描述格式。
 *
 * 这里只描述「命令长什么样」，不描述「怎么执行」——因为 catmax 支持的两个后端里，
 * 只有 claude 的斜杠命令是**发出去的文本**：claude CLI 收到 user message 时自己
 * 拦截 `/xxx` 并展开成内部 prompt，所以 catmax 只要把 `/compact` 原样当 prompt
 * 发过去就行（history-mapping.ts 解析 jsonl 里的 <command-name> sentinel 就是这条
 * 链路留下的痕迹）。
 *
 * codex 不是这样：它的 app-server 根本没有斜杠命令这一层，`/compact` `/new`
 * `/diff` 全是 TUI 本地功能，各自对应不同的 JSON-RPC 方法（thread/compact、
 * thread/start、turn/diff）。把 `/compact` 当文本发给 turn/start，codex 会原样
 * 交给模型当普通消息。所以将来接 codex 时，SuggestionItem 需要一个「选中后调什么」
 * 的动作概念，而不是只有 insert 文本——那时再加，现在不预留空壳。
 */
import type { SlashCommandSource } from '@shared/backend/slash-commands'
import type { Component } from 'vue'

export interface SlashCommandSpec {
  /** 命令名，**不含**前导斜杠 */
  name: string
  /** 一句话说明，显示在候选项右侧 */
  description: string
  /**
   * 参数提示（如 `[聚焦说明]`）。
   *
   * 有它 = 这条命令可以带参数，插入后补一个空格让用户接着打；没有 = 命令本身
   * 就是完整消息，插入后不补空格，用户直接回车发送。
   */
  argumentHint?: string
  /** 别名，参与匹配但不单独成为一条候选（如 /cost 命中 /usage） */
  aliases?: string[]
  /**
   * 来源，决定弹层里的分组和默认图标。
   *
   * 用户 Skill 可能有几十条（本机 36 条），跟内置命令混在一个平铺列表里会把
   * `/compact` 这种常用命令淹掉，所以必须分组，内置在前。
   */
  source: SlashCommandSource
  /**
   * 候选项左侧图标。
   *
   * 只有静态兜底表会逐条指定——动态列表有几十条，按 source 给默认图标即可
   * （见 providers/slash-command.ts 的 iconFor）。
   */
  icon?: Component
}
