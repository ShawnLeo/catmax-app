import { createPinia } from 'pinia'
import { createApp } from 'vue'
import '@xterm/xterm/css/xterm.css'

import App from './App.vue'
import { registerDefaultCommands } from './lib/commands'
// 副作用 import：注册内置 context tag handler（ide_selection / ide_opened_file / environment_context）
// 必须在 app.mount 之前执行——MessageItem.vue 渲染时 registry 必须已就绪
import './lib/context-tag-handlers'
import { router } from './router'
import './assets/styles/main.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

// 注册默认命令
void registerDefaultCommands()
