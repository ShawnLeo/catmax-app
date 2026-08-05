import { createPinia } from 'pinia'
import { createApp } from 'vue'
import '@xterm/xterm/css/xterm.css'

import App from './App.vue'
import { registerChatBlocks } from './components/chat/blocks'
import { registerDefaultCommands } from './lib/commands'
// 副作用 import：注册内置 context tag handler（ide_selection / ide_opened_file / environment_context）
// 必须在 app.mount 之前执行——MessageItem.vue 渲染时 registry 必须已就绪
import './lib/context-tag-handlers'
// 预热 markdown 管线（markdown-it + Shiki 初始化约几百毫秒）。
// 在 app 启动时后台触发，让用户点开第一个会话时 getMarkdown() 多半已 resolve，
// MarkdownView 走同步渲染路径，避免历史加载的"空白→闪现"延迟。
//
// 按后端拆分后,base (Claude + 跨后端复用) 和 codex 是两份独立实例,
// 各自独立初始化 Shiki,必须分别预热,否则首次 codex 会话会卡几百毫秒。
import { prewarmMarkdown } from './lib/markdown'
import { prewarmCodexMarkdown } from './lib/markdown/codex'
import { setupTrayCommands } from './lib/tray-commands'
import { router } from './router'
import './assets/styles/main.css'

const app = createApp(App)
registerChatBlocks()
app.use(createPinia())
app.use(router)
app.mount('#app')

// 注册默认命令。托盘命令直接复用 registry 里的同 id 命令，所以必须等注册完再接。
void registerDefaultCommands().then(() => setupTrayCommands())

// 预热 markdown——mount 后立即触发，与首屏渲染并行（不阻塞 UI）
// base 服务 Claude + 跨后端复用,codex 服务 Codex 会话,两份独立管线都要预热
prewarmMarkdown()
prewarmCodexMarkdown()
