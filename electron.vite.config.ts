import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main'),
      },
    },
    build: {
      rollupOptions: {
        // 单入口：index 是 Electron 主进程入口。
        // （迁移到 Agent SDK 后，mcp-server 独立入口已删除——权限改由 SDK 的
        // canUseTool 进程内回调处理，不再需要单独 spawn MCP server 子进程。）
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main'),
      },
    },
    build: {
      rollupOptions: {
        external: ['electron'],
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
    plugins: [
      vue(),
      tailwindcss(),
      AutoImport({
        imports: ['vue', 'vue-router', 'pinia'],
        dts: resolve(__dirname, 'src/renderer/src/auto-imports.d.ts'),
      }),
      Components({
        dts: resolve(__dirname, 'src/renderer/src/components.d.ts'),
      }),
    ],
  },
})
