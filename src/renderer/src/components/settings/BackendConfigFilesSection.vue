<template>
  <!-- Backend Config Files: 直接编辑后端自己的本地配置文件（不是 catmax 的 settings.json）。 -->
  <section class="flex flex-col gap-3">
    <header>
      <h2 class="text-lg font-semibold text-foreground">后端本地配置文件</h2>
      <p class="text-sm text-muted-foreground">
        直接编辑后端自己的配置文件。catmax 只是编辑器——不保存副本、不保存其中的密钥。
        保存前会校验语法，并把旧内容备份到 catmax 数据目录（保留最近 10 份）。
        下方显示的是上面选中的「默认后端」的配置文件——切换默认后端会显示该后端的文件。
      </p>
    </header>

    <!-- 文件选择器：当前默认后端支持的配置文件各一个按钮，未创建的文件标灰 -->
    <div v-if="files.length > 0" class="flex flex-wrap gap-2">
      <button
        v-for="file in files"
        :key="file.id"
        type="button"
        :title="file.path"
        :class="[
          'flex items-center gap-2 px-3 py-2 rounded-md border text-sm transition-colors cursor-pointer',
          activeId === file.id
            ? 'border-foreground bg-foreground text-background shadow-sm'
            : 'border-sidebar-border text-muted-foreground hover:text-foreground hover:bg-muted',
        ]"
        @click="selectFile(file.id)"
      >
        <BackendIcon :backend="file.backendId" class="w-4 h-4" />
        <span>{{ file.label }}</span>
        <LockIcon v-if="file.sensitive" class="w-3 h-3 opacity-60" />
        <span v-if="!file.exists" class="text-xs opacity-60">未创建</span>
        <span v-else-if="isDirty(file.id)" class="text-xs text-amber-600 dark:text-amber-400">
          ●
        </span>
      </button>
    </div>

    <!-- 白名单里没有这个后端的文件（比如后续新加的后端还没登记） -->
    <p v-else class="text-xs text-muted-foreground px-3 py-2 bg-muted/30 rounded-md">
      catmax 还没有登记 {{ props.backendId }} 的本地配置文件。
    </p>

    <template v-if="activeFile">
      <!-- 路径行：绝对路径 + 在文件夹中显示 + 重新加载 + 文档 -->
      <div class="flex items-center gap-2 text-xs text-muted-foreground">
        <code class="flex-1 truncate font-mono" :title="activeFile.path">{{
          activeFile.path
        }}</code>
        <button class="hover:text-foreground cursor-pointer" title="在文件夹中显示" @click="reveal">
          <FolderOpenIcon class="w-3.5 h-3.5" />
        </button>
        <button
          class="hover:text-foreground cursor-pointer"
          title="放弃修改并重新读取"
          :disabled="loading"
          @click="load(activeFile.id, { force: true })"
        >
          <RotateCcwIcon class="w-3.5 h-3.5" />
        </button>
        <button class="hover:text-foreground cursor-pointer" title="查看官方文档" @click="openDocs">
          <ExternalLinkIcon class="w-3.5 h-3.5" />
        </button>
      </div>

      <p class="text-xs text-muted-foreground">{{ activeFile.description }}</p>

      <!-- 敏感文件门禁：auth.json 含明文密钥，默认不渲染内容，点开才读 -->
      <div
        v-if="activeFile.sensitive && !revealed"
        class="flex flex-col items-start gap-2 p-4 rounded-md border border-dashed border-sidebar-border"
      >
        <div class="flex items-center gap-2 text-sm text-foreground">
          <LockIcon class="w-4 h-4" />
          这个文件里是明文凭证
        </div>
        <p class="text-xs text-muted-foreground">
          点开才会读取并显示内容。改坏会导致 codex 需要重新登录（<code>codex login</code>）。
        </p>
        <Button variant="outline" size="sm" @click="revealSensitive">
          <EyeIcon class="w-3.5 h-3.5" />
          显示并编辑
        </Button>
      </div>

      <template v-else>
        <!-- 编辑器：纯 textarea，等宽字体。不引入代码编辑器依赖——这里是几十行的配置文件。 -->
        <textarea
          v-model="draft"
          spellcheck="false"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          rows="16"
          :disabled="loading"
          class="w-full font-mono text-xs leading-relaxed p-3 rounded-md border border-sidebar-border bg-background text-foreground resize-y focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          :placeholder="loading ? '读取中…' : ''"
          @keydown.meta.s.prevent="save()"
          @keydown.ctrl.s.prevent="save()"
        />

        <!-- 语法校验状态：错误时给出行列，避免用户对着一坨报错找位置 -->
        <div v-if="syntax && !syntax.ok" class="text-xs text-destructive whitespace-pre-wrap">
          {{ formatLocation(syntax) }}{{ syntax.message }}
        </div>
        <div v-else-if="syntax?.ok && isDirty(activeFile.id)" class="text-xs text-success">
          语法校验通过
        </div>

        <!-- 冲突提示：编辑期间文件被后端或外部工具改过，让用户选，不闷头覆盖 -->
        <div
          v-if="conflict"
          class="flex flex-col gap-2 text-xs px-3 py-2 rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-400"
        >
          <span>文件在你编辑期间被外部修改过（可能是后端自己写的）。</span>
          <div class="flex gap-2">
            <Button variant="outline" size="sm" @click="load(activeFile.id, { force: true })">
              丢弃我的修改，重新加载
            </Button>
            <Button variant="destructive" size="sm" @click="save({ force: true })">
              仍然用我的内容覆盖
            </Button>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <Button :disabled="!canSave" @click="save()">
            <SaveIcon class="w-3.5 h-3.5" />
            {{ saving ? '保存中…' : activeFile.exists ? '保存' : '创建文件' }}
          </Button>
          <Button
            variant="outline"
            :disabled="!isDirty(activeFile.id) || saving"
            @click="discard()"
          >
            放弃修改
          </Button>
          <span v-if="statusMessage" :class="['text-xs ml-auto', statusClass]">
            {{ statusMessage }}
          </span>
        </div>

        <div class="text-xs text-muted-foreground px-3 py-2 bg-muted/30 rounded-md space-y-1">
          <p>💡 保存后的生效范围：</p>
          <ul class="list-disc ml-5 space-y-0.5">
            <li v-if="props.backendId === 'codex'">
              codex 是 long-running 进程——已 spawn 的进程读不到新配置，切走 codex 再切回来才会重新
              spawn
            </li>
            <li v-else-if="props.backendId === 'claude'">
              claude 每个 turn 由 SDK 新起进程，下一个 turn 就会读到新配置
            </li>
            <li>
              这里改的是后端自己的全局配置，和上面「默认运行时配置」（catmax 自己的兜底值）互不覆盖
            </li>
          </ul>
        </div>
      </template>
    </template>

    <div
      v-else-if="loadError"
      class="text-xs px-3 py-2 rounded-md bg-destructive/5 text-destructive"
    >
      {{ loadError }}
    </div>
  </section>
