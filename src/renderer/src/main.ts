import { createPinia } from 'pinia'
import { createApp } from 'vue'
import '@xterm/xterm/css/xterm.css'

import App from './App.vue'
import { registerDefaultCommands } from './lib/commands'
import { router } from './router'
import './assets/styles/main.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

// 注册默认命令
void registerDefaultCommands()
