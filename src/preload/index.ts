import { contextBridge } from 'electron'

import { api } from './api'

// 在沙箱内通过 contextBridge 把 api 注入 window.api
// 渲染层只能访问 api 上明确暴露的方法，不能直接拿 electron
contextBridge.exposeInMainWorld('api', api)