</template>

<script setup lang="ts">
import BackendIcon from '@renderer/components/icons/BackendIcon.vue'
import { Button } from '@renderer/components/ui/button'
import type {
  BackendConfigFileContent,
  BackendConfigFileInfo,
  ConfigSyntaxError,
  ConfigSyntaxResult,
} from '@shared/backend/config-files'
import type { BackendId } from '@shared/constants'
import {
  ExternalLinkIcon,
  EyeIcon,
  FolderOpenIcon,
  LockIcon,
  RotateCcwIcon,
  SaveIcon,
} from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/** 每个文件的编辑态。切 tab 不丢草稿——用户可能在两个文件之间来回对照着改。 */
interface FileDraft {
  /** 上次从磁盘读到的那一版（含 mtimeMs 基线，写回时做冲突检测） */
  baseline: BackendConfigFileContent
  draft: string
  syntax: ConfigSyntaxResult | null
}

// 这一节跟着「默认后端」走：只列当前默认后端自己的配置文件，
// 和上面的「默认运行时配置」保持同一个心智模型。
const props = defineProps<{ backendId: BackendId }>()

const allFiles = ref<BackendConfigFileInfo[]>([])
const files = computed(() => allFiles.value.filter((f) => f.backendId === props.backendId))
const activeId = ref<string | null>(null)
const drafts = ref<Record<string, FileDraft>>({})
/** 敏感文件被显式点开过的 id 集合——切走再回来仍需重新确认 */
const revealedIds = ref<string[]>([])

