<template>
  <!--
    结构化 diff 渲染——基于 @git-diff-view/vue 实现 GitHub/Claude Code 风红绿行穿插。

    三种 ToolEditInfo.type 都收敛成 DiffFile 实例传给底层组件：
    - string_replace（claude Edit）：oldString + newString → 库自己算行级 diff
    - full_content（claude Write）：空 oldContent + newContent → 整块绿色（新增）
    - unified_diff（codex）：直接把 unified diff 文本作为 hunk 传进去（库原生支持）

    渲染模式：默认 Unified（行级穿插）；通过 mode prop 可切到 Split（左右双列 side-by-side）。
    buildSplitDiffLines/buildUnifiedDiffLines 两者都预构建过，切模式只换 :diff-view-mode 绑定值。
    主题跟随 catmax 的 [data-theme]——light/dark 联动。

    语法高亮：用 lowlight 包自带的 highlighter 实例（基于 highlight.js，纯 JS 无 wasm，
    不会触发 CSP 问题）。已注册了 100+ 种语言，直接用。
  -->
  <div v-if="diffFile" class="diff-view-wrapper text-[length:var(--code-text-d1)]">
    <DiffView
      :diff-file="diffFile"
      :diff-view-mode="diffModeEnum"
      :diff-view-theme="theme"
      :diff-view-highlight="true"
      :diff-view-font-size="diffFontSize"
      :register-highlighter="lowlightHighlighter"
    />
  </div>
  <!-- fallback：diffFile 构建失败（数据残缺等极端情况） -->
  <pre
    v-else
    class="font-mono text-[length:var(--code-text-d1)] bg-terminal text-foreground/80 p-3 overflow-x-auto whitespace-pre-wrap"
    >{{ fallbackText }}</pre>
</template>

<script setup lang="ts">
import { DiffFile, generateDiffFile } from '@git-diff-view/file'
// lowlight 包自带已注册的 highlighter 实例——直接 import 用，不用自己 init
import { highlighter as lowlightHighlighter } from '@git-diff-view/lowlight'
import { DiffModeEnum, DiffView } from '@git-diff-view/vue'
import {
  extractFileFromV4Patch,
  parseUnifiedDiffHunks,
  parseV4Patch,
} from '@renderer/lib/codex-patch'
import { useSettingsStore } from '@renderer/stores/settings'
import type { ToolEditInfo } from '@shared/backend/types'
import { DEFAULT_CODE_FONT_SIZE } from '@shared/constants'
import '@git-diff-view/vue/styles/diff-view.css'
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'

const props = withDefaults(
  defineProps<{ edit: ToolEditInfo; mode?: 'unified' | 'split' }>(),
  // 默认 unified：向后兼容现有 ToolCallCard 的调用（不传 mode 时行为不变）
  { mode: 'unified' },
)

/**
 * diff 正文字号。
 *
 * 底层 DiffView 只收数字 prop（它要拿字号算行高和虚拟滚动的行位置），读不到
 * CSS 变量，所以这里从 settings 取——和外层 wrapper 的 --code-text-d1 同一档，
 * 都是「代码字号 - 1」。两边必须一致，否则行号列和内容列会错位。
 */
const settingsStore = useSettingsStore()
const diffFontSize = computed(
  () => (settingsStore.settings?.theme.codeFontSize ?? DEFAULT_CODE_FONT_SIZE) - 1,
)

// mode prop → DiffModeEnum。Split 用库的通用 Split（GitHub 风），SplitGitHub/SplitGitLab 是其变体。
const diffModeEnum = computed(() =>
  props.mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified,
)

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
      // codex：先把 diff 文本原样喂给库（兼容标准 unified diff）。
      file = buildFromUnifiedDiff(edit.filePath, edit.diff, lang)
    }

    if (file) {
      file.initTheme(theme.value)
      file.init()
      file.buildSplitDiffLines()
      file.buildUnifiedDiffLines()
      // unified_diff 兜底：解析后若仍是 0 行（极少见，V4 fallback 也失败的极端情况），
      // 走纯文本 fallback，避免空白假象。
      if (edit.type === 'unified_diff' && file.unifiedLineLength === 0) {
        diffFile.value = null
      } else {
        diffFile.value = file
      }
    } else {
      diffFile.value = null
    }
  } catch (e) {
    console.warn('[DiffView] DiffFile 构建失败', e)
    diffFile.value = null
  }
}

