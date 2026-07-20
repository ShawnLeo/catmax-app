/**
 * Context tag 注册表（renderer 侧）。
 *
 * 跟 commandRegistry.ts 同款"Map + register 返回 unbind"骨架。
 *
 * 每个 handler 在 ContextTagExtractor（shared 层纯提取逻辑）基础上多一个 component 字段——
 * main 进程的 history-mapping 不用本注册表（它直接用 sharedContextTagExtractors），
 * renderer 的 MessageItem.vue 用本注册表查 component 渲染。
 */
import type { Component } from 'vue'

import type { ContextTagExtractor } from '@shared/backend/context-tag-types'

export interface ContextTagHandler extends ContextTagExtractor {
  /** 渲染组件——MessageItem.vue 通过 <component :is="..."> 挂上 */
  component: Component
}

class ContextTagRegistry {
  private handlers = new Map<string, ContextTagHandler>()

  register(handler: ContextTagHandler): () => void {
    this.handlers.set(handler.tag, handler)
    return () => {
      // 避免后注册的 handler 被 unregister 误删先注册的同名 handler
      if (this.handlers.get(handler.tag) === handler) {
        this.handlers.delete(handler.tag)
      }
    }
  }

  get(tag: string): ContextTagHandler | undefined {
    return this.handlers.get(tag)
  }

  /** 返回所有已注册 handler 的纯提取逻辑（给 extractContextTags 用） */
  extractors(): ContextTagHandler[] {
    return Array.from(this.handlers.values())
  }
}

export const contextTagRegistry = new ContextTagRegistry()
