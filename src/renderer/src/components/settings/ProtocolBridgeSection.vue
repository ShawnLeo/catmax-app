<template>
  <!-- Protocol Bridge: codex 只会说 Responses 协议，这一节让它能接 Anthropic 等其它协议的上游 -->
  <section class="flex flex-col gap-3">
    <header class="flex items-start justify-between gap-4">
      <div class="flex items-center gap-1.5">
        <h2 class="text-[length:var(--ui-text-u3)] font-semibold text-foreground">协议转换桥</h2>
        <HelpTooltip>
          codex 从 0.96 起只支持 Responses 协议。开启后 catmax 在本机起一个只听 127.0.0.1
          的转换服务，对 codex 提供 Responses
          端点，并转换为上游协议。可保存多个上游配置，同时只启用一个。
        </HelpTooltip>
      </div>
      <div class="mt-1 flex shrink-0 items-center gap-2">
        <span
          :class="[
            'text-[length:var(--ui-text-d3)] font-medium',
            enabled ? 'text-success' : 'text-muted-foreground',
          ]"
        >
          {{ enabled ? '已开启' : '已关闭' }}
        </span>
        <button
          type="button"
          role="switch"
          :aria-checked="enabled"
          aria-label="启用协议转换桥"
          :class="[
            'relative w-11 h-6 rounded-full border-2 shadow-sm transition-colors cursor-pointer',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            enabled ? 'border-success bg-success' : 'border-foreground/60 bg-muted',
          ]"
          @click="toggleEnabled"
        >
          <span
            :class="[
              'absolute top-0.5 left-0.5 w-4 h-4 rounded-full shadow-md transition-transform',
              enabled ? 'translate-x-5 bg-primary-foreground' : 'bg-foreground',
            ]"
          />
        </button>
      </div>
    </header>

    <!-- 运行状态（仅 enabled 显示） -->
    <div
      v-if="enabled"
      class="flex items-center gap-2 text-[length:var(--ui-text-d3)] px-3 py-2 rounded-md bg-muted/30"
    >
      <span
        :class="['w-1.5 h-1.5 rounded-full', status?.running ? 'bg-success' : 'bg-destructive']"
      />
      <span class="text-muted-foreground">
        {{ status?.running ? `桥已监听 ${status.baseUrl}` : '桥未运行' }}
      </span>
      <span v-if="!currentProvider" class="text-destructive">未选择上游配置</span>
      <span v-if="status?.lastError" class="text-destructive ml-auto">{{ status.lastError }}</span>
    </div>

    <!-- 上游配置只在协议桥开启时显示，关闭时保持设置页简洁 -->
    <div v-if="enabled" class="flex flex-col gap-1.5">
      <label class="text-[length:var(--ui-text-d3)] text-muted-foreground">上游配置</label>
      <div class="flex flex-col gap-1">
        <div
          v-for="p in providerList"
          :key="p.id"
          :class="[
            'flex items-center gap-2 px-3 py-2 rounded-md border text-[length:var(--ui-text-base)] cursor-pointer transition-colors',
            p.id === bridge.currentProviderId
              ? 'border-foreground bg-muted/40'
              : 'border-sidebar-border hover:bg-muted/20',
          ]"
          @click="selectProvider(p.id)"
        >
          <input
            type="radio"
            :checked="p.id === bridge.currentProviderId"
            class="pointer-events-none"
            aria-label="当前启用"
          />
          <span class="flex-1 truncate">{{ p.name || p.baseUrl || '(未命名)' }}</span>
          <span
            v-if="p.id === bridge.currentProviderId"
            class="text-[length:var(--ui-text-d3)] text-success"
            >当前</span
          >
          <span
            v-if="p.modelListMode === 'manual'"
            class="text-[length:var(--ui-text-d3)] text-muted-foreground"
            >手动</span
          >
          <button
            type="button"
            class="text-[length:var(--ui-text-d3)] text-muted-foreground hover:text-destructive px-1"
            title="删除"
            @click.stop="deleteProvider(p.id)"
          >
            🗑
          </button>
        </div>
      </div>
      <DropdownMenu
        :model-value="''"
        :options="presetOptions"
        placeholder="+ 新建配置"
        @update:model-value="(v) => addProvider(String(v))"
      />
    </div>

    <!-- 编辑区（选中 provider 时显示） -->
    <!-- 编辑区：只有点编辑/新增后才显示，右上角可关闭收起 -->
    <div
      v-if="enabled && editingProvider"
      class="flex flex-col gap-3 p-3 rounded-md border border-sidebar-border"
    >
      <!-- 卡片头：标题（当前/编辑中状态）+ 右上角关闭 -->
      <div class="flex items-center gap-2">
        <span class="text-[length:var(--ui-text-base)] font-medium truncate">
          {{ editingProvider.name || editingProvider.baseUrl || '(未命名)' }}
        </span>
        <span
          v-if="editingProvider.id === bridge.currentProviderId"
          class="text-[length:var(--ui-text-d3)] text-success"
        >
          当前启用
        </span>
        <button
          type="button"
          class="ml-auto text-muted-foreground hover:text-foreground text-[length:var(--ui-text-u3)] leading-none px-1"
          title="关闭编辑区"
          aria-label="关闭编辑区"
          @click="closeEditing"
        >
          ×
        </button>
      </div>

      <!-- 名称 -->
      <div class="flex flex-col gap-1.5">
        <label class="text-[length:var(--ui-text-d3)] text-muted-foreground">名称</label>
        <Input
          :model-value="editingProvider.name"
          placeholder="我的 DeepSeek"
          @update:model-value="
            (v: string | number) => patchProvider(editingProvider!.id, { name: String(v) })
          "
        />
      </div>

      <!-- 上游地址 -->
      <div class="flex flex-col gap-1.5">
        <label class="text-[length:var(--ui-text-d3)] text-muted-foreground"
          >上游地址（base URL）</label
        >
        <Input
          :model-value="editingProvider.baseUrl"
          placeholder="https://api.deepseek.com/anthropic"
          @update:model-value="
            (v: string | number) => patchProvider(editingProvider!.id, { baseUrl: String(v) })
          "
        />
      </div>

      <!-- 兜底模型名 -->
      <div class="flex flex-col gap-1.5">
        <div class="flex items-center gap-1.5">
          <label class="text-[length:var(--ui-text-d3)] text-muted-foreground">兜底模型名</label>
          <HelpTooltip>codex 发来的模型名不在上游列表里时使用此模型。</HelpTooltip>
        </div>
        <Input
          :model-value="editingProvider.model ?? ''"
          placeholder="deepseek-v4-pro"
          @update:model-value="
            (v: string | number) => patchProvider(editingProvider!.id, { model: String(v) || null })
          "
        />
      </div>

      <!-- 认证头方案 -->
      <div class="flex flex-col gap-2">
        <div class="flex items-center gap-1.5">
          <label class="text-[length:var(--ui-text-d3)] text-muted-foreground">认证头方案</label>
          <HelpTooltip>
            上游端点要求的认证头风格。x-api-key 是标准 Anthropic；Authorization: Bearer 用于用 token
            认证的 Anthropic 兼容端点（如 catmax.cn）。
          </HelpTooltip>
        </div>
        <div class="flex gap-2">
          <button
            v-for="option in authSchemes"
            :key="option.value"
            type="button"
            :class="[
              'px-3 py-1.5 rounded-md border text-[length:var(--ui-text-d3)] transition-colors cursor-pointer',
              editingProvider.authScheme === option.value
                ? 'border-foreground bg-foreground text-background shadow-sm'
                : 'border-sidebar-border text-muted-foreground hover:text-foreground',
            ]"
            @click="patchProvider(editingProvider!.id, { authScheme: option.value })"
          >
            {{ option.label }}
          </button>
        </div>
      </div>

      <!-- 模型列表来源 -->
      <div class="flex flex-col gap-2">
        <label class="text-[length:var(--ui-text-d3)] text-muted-foreground">模型列表来源</label>
        <div class="flex gap-2">
          <button
            v-for="option in modelListModes"
            :key="option.value"
            type="button"
            :class="[
              'px-3 py-1.5 rounded-md border text-[length:var(--ui-text-d3)] transition-colors cursor-pointer',
              editingProvider.modelListMode === option.value
                ? 'border-foreground bg-foreground text-background shadow-sm'
                : 'border-sidebar-border text-muted-foreground hover:text-foreground',
            ]"
            @click="patchProvider(editingProvider!.id, { modelListMode: option.value })"
          >
            {{ option.label }}
          </button>
        </div>

        <!-- auto: modelsUrl + 拉取按钮 -->
        <template v-if="editingProvider.modelListMode === 'auto'">
          <details class="text-[length:var(--ui-text-d3)]">
            <summary class="cursor-pointer text-muted-foreground hover:text-foreground">
              模型列表地址（留空自动推断）
            </summary>
            <div class="mt-2 pl-3 border-l border-sidebar-border flex flex-col gap-1.5">
              <Input
                :model-value="editingProvider.modelsUrl"
                placeholder="https://api.deepseek.com/models"
                @update:model-value="
                  (v: string | number) =>
                    patchProvider(editingProvider!.id, { modelsUrl: String(v) })
                "
              />
            </div>
          </details>
          <div class="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              :disabled="loadingModels || (enabled && !editingCredentialReady)"
              @click="refreshModels"
            >
              {{ loadingModels ? '拉取中…' : '拉取上游模型列表' }}
            </Button>
            <!-- 桥开着却没填 key：点了只会卡住（回退 codex），提前提示 -->
            <span
              v-if="enabled && !editingCredentialReady"
              class="text-[length:var(--ui-text-d3)] text-muted-foreground"
            >
              先填写 API key 才能拉取上游模型
            </span>
            <!-- 桥没开：拉的是 codex 自己的目录（合法），但提示用户想拉上游得先开桥 -->
            <span
              v-else-if="!enabled"
              class="text-[length:var(--ui-text-d3)] text-muted-foreground"
            >
              开启协议转换桥后拉取的是上游模型；当前拉取的是 codex 自带目录
            </span>
          </div>
          <div v-if="upstreamModels.length > 0" class="flex flex-wrap gap-1.5">
            <button
              v-for="model in upstreamModels"
              :key="model.id"
              type="button"
              :class="[
                'px-2 py-0.5 rounded border text-[length:var(--ui-text-d3)] transition-colors cursor-pointer',
                editingProvider.model === model.id
                  ? 'border-foreground bg-foreground text-background shadow-sm'
                  : 'border-sidebar-border text-muted-foreground hover:text-foreground',
              ]"
              @click="patchProvider(editingProvider!.id, { model: model.id })"
            >
              {{ model.id }}
            </button>
          </div>
          <p v-else-if="modelsError" class="text-[length:var(--ui-text-d3)] text-destructive">
            {{ modelsError }}
          </p>
        </template>

        <!-- manual: 手填列表 -->
        <template v-else>
          <div class="flex items-center gap-2">
            <Input
              v-model="manualModelDraft"
              placeholder="输入模型名，回车添加"
              class="flex-1"
              @keydown.enter.prevent="addManualModel"
            />
            <Button
              variant="outline"
              size="sm"
              :disabled="!manualModelDraft.trim()"
              @click="addManualModel"
            >
              添加
            </Button>
          </div>
          <div v-if="editingProvider.manualModels.length > 0" class="flex flex-wrap gap-1.5">
            <button
              v-for="id in editingProvider.manualModels"
              :key="id"
              type="button"
              :class="[
                'px-2 py-0.5 rounded border text-[length:var(--ui-text-d3)] transition-colors cursor-pointer',
                editingProvider.model === id
                  ? 'border-foreground bg-foreground text-background shadow-sm'
                  : 'border-sidebar-border text-muted-foreground hover:text-foreground',
              ]"
              @click="patchProvider(editingProvider!.id, { model: id })"
            >
              {{ id }} <span class="ml-1 opacity-60" @click.stop="removeManualModel(id)">×</span>
            </button>
          </div>
          <div
            class="flex items-center gap-1.5 text-[length:var(--ui-text-d3)] text-muted-foreground"
          >
            <span>手动模型说明</span>
            <HelpTooltip>手动录入的模型会显示在 codex 下拉框里，选用时原样透传给上游。</HelpTooltip>
          </div>
        </template>
      </div>

      <!-- 凭证 -->
      <div class="flex flex-col gap-2">
        <label class="text-[length:var(--ui-text-d3)] text-muted-foreground">API key 来源</label>
        <div class="flex gap-2">
          <button
            v-for="option in credentialSources"
            :key="option.value"
            type="button"
            :class="[
              'px-3 py-1.5 rounded-md border text-[length:var(--ui-text-d3)] transition-colors cursor-pointer',
              editingProvider.credentialSource === option.value
                ? 'border-foreground bg-foreground text-background shadow-sm'
                : 'border-sidebar-border text-muted-foreground hover:text-foreground',
            ]"
            @click="patchProvider(editingProvider!.id, { credentialSource: option.value })"
          >
            {{ option.label }}
          </button>
        </div>
        <template v-if="editingProvider.credentialSource === 'env'">
          <Input
            :model-value="editingProvider.credentialEnvVar"
            placeholder="DEEPSEEK_API_KEY"
            @update:model-value="
              (v: string | number) =>
                patchProvider(editingProvider!.id, { credentialEnvVar: String(v) })
            "
          />
          <div
            class="flex items-center gap-1.5 text-[length:var(--ui-text-d3)] text-muted-foreground"
          >
            <span>环境变量说明</span>
            <HelpTooltip>catmax 只记住变量名，值在每次请求时从进程环境读取，不落盘。</HelpTooltip>
          </div>
        </template>
        <template v-else>
          <div class="flex items-center gap-2">
            <Input
              v-model="secretDraft"
              type="password"
              :placeholder="
                editingCredentialReady ? '已保存（重新输入可覆盖）' : '粘贴上游 API key'
              "
              class="flex-1"
            />
            <Button variant="outline" size="sm" :disabled="!secretDraft" @click="saveSecret">
              保存
            </Button>
            <Button
              variant="outline"
              size="sm"
              :disabled="!editingCredentialReady"
              @click="clearSecret"
            >
              清除
            </Button>
          </div>
          <div
            class="flex items-center gap-1.5 text-[length:var(--ui-text-d3)] text-muted-foreground"
          >
            <span>凭证存储说明</span>
            <HelpTooltip
              >保存在 catmax 数据目录下权限为 0600 的独立文件中，不写入
              settings.json，界面不会再次回显。</HelpTooltip
            >
          </div>
        </template>
      </div>

      <!-- 连通性自检 -->
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" :disabled="testing" @click="testUpstream">
          {{ testing ? '测试中…' : '测试上游连通性' }}
        </Button>
        <span
          v-if="testResult"
          :class="[
            'text-[length:var(--ui-text-d3)]',
            testResult.ok ? 'text-success' : 'text-destructive',
          ]"
        >
          {{ testResult.message }}
        </span>
      </div>

      <!-- 上游能力 -->
      <details class="text-[length:var(--ui-text-d3)]">
        <summary class="cursor-pointer text-muted-foreground hover:text-foreground">
          上游能力（影响转换时的降级策略）
        </summary>
        <div class="flex flex-col gap-2 mt-2 pl-3 border-l border-sidebar-border">
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              :checked="editingProvider.capabilities.supportsImages"
              @change="
                patchProvider(editingProvider!.id, {
                  capabilities: {
                    ...editingProvider!.capabilities,
                    supportsImages: checked($event),
                  },
                })
              "
            />
            <span>支持图片输入</span>
          </label>
          <!-- Protocol Bridge 思考签名：默认关，开了会让会话在关桥后无法继续 -->
          <label class="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              class="mt-0.5"
              :checked="editingProvider.capabilities.preserveThinkingSignature"
              @change="
                patchProvider(editingProvider!.id, {
                  capabilities: {
                    ...editingProvider!.capabilities,
                    preserveThinkingSignature: checked($event),
                  },
                })
              "
            />
            <span>
              回传思考签名
              <span class="text-muted-foreground">
                —— 开启后签名会被 codex
                永久写进会话历史，导致这些会话在<b>关闭协议桥后无法继续</b>。只有官方 Anthropic
                的工具调用多轮需要它；DeepSeek 等兼容实现不需要，保持关闭即可。
              </span>
            </span>
          </label>
          <div class="flex items-center gap-2">
            <span>max_tokens 兜底值</span>
            <Input
              :model-value="editingProvider.capabilities.defaultMaxOutputTokens"
              type="number"
              class="w-28"
              @update:model-value="
                (v: string | number) =>
                  patchProvider(editingProvider!.id, {
                    capabilities: {
                      ...editingProvider!.capabilities,
                      defaultMaxOutputTokens: Number(v) || 8192,
                    },
                  })
              "
            />
          </div>
        </div>
      </details>
    </div>
  </section>