/**
 * unified_diff 专用构建：多级 fallback 保证各种 codex diff 格式都能渲染。
 *
 * 1. 仅当 diff 带 `---`/`+++` 文件头（完整 git diff）时走库的标准直解 `new DiffFile(..., [diff])`。
 *    预判可避免对 codex 的无文件头格式触发库的 "identical / No hunks found" 警告。
 * 2. 标准 unified hunks（无文件头）：codex 的 patch_apply_end 下发的 `unified_diff` 直接以
 *    `@@ -a,b +c,d @@` 开头，缺文件头 → 库重建内容失败。用 parseUnifiedDiffHunks 把 hunks
 *    累积成 old/new 内容，再 generateDiffFile。
 * 3. V4 patch（*** Update File / 裸 @@）：codex apply_patch 工具的格式，用 extractFileFromV4Patch
 *    切出单文件 old/new。
 *
 * 返回未 init 的 DiffFile——由调用方统一 init/build/initTheme（库方法幂等，重复调用安全）。
 */
function buildFromUnifiedDiff(filePath: string, diff: string, lang: string): DiffFile | null {
  // 1. 仅当 diff 含 `---`/`+++` 文件头（完整 git diff）时才走库的标准直解路径。
  //    codex 的两种格式——无文件头的 unified hunks（`@@ -a,b +c,d @@` 开头）和 V4 patch
  //    （`*** Begin Patch`）——直解都会让库重建内容失败，打 "identical / No hunks found"
  //    警告。预判后跳过直解，直接走 resolveOldNewFromDiff，避免噪音。
  if (hasFileHeaders(diff)) {
    const direct = new DiffFile(filePath, '', filePath, '', [diff], lang, lang)
    direct.initTheme(theme.value)
    direct.init()
    direct.buildUnifiedDiffLines()
    if (direct.unifiedLineLength > 0) return direct
  }

  // 2. 无文件头 / 直解失败 → 把 diff 转成 old/new 内容再让库重算
  const parsed = resolveOldNewFromDiff(diff, filePath)
  if (parsed) {
    const oldStr = ensureTrailingNewline(parsed.oldContent)
    const newStr = ensureTrailingNewline(parsed.newContent)
    if (oldStr || newStr) {
      return generateDiffFile(filePath, oldStr, filePath, newStr, lang, lang)
    }
  }
  return null
}

/** diff 是否带 `--- ` / `+++ ` 文件头（完整 git unified diff 才有） */
function hasFileHeaders(diff: string): boolean {
  return /^--- /m.test(diff) && /^\+\+\+ /m.test(diff)
}

/**
 * 从 diff 文本里解析出 old/new 内容（标准 unified hunks 或 V4 patch 任一命中）。
 * change.diff 可能是：单文件的标准 unified hunks、V4 子段、或整段多文件 V4 patch。
 */
function resolveOldNewFromDiff(
  diff: string,
  filePath: string,
): { oldContent: string; newContent: string } | null {
  // 标准 unified hunks（@@ -a,b +c,d @@，无文件头）——codex patch_apply_end 常见格式
  const hunks = parseUnifiedDiffHunks(diff)
  if (hunks) return hunks

  // V4 patch：先按 filePath 从多文件 patch 切，切不到就当单文件子段解析
  const v4 = extractFileFromV4Patch(diff, filePath) ?? parseSingleV4Section(diff)
  return v4
}

/**
 * 把单文件 V4 子段（后端 mapping 已切好的，如 `*** Update File: x.ts\n@@\n...`）直接解析成 old/new。
 * 不依赖 filePath 匹配——子段本身就是单文件，头行带路径但这里不需要再匹配。
 */
function parseSingleV4Section(diff: string): { oldContent: string; newContent: string } | null {
  const wrapped = diff.includes('*** Begin Patch')
    ? diff
    : `*** Begin Patch\n${diff}\n*** End Patch`
  const files = parseV4Patch(wrapped)
  return files.length > 0
    ? { oldContent: files[0]!.oldContent, newContent: files[0]!.newContent }
    : null
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
