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
        // 多入口：index 是 Electron 主进程入口（不变），
        // mcp-server 是独立 Node 脚本入口——被 claude CLI 通过 --mcp-config spawn 起，
        // 处理 --permission-prompt-tool 的权限请求。打成独立 chunk 是因为这个脚本
        // 必须能在 ELECTRON_RUN_AS_NODE=1 模式下单独跑（不能 import 'electron'）。
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'mcp-server': resolve(__dirname, 'src/main/backend/claude/mcp/server.ts'),
        },
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
