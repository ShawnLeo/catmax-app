/**
 * Composer Autocomplete: provider 注册表。
 *
 * 只做一件事：拿光标位置问每个 provider「这是你的触发段吗」，返回第一个说是的。
 * 按注册顺序而不是按优先级字段——顺序在 index.ts 里一眼能看全，加个字段反而
 * 要跨文件推理。真出现两个 provider 抢同一个触发字符时，那是设计问题，不该靠
 * 优先级去调和。
 *
 * 不做响应式：detect 每次按键都会调，靠 Vue 追踪反而是负担；provider 在应用启动时
 * 一次性注册完（见 index.ts）。将来 MCP 工具需要在连接后动态注册的话，
 * 注册本身是同步的、下一次按键就生效，也不需要响应式。
 */
import type { SuggestionContext, SuggestionProvider, TriggerMatch } from './types'

export interface DetectedTrigger {
  provider: SuggestionProvider
  match: TriggerMatch
}

export class SuggestionRegistry {
  private providers: SuggestionProvider[] = []

  /** 注册一个 provider，返回注销函数。 */
  register(provider: SuggestionProvider): () => void {
    this.providers.push(provider)
    return () => {
      this.providers = this.providers.filter((p) => p !== provider)
    }
  }

  list(): SuggestionProvider[] {
    return [...this.providers]
  }

  /** 光标落在谁的触发段里？都不在返回 null。 */
  detect(text: string, caret: number, ctx: SuggestionContext): DetectedTrigger | null {
    for (const provider of this.providers) {
      const match = provider.detect(text, caret, ctx)
      if (match) return { provider, match }
    }
    return null
  }
}
