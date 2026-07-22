<template>
  <section class="flex flex-col gap-4">
    <header>
      <h2 class="text-lg font-semibold text-foreground">默认后端</h2>
      <p class="text-sm text-muted-foreground">
        新建会话时默认使用的后端。点击历史会话时会自动切换到该会话所属后端。
      </p>
    </header>

    <!-- 默认后端选择器——按钮组，不可用的后端禁用并 tooltip 显示原因 -->
    <div class="grid grid-cols-2 gap-2 max-w-md">
      <button
        v-for="id in BACKEND_IDS"
        :key="id"
        type="button"
        :disabled="!isBackendAvailable(id)"
        :title="backendTooltip(id)"
        :class="[
          'flex items-center gap-2 px-3 py-2 rounded-md border text-sm capitalize transition-colors',
          defaultBackend === id
            ? 'border-primary bg-primary/5 text-foreground'
            : 'border-sidebar-border text-muted-foreground hover:text-foreground hover:bg-muted',
          !isBackendAvailable(id) ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
        ]"
        @click="selectDefault(id)"
      >
        <BackendIcon :backend="id" class="w-4 h-4" />
        {{ id }}
      </button>
    </div>

    <div class="h-px bg-sidebar-border my-1" />

    <header>
      <h2 class="text-lg font-semibold text-foreground">后端 CLI 路径</h2>
      <p class="text-sm text-muted-foreground">
        指定 codex / claude 可执行文件的路径。留空则从系统 PATH 自动查找。
      </p>
    </header>

    <!-- codex -->
    <div class="flex flex-col gap-2">
      <label class="text-sm font-medium">codex 路径</label>
      <div class="flex items-center gap-2">
        <Input
          :model-value="backendPaths.codex ?? ''"
          placeholder="(使用 PATH 中的 codex)"
          class="flex-1"
          @update:model-value="(v: string | number) => updatePath('codex', String(v))"
        />
        <Button
          variant="outline"
          size="sm"
          :disabled="picking === 'codex'"
          @click="pickFile('codex')"
        >
          {{ picking === 'codex' ? '...' : '浏览' }}
        </Button>
      </div>
    </div>

    <!-- claude -->
    <div class="flex flex-col gap-2">
      <label class="text-sm font-medium">claude 路径</label>
      <div class="flex items-center gap-2">
        <Input
          :model-value="backendPaths.claude ?? ''"
          placeholder="(使用 PATH 中的 claude)"
          class="flex-1"
          @update:model-value="(v: string | number) => updatePath('claude', String(v))"
        />
        <Button
          variant="outline"
          size="sm"
          :disabled="picking === 'claude'"
          @click="pickFile('claude')"
        >
          {{ picking === 'claude' ? '...' : '浏览' }}
        </Button>
      </div>
    </div>

    <!-- 状态提示 -->
    <div
      v-if="statusMessage"
      :class="[
        'text-xs px-3 py-2 rounded-md',
        statusKind === 'error'
          ? 'bg-destructive/5 text-destructive'
          : statusKind === 'success'
            ? 'bg-success/5 text-success'
            : 'bg-muted text-muted-foreground',
      ]"
    >
      {{ statusMessage }}
    </div>

    <!-- 重要提示 -->
    <div class="text-xs text-muted-foreground space-y-1 px-3 py-2 bg-muted/30 rounded-md">
      <p>💡 改了路径后会：</p>
      <ul class="list-disc ml-5 space-y-0.5">
        <li>立即应用到 adapter（不重启 catmax）</li>
        <li>自动清掉模型缓存，下次拉取会用新 binary 的 model/list</li>
        <li>codex 是 long-running 进程，已有进程不会重启——切走 codex 再切回来才会重新 spawn</li>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import BackendIcon from '@renderer/components/icons/BackendIcon.vue'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { explainBackendError } from '@renderer/lib/backend-error'
import { useBackendStore } from '@renderer/stores/backend'
import { useSettingsStore } from '@renderer/stores/settings'
import { BACKEND_IDS, type BackendId } from '@shared/constants'
import { computed, onMounted, ref } from 'vue'

const settings = useSettingsStore()
const backendStore = useBackendStore()

const defaultBackend = computed(() => settings.settings?.defaultBackend ?? 'codex')

// 拉一次 backend 状态——判断各后端是否可用（决定选择器按钮可否点）。
// 用户可能直接进设置页（没经过 ChatView 的 refresh），statuses 会是空。
onMounted(() => {
  if (backendStore.statuses.length === 0) {
    void backendStore.refresh()
  }
})

const backendPaths = computed(
  () =>
    settings.settings?.backendPaths ?? {
      codex: null,
      claude: null,
    },
)

const picking = ref<BackendId | null>(null)
const statusMessage = ref<string | null>(null)
const statusKind = ref<'info' | 'success' | 'error'>('info')

function setStatus(msg: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  statusMessage.value = msg
  statusKind.value = kind
}

function backendStatus(id: BackendId) {
  return backendStore.statuses.find((s) => s.id === id)
}

function isBackendAvailable(id: BackendId): boolean {
  return backendStatus(id)?.available ?? false
}

/**
 * 不可用时的 tooltip——简述原因 + 修复指引（复用 backend-error 的解释器）。
 * 可用时显示版本号。
 */
function backendTooltip(id: BackendId): string {
  const status = backendStatus(id)
  if (!status) return id
  if (status.available) return `${id} (${status.version ?? 'unknown'})`
  const info = explainBackendError(status.error)
  let text = `${id} 不可用：${info.title}\n${info.detail}`
  if (info.fix && info.fix.length > 0) {
    text += '\n\n修复步骤：\n' + info.fix.map((s) => `  · ${s}`).join('\n')
  }
  return text
}

async function selectDefault(id: BackendId): Promise<void> {
  if (defaultBackend.value === id) return
  await settings.update({ defaultBackend: id })
  setStatus(`默认后端已设为 ${id}`, 'success')
}

async function updatePath(backend: BackendId, value: string): Promise<void> {
  const next = { ...backendPaths.value, [backend]: value || null }
  await settings.update({ backendPaths: next })
  // 改完不显示 status——用户在 Input 里逐字符输入，每次都弹消息太吵。
  // 只在浏览按钮成功选中文件时显示 status。
}

async function pickFile(backend: BackendId): Promise<void> {
  picking.value = backend
  try {
    const result = await window.api.system.openDialog({
      title: `选择 ${backend} 可执行文件`,
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return
    const filePath = result.filePaths[0]!
    const next = { ...backendPaths.value, [backend]: filePath }
    await settings.update({ backendPaths: next })
    setStatus(`已设置 ${backend} 路径：${filePath}`, 'success')
  } catch (e) {
    setStatus(`选择文件失败：${e instanceof Error ? e.message : String(e)}`, 'error')
  } finally {
    picking.value = null
  }
}
</script>