</template>

<script setup lang="ts">
import HelpTooltip from '@renderer/components/settings/HelpTooltip.vue'
import { Button } from '@renderer/components/ui/button'
import { DropdownMenu, type DropdownOption } from '@renderer/components/ui/dropdown-menu'
import { Input } from '@renderer/components/ui/input'
import { useBackendStore } from '@renderer/stores/backend'
import { useSettingsStore } from '@renderer/stores/settings'
import type { ModelOption } from '@shared/backend/types'
import {
  BRIDGE_UPSTREAM_PRESETS,
  createProviderFromPreset,
  type BridgeProvider,
  type BridgeStatus,
} from '@shared/protocol/bridge-config'
import type { ProtocolBridgeSettings } from '@shared/settings-schema'
import { computed, onMounted, ref } from 'vue'

const settings = useSettingsStore()
const backendStore = useBackendStore()

const status = ref<BridgeStatus | null>(null)
const secretDraft = ref('')
const testing = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)
const upstreamModels = ref<ModelOption[]>([])
const loadingModels = ref(false)
const modelsError = ref<string | null>(null)
/** 当前在编辑区显示哪个 provider（和 currentProviderId 独立） */
const editingProviderId = ref<string | null>(null)
/** 编辑中 provider 的凭证是否已就绪（编辑非当前 provider 时用） */
const editingCredentialReady = ref(false)

