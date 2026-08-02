/**
 * Composer Autocomplete: codex 后端的斜杠命令——**故意是空的**。
 *
 * 空表不是「还没做」，是 codex 的斜杠命令跟 claude 的不是同一种东西：
 *
 *   - claude：`/compact` 是文本，发给 CLI，CLI 自己拦截并展开。
 *   - codex：`/compact` `/new` `/diff` `/status` `/model` 全是 TUI 本地功能，
 *     各自映射到不同的 JSON-RPC 方法（thread/compact、thread/start、turn/diff）
 *     或纯客户端读取。app-server 上**没有**任何列命令、解释命令的接口。
 *
 * 也就是说把 `/compact` 当文本发给 codex 的 turn/start，codex 不会拦截，会原样
 * 交给模型当一句普通消息——用户看到的是模型茫然地问「你要我压缩什么」。所以在
 * 补齐「选中候选后调 thread/compact 而不是插入文本」这条执行路径之前，这里保持
 * 空表，`/` 在 codex 会话里干脆不触发（见 providers/slash-command.ts 的 detect）。
 *
 * codex 侧唯一天然是文本的是 `~/.codex/prompts/*.md` 自定义 prompt，那条路要读
 * 磁盘、需要新的 IPC，属于后续扩展。
 */
import type { SlashCommandSpec } from './types'

export const CODEX_SLASH_COMMANDS: SlashCommandSpec[] = []