const loading = ref(false)
const saving = ref(false)
const conflict = ref(false)
const loadError = ref<string | null>(null)
const statusMessage = ref<string | null>(null)
const statusKind = ref<'info' | 'success' | 'error'>('info')

const activeFile = computed(() => files.value.find((f) => f.id === activeId.value) ?? null)
const activeDraft = computed(() => (activeId.value ? (drafts.value[activeId.value] ?? null) : null))
const revealed = computed(() => !!activeId.value && revealedIds.value.includes(activeId.value))
const syntax = computed(() => activeDraft.value?.syntax ?? null)

const draft = computed({
  get: () => activeDraft.value?.draft ?? '',
  set: (value: string) => {
    const id = activeId.value
    const current = id ? drafts.value[id] : null
    if (!id || !current) return
    drafts.value = { ...drafts.value, [id]: { ...current, draft: value } }
  },
})

function isDirty(id: string): boolean {
  const state = drafts.value[id]
  if (!state) return false
  return state.draft !== state.baseline.content
}

/**
 * 能否保存：语法必须通过；文件已存在时要有改动；文件还不存在时允许直接把模板落盘。
 */
const canSave = computed(() => {
  const state = activeDraft.value
  if (!state || saving.value || loading.value) return false
  if (state.syntax && !state.syntax.ok) return false
  return isDirty(state.baseline.id) || state.baseline.usingTemplate
})

const statusClass = computed(() =>
  statusKind.value === 'error'
    ? 'text-destructive'
    : statusKind.value === 'success'
      ? 'text-success'
      : 'text-muted-foreground',
)

function setStatus(msg: string | null, kind: 'info' | 'success' | 'error' = 'info'): void {
  statusMessage.value = msg
  statusKind.value = kind
}

function formatLocation(error: ConfigSyntaxError): string {
  if (error.line == null) return ''
  return error.column == null ? `第 ${error.line} 行：` : `第 ${error.line} 行 ${error.column} 列：`
}

async function refreshList(): Promise<void> {
  allFiles.value = await window.api.backend.listConfigFiles()
}

/** 当前选中的文件不属于当前后端时，落到该后端的第一个文件上（没有文件就清空）。 */
async function syncActiveFile(): Promise<void> {
  if (activeId.value && files.value.some((f) => f.id === activeId.value)) return
  const first = files.value[0]
  if (!first) {
    activeId.value = null
    setStatus(null)
    conflict.value = false
    return
  }
  await selectFile(first.id)
}

async function selectFile(id: string): Promise<void> {
  if (activeId.value === id) return
  activeId.value = id
  conflict.value = false
  setStatus(null)
  const file = files.value.find((f) => f.id === id)
  // 敏感文件默认不读——内容压根不进 renderer，直到用户点「显示并编辑」
  if (file?.sensitive && !revealedIds.value.includes(id)) {
    return
  }
  if (!drafts.value[id]) await load(id)
}

async function revealSensitive(): Promise<void> {
  const id = activeId.value
  if (!id) return
  revealedIds.value = [...revealedIds.value, id]
  if (!drafts.value[id]) await load(id)
}