const bridge = computed<ProtocolBridgeSettings>(
  () =>
    settings.settings?.protocolBridge ?? { enabled: false, currentProviderId: '', providers: {} },
)
const enabled = computed(() => bridge.value.enabled)
/** 按 createdAt 升序的 provider 列表 */
const providerList = computed<BridgeProvider[]>(() =>
  Object.values(bridge.value.providers).sort((a, b) => a.createdAt - b.createdAt),
)
const currentProvider = computed<BridgeProvider | null>(
  () => bridge.value.providers[bridge.value.currentProviderId] ?? null,
)
const editingProvider = computed<BridgeProvider | null>(() =>
  editingProviderId.value ? (bridge.value.providers[editingProviderId.value] ?? null) : null,
)

const presetOptions = computed<DropdownOption<string>[]>(() =>
  BRIDGE_UPSTREAM_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
)

const credentialSources: Array<{ value: BridgeProvider['credentialSource']; label: string }> = [
  { value: 'stored', label: '直接保存在 catmax' },
  { value: 'env', label: '读环境变量' },
]

const modelListModes: Array<{ value: BridgeProvider['modelListMode']; label: string }> = [
  { value: 'auto', label: '自动获取' },
  { value: 'manual', label: '手动录入' },
]

const authSchemes: Array<{ value: BridgeProvider['authScheme']; label: string }> = [
  { value: 'x-api-key', label: 'x-api-key' },
  { value: 'bearer', label: 'Authorization: Bearer' },
]

