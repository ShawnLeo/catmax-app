# Backend 插件开发与使用

CatMax 的 backend 插件分为两个运行边界：

- **Main plugin**：创建 `AgentBackend` adapter，负责进程、协议、历史和 `TurnEvent`。
- **Renderer plugin**：把插件声明的 `ContentBlock.type` 注册为异步 Vue 组件。

当前支持的是**随应用构建的受信任插件**。插件注册后可以使用任意稳定字符串 id，
不再局限于 `codex | claude`。暂不支持从未知目录热加载任意 JavaScript/Vue 代码；
修改插件组合入口后需要重新构建或重启开发服务。

## 1. 推荐目录

```text
src/
  main/backend/my-backend/
    adapter.ts
    mapping.ts
    plugin.ts
  renderer/src/components/chat/blocks/my-backend/
    ProgressBlockView.vue
    plugin.ts
  shared/backend/blocks/
    my-backend.ts
```

第三方包也可以保持相同的 `main / renderer / shared` exports。

## 2. 声明 block 契约

插件 block 必须使用带命名空间的 type，避免与其他插件冲突：

```ts
// shared/backend/blocks/my-backend.ts
import type { BaseContentBlock } from './base'

export interface BuildProgressBlock extends BaseContentBlock {
  type: 'acme.build_progress'
  step: string
  percent: number
}

declare module '@shared/backend/blocks' {
  interface ContentBlockMap {
    'acme.build_progress': BuildProgressBlock
  }
}
```

通用文本、推理、工具调用和上下文应复用 `base` block，不要为每个 backend 复制。

## 3. 实现 Main plugin

Adapter 实现 `AgentBackend`，并保证 `adapter.id === manifest.id`：

```ts
// main/backend/my-backend/plugin.ts
import type { MainBackendPlugin } from '../plugin-registry'
import { MyBackendAdapter } from './adapter'

export const myMainPlugin: MainBackendPlugin = {
  manifest: {
    id: 'acme.my-backend',
    displayName: 'My Backend',
    version: '1.0.0',
    blockTypes: ['text', 'reasoning', 'tool_call', 'acme.build_progress'],
    capabilities: MY_CAPABILITIES,
  },
  createAdapter: (context) =>
    new MyBackendAdapter({
      onThreadResolved: (localId, realId) =>
        context.onBackendThreadIdResolved('acme.my-backend', localId, realId),
    }),
  applySettings: (adapter, settings) => {
    // 可读取 settings.backendPaths['acme.my-backend'] 等插件配置。
  },
}
```

在 main composition root 注册：

```ts
// src/main/backend/plugin-loader.ts
import { myMainPlugin } from './my-backend/plugin'
import { isBackendPluginRegistered, registerBackendPlugin } from './plugin-registry'

export function registerMainBackendPlugins(): void {
  registerBuiltinBackendPlugins()
  if (!isBackendPluginRegistered(myMainPlugin.manifest.id)) {
    registerBackendPlugin(myMainPlugin)
  }
}
```

`BackendManager` 会自动创建已注册 adapter、加入状态列表、支持切换、模型查询、
历史加载、会话扫描与退出清理。

## 4. 实现 Renderer plugin

```vue
<!-- ProgressBlockView.vue -->
<template>
  <div>{{ block.step }} · {{ block.percent }}%</div>
</template>

<script setup lang="ts">
import type { BuildProgressBlock } from '@shared/backend/blocks/my-backend'
defineProps<{ block: BuildProgressBlock }>()
</script>
```

```ts
// renderer/.../my-backend/plugin.ts
import type { RendererBackendPlugin } from '../plugin-registry'
import { registerBlock } from '../registry'

export const myRendererPlugin: RendererBackendPlugin = {
  manifest: MY_MANIFEST,
  registerBlocks: () => {
    registerBlock('acme.build_progress', () => import('./ProgressBlockView.vue'))
  },
  // 可选：当 backend 的会话组合规则与 base 不同时，注册整个会话的渲染根。
  conversationRenderer: () => import('./MyConversation.vue'),
}
```

在 renderer composition root 注册：

```ts
// src/renderer/src/backend-plugins/index.ts
import { myRendererPlugin } from './my-backend/plugin'
import {
  isRendererBackendPluginRegistered,
  registerRendererBackendPlugin,
} from '../components/chat/blocks/plugin-registry'

export function registerRendererBackendPlugins(): void {
  // 保留内置注册……
  if (!isRendererBackendPluginRegistered(myRendererPlugin.manifest.id)) {
    registerRendererBackendPlugin(myRendererPlugin)
  }
}
```

应用启动时会调用每个插件的 `registerBlocks()`。manifest 声明但没有 renderer 的
block 会输出警告；运行中收到完全未知的 block 会显示原始 JSON fallback，不会静默丢失。

`conversationRenderer` 是可选的。未提供时继续使用 base 的 `MessageItem` 列表；提供后，
`MessageList` 会把 `messages`、`cwd`、`running`、`currentTurnId` 等传给插件根组件，由
backend 自己决定是否按 turn 聚合、如何折叠过程区以及怎样安排最终回答。Codex 使用这一
入口完全绕开 Claude 风格的消息时间线。第三方根组件仍必须只消费共享归一化类型，不能
直接 import main/preload 或原始 backend 协议。

## 5. 产出 block

实时路径建议由 adapter 映射为：

```ts
{
  type: 'content_block_upsert',
  turnId,
  block: {
    id: item.id,
    type: 'acme.build_progress',
    step: item.step,
    percent: item.percent,
  },
}
```

相同 `block.id` 会原位更新，适合进度、计划和长任务。文本、reasoning 与工具调用仍优先
使用已有 `text_delta`、`reasoning_delta`、`tool_call_*` 事件。

历史读取必须返回相同的 `NormalizedMessage.blocks`，确保实时和回放采用同一组件。

## 6. 设置与 UI

- `defaultBackend` 接受插件 id。
- `backendPaths` 和 `defaultRuntimeConfig` 会保留任意插件键。
- backend 状态与模型列表根据已注册插件动态加载。
- 未提供品牌图标时 UI 使用通用 backend 图标。

插件需要特殊设置表单时，应自行提供 renderer 设置组件；当前通用设置页只保证模型、
effort、permission mode 和通用路径数据不会丢失。

## 7. 安全约束

- 只注册可信代码；Main plugin 拥有本地进程与文件系统能力。
- 插件 id 使用 `vendor.name`，block type 使用 `vendor.block_name`。
- 不覆盖其他插件的 block renderer；重复 backend id 会直接报错。
- 不把原始 backend 协议对象穿过 IPC，应先映射为共享 block/事件。
- 若未来支持免构建安装，第三方 UI 应改为声明式 schema 或隔离 webview，不能直接
  在主 renderer 中执行未知 Vue 模块。
