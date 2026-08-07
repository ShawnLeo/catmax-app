<template>
  <!-- Backend Install Card: 检测到后端 CLI 未安装时替代干巴巴的 tooltip，给出可操作的入口 -->
  <div class="flex flex-col gap-3 p-4 rounded-md border border-sidebar-border bg-muted/20 max-w-md">
    <div class="flex items-start gap-2">
      <BackendIcon :backend="backendId" class="w-4 h-4 mt-0.5 shrink-0" />
      <div class="flex flex-col gap-1 min-w-0">
        <span class="text-[length:var(--ui-text-base)] font-medium">未检测到 {{ backendId }}</span>
        <span class="text-[length:var(--ui-text-d3)] text-muted-foreground leading-relaxed">
          {{ backendId }} 需要单独安装。可以让 catmax 直接下载官方发布版（下载约 130MB，解压后约
          350MB），装到应用自己的目录，不会污染系统 PATH。
        </span>
      </div>
    </div>

    <!-- 安装中：阶段文案 + 进度条 + 取消 -->
    <div v-if="installing" class="flex flex-col gap-2">
      <div class="flex items-center justify-between text-[length:var(--ui-text-d3)]">
        <span class="text-muted-foreground">{{ phaseLabel }}</span>
        <span v-if="downloadLabel" class="text-muted-foreground tabular-nums">
          {{ downloadLabel }}
        </span>
      </div>
      <!-- 只有下载阶段拿得到确定百分比，其余阶段走不确定态（整条脉冲） -->
      <div class="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          v-if="percent !== null"
          class="h-full bg-primary transition-[width] duration-200"
          :style="{ width: `${percent}%` }"
        />
        <div v-else class="h-full w-full bg-primary/40 animate-pulse" />
      </div>
      <div>
        <Button variant="outline" size="sm" @click="onCancel">取消</Button>
      </div>
    </div>

    <!-- 空闲：主按钮 + 备选路径 -->
    <div v-else class="flex flex-wrap items-center gap-2">
      <Button size="sm" @click="onInstall">一键安装</Button>
      <Button variant="outline" size="sm" @click="emit('pick')">已经装过，手动指定路径</Button>
      <Button variant="ghost" size="sm" @click="showManual = !showManual">
        {{ showManual ? '收起手动安装' : '手动安装' }}
      </Button>
    </div>

    <!-- 失败/取消提示。成功不显示——装好后卡片本身就消失了 -->
    <div
      v-if="failureMessage"
      class="text-[length:var(--ui-text-d3)] px-3 py-2 rounded-md bg-destructive/5 text-destructive"
    >
      {{ failureMessage }}
    </div>
    <div
      v-else-if="progress?.phase === 'cancelled'"
      class="text-[length:var(--ui-text-d3)] px-3 py-2 rounded-md bg-muted text-muted-foreground"
    >
      已取消安装。
    </div>

    <!-- 手动安装命令：一键安装失败时的兜底 -->
    <div v-if="showManual" class="flex flex-col gap-2 text-[length:var(--ui-text-d3)]">
      <p class="text-muted-foreground">在终端里跑其中一条，装完回来点「刷新」：</p>
      <div v-for="cmd in manualCommands" :key="cmd.label" class="flex items-center gap-2">
        <code class="flex-1 px-2 py-1.5 rounded bg-muted font-mono truncate">{{
          cmd.command
        }}</code>
        <Button variant="ghost" size="sm" @click="copy(cmd.command)">
          {{ copiedCommand === cmd.command ? '已复制' : '复制' }}
        </Button>
      </div>
      <Button
        variant="outline"
        size="sm"
        class="self-start"
        :disabled="rescanning"
        @click="onRefresh"
      >
        {{ rescanning ? '检测中…' : '刷新检测' }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import BackendIcon from '@renderer/components/icons/BackendIcon.vue'
import { Button } from '@renderer/components/ui/button'
import { useBackendStore } from '@renderer/stores/backend'
import type { BackendInstallPhase } from '@shared/backend/install'
import type { BackendId } from '@shared/constants'
import { computed, onMounted, ref } from 'vue'

const props = defineProps<{ backendId: BackendId }>()
const emit = defineEmits<{
  /** 用户选择手动指定已有二进制路径——由父组件复用文件选择器 */
  (e: 'pick'): void
  /** 用户手动装完后请求重新检测 */
  (e: 'refresh'): void
}>()

const backendStore = useBackendStore()
const showManual = ref(false)
const copiedCommand = ref<string | null>(null)
const rescanning = ref(false)

// 卡片可能在安装进行中被重新挂载（切页面回来），这里补订阅以免进度断流
onMounted(() => backendStore.ensureInstallSubscription())

const progress = computed(() => backendStore.installProgress[props.backendId] ?? null)
const installing = computed(() => backendStore.isInstalling(props.backendId))

const PHASE_LABELS: Record<BackendInstallPhase, string> = {
  resolving: '正在查询最新版本…',
  downloading: '正在下载…',
  verifying: '正在校验文件完整性…',
  extracting: '正在解压…',
  finalizing: '正在收尾…',
  done: '安装完成',
  error: '安装失败',
  cancelled: '已取消',
}

const phaseLabel = computed(() => {
  const phase = progress.value?.phase
  if (!phase) return '准备中…'
  const version = progress.value?.version
  const label = PHASE_LABELS[phase]
  return version ? `${label}（v${version}）` : label
})

/** 下载阶段的百分比；拿不到 content-length 或不在下载阶段时返回 null（走不确定态） */
const percent = computed<number | null>(() => {
  const p = progress.value
  if (!p || p.phase !== 'downloading' || !p.totalBytes) return null
  return Math.min(100, Math.round((p.receivedBytes / p.totalBytes) * 100))
})

const downloadLabel = computed(() => {
  const p = progress.value
  if (!p || p.phase !== 'downloading' || p.receivedBytes === 0) return null
  const received = formatMB(p.receivedBytes)
  return p.totalBytes ? `${received} / ${formatMB(p.totalBytes)}` : received
})

const failureMessage = computed(() => {
  const p = progress.value
  return p?.phase === 'error' ? (p.error ?? '安装失败') : null
})

const manualCommands = computed(() => {
  const commands = [{ label: 'npm', command: `npm install -g @openai/codex` }]
  if (window.navigator.platform.toLowerCase().includes('mac')) {
    commands.push({ label: 'brew', command: 'brew install codex' })
  }
  return commands
})

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function onInstall(): Promise<void> {
  await backendStore.install(props.backendId)
}

async function onCancel(): Promise<void> {
  await backendStore.cancelInstall(props.backendId)
}

/**
 * 「刷新检测」不只是重新查一遍——先扫一遍 PATH 之外的常见安装位置
 * （Homebrew / npm 全局 / nvm 版本目录等，见 codex-resolver.ts），扫到就直接写进配置。
 * 覆盖"用户在终端手动装完，回来点一下就能被识别到"的场景，不用自己去填路径。
 */
async function onRefresh(): Promise<void> {
  rescanning.value = true
  try {
    if (props.backendId === 'codex') {
      await window.api.backend.rescanCodexPath()
    }
    emit('refresh')
  } finally {
    rescanning.value = false
  }
}

async function copy(command: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(command)
    copiedCommand.value = command
    setTimeout(() => {
      if (copiedCommand.value === command) copiedCommand.value = null
    }, 1500)
  } catch {
    // 剪贴板不可用（无权限）时静默——用户还能手动选中复制
  }
}
</script>