function checked(event: Event): boolean {
  return (event.target as HTMLInputElement).checked
}

// —— settings patch 主路 ——
async function patchBridge(patch: Partial<ProtocolBridgeSettings>): Promise<void> {
  await settings.update({ protocolBridge: { ...bridge.value, ...patch } })
  await refreshStatus()
}

/** 改某个 provider 的字段，不动 currentProviderId */
async function patchProvider(providerId: string, patch: Partial<BridgeProvider>): Promise<void> {
  const p = bridge.value.providers[providerId]
  if (!p) return
  await patchBridge({
    providers: { ...bridge.value.providers, [providerId]: { ...p, ...patch } },
  })
}

// —— 列表操作 ——
/**
 * 点列表行：切换为当前启用的 provider + 打开编辑区。
 * 切换 currentProviderId 触发热切换（桥每次请求重读），并刷新模型列表。
 */
async function selectProvider(id: string): Promise<void> {
  await patchBridge({ currentProviderId: id })
  selectEditing(id)
  await refreshModels()
}

function selectEditing(id: string): void {
  editingProviderId.value = id
  secretDraft.value = ''
  testResult.value = null
  void refreshEditingCredentialReady()
}

/** 收起编辑区（不删除数据，只是隐藏表单） */
function closeEditing(): void {
  editingProviderId.value = null
  secretDraft.value = ''
  testResult.value = null
}

