<template>
  <section class="flex flex-col gap-4">
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
        <Button variant="outline" size="sm" :disabled="picking === 'codex'" @click="pickFile('codex')">
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
        <Button variant="outline" size="sm" :disabled="picking === 'claude'" @click="pickFile('claude')">
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
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useSettingsStore } from '@renderer/stores/settings'
import type { BackendId } from '@shared/constants'
import { computed, ref } from 'vue'

const settings = useSettingsStore()

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
