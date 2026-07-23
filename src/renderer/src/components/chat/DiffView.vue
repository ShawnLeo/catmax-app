<template>
  <!--
    结构化 diff 渲染——基于 @git-diff-view/vue 实现 GitHub/Claude Code 风红绿行穿插。

    三种 ToolEditInfo.type 都收敛成 DiffFile 实例传给底层组件：
    - string_replace（claude Edit）：oldString + newString → 库自己算行级 diff
    - full_content（claude Write）：空 oldContent + newContent → 整块绿色（新增）
    - unified_diff（codex）：直接把 unified diff 文本作为 hunk 传进去（库原生支持）

    渲染模式：Unified（行级穿插，跟 Claude Code 一致），不用 Split（side-by-side 太宽）。
    主题跟随 catmax 的 [data-theme]——light/dark 联动。

    语法高亮：用 lowlight 包自带的 highlighter 实例（基于 highlight.js，纯 JS 无 wasm，
    不会触发 CSP 问题）。已注册了 100+ 种语言，直接用。
  -->
  <div v-if="diffFile" class="diff-view-wrapper text-[12px]">
    <DiffView
      :diff-file="diffFile"
      :diff-view-mode="DiffModeEnum.Unified"
      :diff-view-theme="theme"
      :diff-view-highlight="true"
      :diff-view-font-size="12"
      :register-highlighter="lowlightHighlighter"
    />
  </div>
  <!-- fallback：diffFile 构建失败（数据残缺等极端情况） -->
  <pre
    v-else
    class="font-mono text-[12px] bg-terminal text-foreground/80 p-3 overflow-x-auto whitespace-pre-wrap"
    >{{ fallbackText }}</pre>
</template>

<script setup lang="ts">
import { DiffFile, generateDiffFile } from '@git-diff-view/file'
// lowlight 包自带已注册的 highlighter 实例——直接 import 用，不用自己 init
import { highlighter as lowlightHighlighter } from '@git-diff-view/lowlight'
import { DiffModeEnum, DiffView } from '@git-diff-view/vue'
import type { ToolEditInfo } from '@shared/backend/types'
import '@git-diff-view/vue/styles/diff-view.css'
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'

const props = defineProps<{ edit: ToolEditInfo }>()

// ============ DiffFile 构建 ============
const diffFile = shallowRef<DiffFile | null>(null)

function buildDiffFile() {
  const edit = props.edit
  try {
    let file: DiffFile | null = null
    const lang = guessLang(edit.filePath)

    if (edit.type === 'string_replace') {
      // claude Edit / MultiEdit：oldString → newString 的行级 diff
      // MultiEdit 暂时只渲染第一组（顶层 oldString/newString，mapping 已保证有第一组数据）
      const oldStr = ensureTrailingNewline(edit.oldString ?? '')
      const newStr = ensureTrailingNewline(edit.newString ?? '')
      file = generateDiffFile(edit.filePath, oldStr, edit.filePath, newStr, lang, lang)
    } else if (edit.type === 'full_content') {
      // claude Write：整文件覆盖。oldContent 给空——所有行被标绿（新增）
      // content 为空时不构建——空文件 Write 没有可 diff 内容，强行喂给库会刷两条
      // "No hunks / identical content" 警告，且渲染也是空白，直接走 fallback 更干净。
      const content = ensureTrailingNewline(edit.content ?? '')
      if (content) {
        file = generateDiffFile(edit.filePath, '', edit.filePath, content, lang, lang)
      }
    } else if (edit.type === 'unified_diff' && edit.diff) {
      // codex：直接把 unified diff 文本作为 hunk 数组传给构造器
      // 库会 parse +/- 行并渲染
      file = new DiffFile(edit.filePath, '', edit.filePath, '', [edit.diff], lang, lang)
    }

    if (file) {
      file.initTheme(theme.value)
      file.init()
      file.buildSplitDiffLines()
      file.buildUnifiedDiffLines()
      diffFile.value = file
    } else {
      diffFile.value = null
    }
  } catch (e) {
    console.warn('[DiffView] DiffFile 构建失败', e)
    diffFile.value = null
  }
}

// ============ 主题联动 ============
// catmax 用 <html data-theme="dark"|"light"> 切换，转成 git-diff-view 接受的 "dark"|"light"
const theme = ref<'light' | 'dark'>(readTheme())

function readTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
}

// 监听 <html data-theme> 变化——切主题时重建 diffFile 让 initTheme 生效
let themeObserver: MutationObserver | null = null
onMounted(() => {
  themeObserver = new MutationObserver(() => {
    const newTheme = readTheme()
    if (newTheme !== theme.value) {
      theme.value = newTheme
      buildDiffFile()
    }
  })
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
  buildDiffFile()
})

onUnmounted(() => {
  themeObserver?.disconnect()
  themeObserver = null
})

// edit 变化时重建（ToolCallCard 复用 DiffView 实例，props 可能变）
watch(() => props.edit, buildDiffFile, { deep: false })

// ============ 工具函数 ============
/**
 * 给内容补一个结尾换行（若缺失）。
 *
 * 纯粹是为了喂给 @git-diff-view：库内部用 createTwoFilesPatch 把内容生成 patch，
 * 再 round-trip 校验 patch ↔ 内容是否一致。当内容缺少结尾换行时，patch 会带
 * "No newline at end of file" 标记，round-trip 在最后一行对不上，触发开发态警告：
 *   "Mismatch detected between 'newFileContent' and 'diff' at line N"
 * 补一个换行后 round-trip 就能对齐；diff 显示的行内容不变（结尾换行是纯展示细节）。
 */
function ensureTrailingNewline(s: string): string {
  return s && !s.endsWith('\n') ? s + '\n' : s
}

/** 从文件路径推语言 id（lowlight/highlight.js 接受的语言名） */
function guessLang(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    vue: 'xml',
    html: 'xml',
    xml: 'xml',
    css: 'css',
    scss: 'scss',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    md: 'markdown',
    json: 'json',
    yml: 'yaml',
    yaml: 'yaml',
    sh: 'bash',
    zsh: 'bash',
    sql: 'sql',
  }
  // 未知扩展名不能直接把 ext 当 lang 传给 lowlight——没注册的语言会触发
  // "not support current lang: xxx yet" 警告（如 .factories）。统一回退 plaintext，
  // lowlight 会走 highlightAuto 兜底，不报错。
  return map[ext] ?? 'plaintext'
}

/** fallback 文本：构建失败时给个最小可用信息 */
const fallbackText = computed(() => {
  const e = props.edit
  if (e.type === 'unified_diff') return e.diff ?? ''
  if (e.type === 'full_content') return e.content ?? ''
  return `${e.oldString ?? ''}\n---\n${e.newString ?? ''}`
})
</script>

<style scoped>
/* wrapper 不加额外背景——git-diff-view 自带 GitHub 风配色 */
.diff-view-wrapper {
  width: 100%;
  overflow-x: auto;
}

/* 让 diff-view 的字体跟 catmax mono 字体一致 */
.diff-view-wrapper :deep(.diff-view-content) {
  font-family: var(--font-mono), monospace;
}

/* 让 diff 背景透明，融入 ToolCallCard 容器（避免突兀白底） */
.diff-view-wrapper :deep(.diff-view) {
  background-color: transparent;
}
</style>
