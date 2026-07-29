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
        v-for="id in backendIds"
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
        {{ backendDisplayName(id) }}
      </button>
    </div>

    <!-- Backend Install Card: 未安装的后端给一键安装入口，而不是只在 tooltip 里说"去装" -->
    <BackendInstallCard
      v-for="id in missingBackendIds"
      :key="`install-${id}`"
      :backend-id="id"
      @pick="pickFile(id)"
      @refresh="backendStore.refresh()"
    />

    <div class="h-px bg-sidebar-border my-1" />

    <header>
      <h2 class="text-lg font-semibold text-foreground">默认运行时配置</h2>
      <p class="text-sm text-muted-foreground">
        新建会话时，若没有"上次使用"记录，用这里的默认值兜底。已有 last-used 时优先用 last-used。
        下方显示的是上面选中的「默认后端」对应的配置——切换默认后端会显示该后端的配置。
      </p>
    </header>

    <!-- 当前选中后端的运行时配置——切到 codex/claude 显示对应配置 -->
    <div class="flex flex-col gap-3 p-3 rounded-md border border-sidebar-border max-w-md">
      <div class="flex items-center gap-2">
        <BackendIcon :backend="defaultBackend" class="w-4 h-4" />
        <span class="text-sm font-medium capitalize">{{ defaultBackend }}</span>
        <span
          v-if="backendStore.modelsByBackend[defaultBackend]?.length === 0"
          class="text-xs text-amber-600 dark:text-amber-400 ml-auto"
        >
          模型列表为空（后端未就绪）
        </span>
      </div>

      <!-- 默认模型——从当前 backend 的模型列表动态拿 -->
      <div class="flex flex-col gap-1.5">
        <label class="text-xs text-muted-foreground">默认模型</label>
        <DropdownMenu
          :model-value="defaultRuntimeConfig[defaultBackend]?.model ?? null"
          :options="modelOptionsFor(defaultBackend)"
          :placeholder="'(后端默认)'"
          @update:model-value="(v) => updateRuntimeDefault(defaultBackend, 'model', v)"
        />
      </div>

      <!-- 默认思考强度——从当前 backend capabilities 读支持的档位 -->
      <div class="flex flex-col gap-1.5">
        <label class="text-xs text-muted-foreground">默认思考强度</label>
        <DropdownMenu
          :model-value="defaultRuntimeConfig[defaultBackend]?.effort ?? 'medium'"
          :options="effortOptionsFor(defaultBackend)"
          @update:model-value="(v) => updateRuntimeDefault(defaultBackend, 'effort', v)"
        />
      </div>

      <!-- 默认权限模式——从当前 backend capabilities 读支持的档位 -->
      <div class="flex flex-col gap-1.5">
        <label class="text-xs text-muted-foreground">默认权限模式</label>
        <DropdownMenu
          :model-value="defaultRuntimeConfig[defaultBackend]?.permissionMode ?? 'default'"
          :options="permissionOptionsFor(defaultBackend)"
          @update:model-value="(v) => updateRuntimeDefault(defaultBackend, 'permissionMode', v)"
        />
      </div>
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
import BackendInstallCard from '@renderer/components/settings/BackendInstallCard.vue'
import { Button } from '@renderer/components/ui/button'
import { DropdownMenu, type DropdownOption } from '@renderer/components/ui/dropdown-menu'
import { Input } from '@renderer/components/ui/input'
import { explainBackendError } from '@renderer/lib/backend-error'
import { useBackendStore } from '@renderer/stores/backend'
import { useSettingsStore } from '@renderer/stores/settings'
import { isInstallableBackend } from '@shared/backend/install'
import type { EffortLevel, PermissionMode } from '@shared/backend/types'
import type { BackendId } from '@shared/constants'
import { computed, onMounted, ref } from 'vue'

const settings = useSettingsStore()
const backendStore = useBackendStore()
// 默认后端选择器的展示顺序——claude 在前、codex 在后，未列出的后端按原顺序排在最后
const BACKEND_DISPLAY_ORDER: BackendId[] = ['claude', 'codex']
const backendIds = computed(() =>
  [...backendStore.statuses]
    .sort((a, b) => displayRank(a.id) - displayRank(b.id))
    .map((status) => status.id),
)

