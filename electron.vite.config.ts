import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'

export default defineConfig({
  main: {
    // Hot Update: 主进程产物必须**自包含**，不能依赖外部 node_modules。
    //
    // 热更新把 out/main/index.js 侧载到 userData 下执行，而 ESM 的 bare specifier
    // （import 'simple-git'）是按 **importer 所在目录**向上找 node_modules 解析的——
    // 侧载位置那棵目录树里一个 node_modules 都没有，一路找到用户家目录仍然没有，
    // 于是 ERR_MODULE_NOT_FOUND。实测还确认了两件事：符号链接指向 asar 内的
    // node_modules 无效（ESM resolver 在 C++ 层实现，不走 asar 的 fs patch），
    // 而 CJS 的 createRequire 反而可以穿透 asar。
    //
    // 所以纯 JS 依赖一律 bundle 进来；只有真正的 native 模块（.node）保持 external，
    // 由 src/main/native/*.ts 的 shim 用 createRequire 从 asar 内加载。
    // 详见 docs/superpowers/specs/2026-08-06-hot-update-design.md §5.10。
    plugins: [
      // exclude 在这里的含义是"不要 external"，即交给 rollup bundle。
      // 注意 better-sqlite3 / node-pty / claude-agent-sdk 也必须列进来：
      // 被 externalizeDepsPlugin 标成 external 的模块不会再走 resolve.alias，
      // 下面那几条 alias 就永远命中不了。它们 bundle 进来的其实是 shim 本身
      // （src/main/native/*.ts），真包仍由 shim 在运行时 createRequire 取。
      externalizeDepsPlugin({
        exclude: [
          'fix-path',
          'ignore',
          'simple-git',
          'smol-toml',
          '@modelcontextprotocol/sdk',
          'electron-updater',
          'better-sqlite3',
          'node-pty',
          '@anthropic-ai/claude-agent-sdk',
        ],
      }),
    ],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main'),
        // Hot Update: 把无法 bundle 的依赖重定向到 shim，由它们在运行时用
        // createRequire 从 asar 内加载（见 src/main/native/README.md）。
        // 只影响 rollup 的运行时解析；`import type` 已在编译期擦除，
        // 类型仍然来自真包，所以类型检查不受影响。
        'better-sqlite3': resolve(__dirname, 'src/main/native/better-sqlite3.ts'),
        'node-pty': resolve(__dirname, 'src/main/native/node-pty.ts'),
        '@anthropic-ai/claude-agent-sdk': resolve(
          __dirname,
          'src/main/native/claude-agent-sdk.ts'
        ),
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