/** 从磁盘读一份新的 baseline。force=true 时连同已有草稿一起丢弃。 */
async function load(id: string, options: { force?: boolean } = {}): Promise<void> {
  loading.value = true
  loadError.value = null
  conflict.value = false
  try {
    const content = await window.api.backend.readConfigFile({ id })
    if (options.force || !drafts.value[id]) {
      drafts.value = {
        ...drafts.value,
        [id]: { baseline: content, draft: content.content, syntax: null },
      }
      if (options.force) setStatus('已重新加载', 'info')
    }
    await refreshList()
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function discard(): void {
  const state = activeDraft.value
  if (!state) return
  drafts.value = {
    ...drafts.value,
    [state.baseline.id]: { ...state, draft: state.baseline.content, syntax: null },
  }
  conflict.value = false
  setStatus(null)
}

async function save(options: { force?: boolean } = {}): Promise<void> {
  const state = activeDraft.value
  if (!state || saving.value) return
  saving.value = true
  conflict.value = false
  try {
    const result = await window.api.backend.writeConfigFile({
      id: state.baseline.id,
      content: state.draft,
      expectedMtimeMs: state.baseline.mtimeMs,
      // exactOptionalPropertyTypes：force 不能显式传 undefined，没勾选就整个字段不带
      ...(options.force ? { force: true } : {}),
    })
    if (result.ok) {
      // 新 baseline = 刚写进去的内容 + 新 mtime，之后的冲突检测从这一版起算
      drafts.value = {
        ...drafts.value,
        [state.baseline.id]: {
          baseline: { ...result.info, content: state.draft, usingTemplate: false },
          draft: state.draft,
          syntax: { ok: true },
        },
      }
      await refreshList()
      setStatus(result.backupPath ? '已保存（旧内容已备份）' : '已保存', 'success')
      return
    }
    if (result.reason === 'invalid-syntax') {
      drafts.value = {
        ...drafts.value,
        [state.baseline.id]: { ...state, syntax: result.syntax },
      }
      setStatus('语法有误，未写入', 'error')
      return
    }
    if (result.reason === 'conflict') {
      conflict.value = true
      setStatus(null)
      return
    }
    setStatus(`保存失败：${result.message}`, 'error')
  } catch (e) {
    setStatus(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'error')
  } finally {
    saving.value = false
  }
}

async function reveal(): Promise<void> {
  if (!activeId.value) return
  try {
    await window.api.backend.revealConfigFile({ id: activeId.value })
  } catch (e) {
    setStatus(`打开失败：${e instanceof Error ? e.message : String(e)}`, 'error')
  }
}

function openDocs(): void {
  if (activeFile.value) void window.api.system.openExternal({ url: activeFile.value.docsUrl })
}

// 实时语法校验：debounce 400ms，走主进程（TOML parser 只在主进程有，
// 保证 UI 的判定和保存时的判定是同一套逻辑，不会出现"UI 说没问题但保存被拒"）。
let validateTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => (activeId.value ? drafts.value[activeId.value]?.draft : undefined),
  (value) => {
    if (validateTimer) clearTimeout(validateTimer)
    const id = activeId.value
    if (!id || value === undefined) return
    validateTimer = setTimeout(async () => {
      const result = await window.api.backend.validateConfigFile({ id, content: value })
      const current = drafts.value[id]
      // 校验期间内容可能又变了——只在还是同一份草稿时落结果
      if (current && current.draft === value) {
        drafts.value = { ...drafts.value, [id]: { ...current, syntax: result } }
      }
    }, 400)
  },
)

onBeforeUnmount(() => {
  if (validateTimer) clearTimeout(validateTimer)
})

// 默认后端切换时换到该后端的配置文件。草稿按文件 id 留着，切回来不丢。
watch(
  () => props.backendId,
  () => void syncActiveFile(),
)

onMounted(async () => {
  await refreshList()
  await syncActiveFile()
})
</script>