function displayRank(id: BackendId): number {
  const index = BACKEND_DISPLAY_ORDER.indexOf(id)
  return index === -1 ? BACKEND_DISPLAY_ORDER.length : index
}

/**
 * 需要展示安装卡片的后端：健康检查明确报 'not-installed'，且该后端支持一键安装。
 * 其它不可用原因（Gatekeeper 拦截、超时…）装一遍也解决不了，交给 tooltip 的修复指引。
 */
const missingBackendIds = computed(() =>
  backendStore.statuses
    .filter((status) => status.error === 'not-installed' && isInstallableBackend(status.id))
    .map((status) => status.id),
)

const defaultBackend = computed(() => settings.settings?.defaultBackend ?? 'codex')

// 默认运行时配置——按 backend 分别配（codex / claude 各一组 model/effort/permissionMode）
const defaultRuntimeConfig = computed(
  () =>
    settings.settings?.defaultRuntimeConfig ?? {
      codex: { model: null, effort: null, permissionMode: null },
      claude: { model: null, effort: null, permissionMode: null },
    },
)

/**
 * 指定 backend 的模型下拉选项——从 modelsByBackend 动态拿，
 * 首项固定为「(后端默认)」对应 null 值（未配置时用后端自身默认）。
 */
function modelOptionsFor(id: BackendId): DropdownOption<string | null>[] {
  const models = backendStore.modelsByBackend[id] ?? []
  return [
    { value: null, label: '(后端默认)' },
    ...models.map((m) => ({ value: m.id, label: m.displayName ?? m.id })),
  ]
}

/**
 * 指定 backend 的 effort 选项——从 capabilities.supportedEfforts 读（前端补 'none'）。
 * codex 3 档 / claude 5 档，各自不同。
 */
function effortOptionsFor(id: BackendId): DropdownOption<EffortLevel>[] {
  const caps = backendStore.statuses.find((s) => s.id === id)?.capabilities
  const supported: EffortLevel[] = caps?.supportedEfforts ?? ['low', 'medium', 'high']
  // 前端补 'none'（关闭思考）——capabilities 不声明，但 UI 统一提供
  const levels: EffortLevel[] = ['none', ...supported]
  return levels.map((e) => ({ value: e, label: effortLabel(e) }))
}

/**
 * 指定 backend 的权限选项——从 capabilities.supportedPermissionModes 读。
 * codex 3 个 / claude 6 个，各自不同。
 */
function permissionOptionsFor(id: BackendId): DropdownOption<PermissionMode>[] {
  const caps = backendStore.statuses.find((s) => s.id === id)?.capabilities
  const supported: PermissionMode[] = caps?.supportedPermissionModes ?? [
    'default',
    'acceptEdits',
    'bypassPermissions',
  ]
  return supported.map((m) => ({ value: m, label: permissionLabel(m) }))
}

function effortLabel(e: EffortLevel): string {
  return {
    none: '关闭',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '超高',
    max: '最高',
  }[e]
}

function permissionLabel(m: PermissionMode): string {
  return {
    default: '每次问',
    acceptEdits: '自动接受编辑',
    auto: '自动',
    plan: '计划模式',
    dontAsk: '不问',
    bypassPermissions: '完全跳过权限',
  }[m]
}

/** 更新指定 backend 的某个默认运行时配置字段 */
async function updateRuntimeDefault(
  backend: BackendId,
  field: 'model' | 'effort' | 'permissionMode',
  value: string | null,
): Promise<void> {
  const current = defaultRuntimeConfig.value[backend] ?? {
    model: null,
    effort: null,
    permissionMode: null,
  }
  const next = {
    ...defaultRuntimeConfig.value,
    [backend]: { ...current, [field]: value },
  }
  await settings.update({ defaultRuntimeConfig: next })
}

// 拉一次 backend 状态 + 两个 backend 的模型列表。
// 用户可能直接进设置页（没经过 ChatView 的 refresh），statuses 会是空。
// 模型列表用于默认模型下拉——codex 首次会 spawn app-server，失败时下拉显示空。
onMounted(async () => {
  if (backendStore.statuses.length === 0) {
    await backendStore.refresh()
  }
  await backendStore.loadAllBackendModels()
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

function backendDisplayName(id: BackendId): string {
  return backendStatus(id)?.displayName ?? id
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