async function addProvider(presetId: string): Promise<void> {
  const provider = createProviderFromPreset(presetId)
  await patchBridge({
    providers: { ...bridge.value.providers, [provider.id]: provider },
    currentProviderId: provider.id,
  })
  editingProviderId.value = provider.id
  await refreshModels()
}

async function deleteProvider(id: string): Promise<void> {
  // 先清该 provider 的凭证，再删数据
  await window.api.backend.setBridgeCredential({ providerId: id, secret: '' })
  const nextProviders = { ...bridge.value.providers }
  delete nextProviders[id]
  // 修正 currentProviderId：删的是当前就指向第一个（按 createdAt），否则不动
  let nextCurrent = bridge.value.currentProviderId
  if (nextCurrent === id) {
    const remaining = Object.values(nextProviders).sort((a, b) => a.createdAt - b.createdAt)
    nextCurrent = remaining[0]?.id ?? ''
  }
  await patchBridge({ providers: nextProviders, currentProviderId: nextCurrent })
  if (editingProviderId.value === id) editingProviderId.value = nextCurrent || null
}

// —— 状态刷新 ——
async function refreshStatus(): Promise<void> {
  status.value = await window.api.backend.bridgeStatus()
}

async function refreshEditingCredentialReady(): Promise<void> {
  if (!editingProviderId.value) {
    editingCredentialReady.value = false
    return
  }
  editingCredentialReady.value = await window.api.backend.bridgeCredentialReady({
    providerId: editingProviderId.value,
  })
}

