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
import { prewarmMarkdown } from './lib/markdown'
import { router } from './router'
import './assets/styles/main.css'

const app = createApp(App)
registerChatBlocks()
app.use(createPinia())
app.use(router)
app.mount('#app')

// 注册默认命令
void registerDefaultCommands()

// 预热 markdown——mount 后立即触发，与首屏渲染并行（不阻塞 UI）
prewarmMarkdown()
