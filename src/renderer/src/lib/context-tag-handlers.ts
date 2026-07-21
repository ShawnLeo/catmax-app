/**
 * renderer 侧 context tag handler 注册。
 *
 * 这个文件除了 import 就只有副作用——register 三个内置 handler。
 * 启动入口（main.ts / app.ts）必须在 app.mount 之前 import 本文件。
 *
 * 加新 tag 类型：
 *   1. 在 src/shared/backend/context-tag-handlers.ts 加 extract 函数 + push 进 sharedContextTagExtractors
 *   2. 在 src/shared/backend/context-tags.ts 的 TAG_ENCODERS 加 encode（仅当 catmax 会主动发送这种 tag）
 *   3. 在本文件 register（绑 component）
 * 完全不用动 history-mapping / MessageItem。
 */
import FilePill from '@renderer/components/chat/context/FilePill.vue'
import IdeSelectionTag from '@renderer/components/chat/context/IdeSelectionTag.vue'
import { sharedContextTagExtractors } from '@shared/backend/context-tag-handlers'
import { defineComponent } from 'vue'

import { contextTagRegistry } from './context-tag-registry'

// environment_context 完全隐藏——直接 render null
const EnvironmentContextHidden = defineComponent({
  name: 'EnvironmentContextHidden',
  render: () => null,
})

/**
 * 注册所有内置 context tag handler。
 * 返回 unbind 函数数组（用于测试 / 罕见的卸载场景）。
 *
 * 用 sharedContextTagExtractors 作为底座，附加 renderer 才有的 component 字段。
 */
export function registerBuiltinContextTagHandlers(): Array<() => void> {
  const unbinds: Array<() => void> = []
  for (const extractor of sharedContextTagExtractors) {
    const component = resolveComponent(extractor.tag)
    if (!component) {
      // shared 里加了新 extractor 但 renderer 没绑 component——
      // 跳过（不加 registry，UI 不会渲染，但提取逻辑仍可用）
      continue
    }
    unbinds.push(
      contextTagRegistry.register({
        ...extractor,
        component,
      }),
    )
  }
  return unbinds
}

/** tag 名 → Vue 组件映射。加新 tag 在这里多一个 case。 */
function resolveComponent(tag: string) {
  switch (tag) {
    case 'ide_selection':
      return IdeSelectionTag
    case 'ide_opened_file':
      return FilePill
    case 'environment_context':
      return EnvironmentContextHidden
    default:
      return undefined
  }
}

// ============ 模块加载即注册（启动入口 import 本文件就触发） ============
const _unbinds = registerBuiltinContextTagHandlers()

// 测试场景下可能需要卸载——导出（不强制持有引用，正常 app 生命周期内不卸载）
export const unbindBuiltinContextTagHandlers = () => _unbinds.forEach((u) => u())