async function refreshModels(): Promise<void> {
  loadingModels.value = true
  modelsError.value = null
  try {
    await backendStore.refreshModelsFor('codex')
    upstreamModels.value = backendStore.modelsByBackend.codex ?? []
    if (upstreamModels.value.length === 0 && enabled.value) {
      modelsError.value = '没有拉到模型，检查地址和 API key'
    }
  } catch (e) {
    upstreamModels.value = []
    modelsError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loadingModels.value = false
  }
}

// —— 凭证（按 editing provider）——
async function saveSecret(): Promise<void> {
  if (!editingProviderId.value) return
  status.value = await window.api.backend.setBridgeCredential({
    providerId: editingProviderId.value,
    secret: secretDraft.value,
  })
  secretDraft.value = ''
  testResult.value = null
  await refreshEditingCredentialReady()
  await refreshModels()
}

async function clearSecret(): Promise<void> {
  if (!editingProviderId.value) return
  status.value = await window.api.backend.setBridgeCredential({
    providerId: editingProviderId.value,
    secret: '',
  })
  secretDraft.value = ''
  testResult.value = null
  await refreshEditingCredentialReady()
}

async function testUpstream(): Promise<void> {
  if (!editingProviderId.value) return
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await window.api.backend.testBridgeUpstream({
      providerId: editingProviderId.value,
    })
  } catch (e) {
    testResult.value = { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    testing.value = false
  }
}

// —— 手填模型维护 ——
const manualModelDraft = ref('')
async function addManualModel(): Promise<void> {
  if (!editingProvider.value) return
  const id = manualModelDraft.value.trim()
  if (!id || editingProvider.value.manualModels.includes(id)) {
    manualModelDraft.value = ''
    return
  }
  await patchProvider(editingProvider.value.id, {
    manualModels: [...editingProvider.value.manualModels, id],
  })
  manualModelDraft.value = ''
}
async function removeManualModel(id: string): Promise<void> {
  if (!editingProvider.value) return
  await patchProvider(editingProvider.value.id, {
    manualModels: editingProvider.value.manualModels.filter((m) => m !== id),
  })
}

async function toggleEnabled(): Promise<void> {
  await patchBridge({ enabled: !enabled.value })
  await refreshModels()
}

onMounted(async () => {
  await refreshStatus()
  if (enabled.value) await refreshModels()
  await refreshEditingCredentialReady()
})
</script>
