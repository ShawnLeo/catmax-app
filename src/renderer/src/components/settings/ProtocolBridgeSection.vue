<template>
  <!-- Protocol Bridge: codex 只会说 Responses 协议，这一节让它能接 Anthropic 等其它协议的上游 -->
  <section class="flex flex-col gap-3">
    <header class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-lg font-semibold text-foreground">协议转换桥</h2>
        <p class="text-sm text-muted-foreground">
          codex 从 0.96 起只支持 Responses 协议（<code>wire_api = "chat"</code> 已被移除）。 开启后
          catmax 在本机起一个只听 127.0.0.1 的转换服务，对 codex 装成 Responses
          端点，对上游说上游的协议。
        </p>
      </div>
      <div class="mt-1 flex shrink-0 items-center gap-2">
        <span :class="['text-xs font-medium', enabled ? 'text-success' : 'text-muted-foreground']">
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

    <template v-if="enabled">
      <!-- 运行状态 -->
      <div class="flex items-center gap-2 text-xs px-3 py-2 rounded-md bg-muted/30">
        <span
          :class="['w-1.5 h-1.5 rounded-full', status?.running ? 'bg-success' : 'bg-destructive']"
        />
        <span class="text-muted-foreground">
          {{ status?.running ? `桥已监听 ${status.baseUrl}` : '桥未运行' }}
        </span>
        <span v-if="status?.lastError" class="text-destructive ml-auto">
          {{ status.lastError }}
        </span>
      </div>

      <!-- 上游预设 -->
      <div class="flex flex-col gap-1.5">
        <label class="text-xs text-muted-foreground">上游</label>
        <DropdownMenu
          :model-value="presetId"
          :options="presetOptions"
          @update:model-value="(v) => applyPreset(String(v))"
        />
        <p v-if="activePreset" class="text-xs text-muted-foreground">
          {{ activePreset.description }}
        </p>
      </div>

      <!-- 上游地址 -->
      <div class="flex flex-col gap-1.5">
        <label class="text-xs text-muted-foreground">上游地址（base URL）</label>
        <Input
          :model-value="upstream.baseUrl"
          placeholder="https://api.deepseek.com/anthropic"
          @update:model-value="(v: string | number) => patchUpstream({ baseUrl: String(v) })"
        />
      </div>

      <!-- 模型名 -->
      <div class="flex flex-col gap-1.5">
        <label class="text-xs text-muted-foreground">
          模型名（留空则透传 codex 请求里的模型名）
        </label>
        <Input
          :model-value="upstream.model ?? ''"
          placeholder="deepseek-v4-pro"
          @update:model-value="(v: string | number) => patchUpstream({ model: String(v) || null })"
        />
      </div>

      <!-- 凭证 -->
      <div class="flex flex-col gap-2">
        <label class="text-xs text-muted-foreground">API key 来源</label>
        <div class="flex gap-2">
          <button
            v-for="option in credentialSources"
            :key="option.value"
            type="button"
            :class="[
              'px-3 py-1.5 rounded-md border text-xs transition-colors cursor-pointer',
              upstream.credentialSource === option.value
                ? 'border-primary bg-primary/5 text-foreground'
                : 'border-sidebar-border text-muted-foreground hover:text-foreground',
            ]"
            @click="patchUpstream({ credentialSource: option.value })"
          >
            {{ option.label }}
          </button>
        </div>

        <!-- 环境变量来源：catmax 一个字节都不落盘 -->
        <template v-if="upstream.credentialSource === 'env'">
          <Input
            :model-value="upstream.credentialEnvVar"
            placeholder="DEEPSEEK_API_KEY"
            @update:model-value="
              (v: string | number) => patchUpstream({ credentialEnvVar: String(v) })
            "
          />
          <p class="text-xs text-muted-foreground">
            catmax 只记住变量名，值在每次请求时从进程环境读取——不落盘。 注意从 Dock/启动台启动的 app
            读不到 shell 里 export 的变量。
          </p>
        </template>

        <!-- 直接保存：唯一会落盘密钥的地方，如实说明 -->
        <template v-else>
          <div class="flex items-center gap-2">
            <Input
              v-model="secretDraft"
              type="password"
              :placeholder="
                status?.credentialReady ? '已保存（重新输入可覆盖）' : '粘贴上游 API key'
              "
              class="flex-1"
            />
            <Button variant="outline" size="sm" :disabled="!secretDraft" @click="saveSecret">
              保存
            </Button>
            <Button
              variant="outline"
              size="sm"
              :disabled="!status?.credentialReady"
              @click="clearSecret"
            >
              清除
            </Button>
          </div>
          <p class="text-xs text-muted-foreground">
            存在 catmax 数据目录下权限 0600 的单独文件里（<b>不进 settings.json</b>），
            界面上永远不会再回显。这是 catmax 里唯一落盘密钥的地方。
          </p>
        </template>
      </div>

      <!-- 连通性自检 -->
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" :disabled="testing" @click="testUpstream">
          {{ testing ? '测试中…' : '测试上游连通性' }}
        </Button>
        <span
          v-if="testResult"
          :class="['text-xs', testResult.ok ? 'text-success' : 'text-destructive']"
        >
          {{ testResult.message }}
        </span>
      </div>

      <!-- 上游能力：影响转换时的降级策略 -->
      <details class="text-xs">
        <summary class="cursor-pointer text-muted-foreground hover:text-foreground">
          上游能力（影响转换时的降级策略）
        </summary>
        <div class="flex flex-col gap-2 mt-2 pl-3 border-l border-sidebar-border">
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              :checked="upstream.capabilities.supportsImages"
              @change="patchCapabilities({ supportsImages: checked($event) })"
            />
            <span>支持图片输入</span>
            <span class="text-muted-foreground">
              关闭时，工具结果里的截图会被替换成占位文字（否则上游直接 400）
            </span>
          </label>
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              :checked="upstream.capabilities.respectsThinkingBudget"
              @change="patchCapabilities({ respectsThinkingBudget: checked($event) })"
            />
            <span>尊重 thinking budget</span>
            <span class="text-muted-foreground">关闭时思考强度档位实际不生效</span>
          </label>
          <div class="flex items-center gap-2">
            <span>max_tokens 兜底值</span>
            <Input
              :model-value="upstream.capabilities.defaultMaxOutputTokens"
              type="number"
              class="w-28"
              @update:model-value="
                (v: string | number) =>
                  patchCapabilities({ defaultMaxOutputTokens: Number(v) || 8192 })
              "
            />
            <span class="text-muted-foreground">Anthropic 要求必填，codex 不一定发</span>
          </div>
        </div>
      </details>

      <div class="text-xs text-muted-foreground px-3 py-2 bg-muted/30 rounded-md space-y-1">
        <p>💡 关于生效方式：</p>
        <ul class="list-disc ml-5 space-y-0.5">
          <li>
            catmax <b>不改你的 <code>~/.codex/config.toml</code></b
            >，而是在 spawn 时用 <code>-c</code> 覆盖 <code>model_provider</code>，关掉桥即完全恢复
          </li>
          <li>codex 拿到的只是桥的一次性 token，<b>上游真 key 从不进 codex 的环境或配置</b></li>
          <li>codex 是 long-running 进程——改完要切走 codex 再切回来才会重新 spawn 生效</li>
        </ul>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { Button } from '@renderer/components/ui/button'
import { DropdownMenu, type DropdownOption } from '@renderer/components/ui/dropdown-menu'
import { Input } from '@renderer/components/ui/input'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  BRIDGE_UPSTREAM_PRESETS,
  bridgeUpstreamPreset,
  type BridgeStatus,
} from '@shared/protocol/bridge-config'
import type { ProtocolBridgeSettings } from '@shared/settings-schema'
import { computed, onMounted, ref } from 'vue'

type Upstream = ProtocolBridgeSettings['upstream']

const settings = useSettingsStore()

const status = ref<BridgeStatus | null>(null)
const secretDraft = ref('')
const testing = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)

const bridge = computed<ProtocolBridgeSettings>(
  () =>
    settings.settings?.protocolBridge ?? {
      enabled: false,
      presetId: 'deepseek',
      upstream: {
        protocol: 'anthropic.messages',
        baseUrl: '',
        model: null,
        credentialSource: 'stored',
        credentialEnvVar: '',
        capabilities: {
          supportsImages: true,
          respectsThinkingBudget: true,
          dropSamplingWhenThinking: true,
          defaultMaxOutputTokens: 8192,
          toolNameMaxLength: 64,
        },
      },
    },
)

const enabled = computed(() => bridge.value.enabled)
const upstream = computed(() => bridge.value.upstream)
const presetId = computed(() => bridge.value.presetId)
const activePreset = computed(() => bridgeUpstreamPreset(presetId.value) ?? null)

const presetOptions = computed<DropdownOption<string>[]>(() =>
  BRIDGE_UPSTREAM_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
)

const credentialSources: Array<{ value: Upstream['credentialSource']; label: string }> = [
  { value: 'stored', label: '直接保存在 catmax' },
  { value: 'env', label: '读环境变量' },
]

function checked(event: Event): boolean {
  return (event.target as HTMLInputElement).checked
}

async function patchBridge(patch: Partial<ProtocolBridgeSettings>): Promise<void> {
  await settings.update({ protocolBridge: { ...bridge.value, ...patch } })
  await refreshStatus()
}

async function patchUpstream(patch: Partial<Upstream>): Promise<void> {
  await patchBridge({ upstream: { ...upstream.value, ...patch } })
}

async function patchCapabilities(patch: Partial<Upstream['capabilities']>): Promise<void> {
  await patchUpstream({ capabilities: { ...upstream.value.capabilities, ...patch } })
}

async function toggleEnabled(): Promise<void> {
  await patchBridge({ enabled: !enabled.value })
}

/** 切预设时把该预设的地址/模型/能力整套灌进去，凭证来源保持用户当前选择 */
async function applyPreset(id: string): Promise<void> {
  const preset = bridgeUpstreamPreset(id)
  if (!preset) return
  await patchBridge({
    presetId: id,
    upstream: {
      ...upstream.value,
      protocol: preset.config.protocol,
      baseUrl: preset.config.baseUrl,
      model: preset.config.model,
      credentialEnvVar: preset.config.credentialEnvVar,
      capabilities: { ...preset.config.capabilities },
    },
  })
}

async function refreshStatus(): Promise<void> {
  status.value = await window.api.backend.bridgeStatus()
}

async function saveSecret(): Promise<void> {
  status.value = await window.api.backend.setBridgeCredential({ secret: secretDraft.value })
  secretDraft.value = ''
  testResult.value = null
}

async function clearSecret(): Promise<void> {
  status.value = await window.api.backend.setBridgeCredential({ secret: '' })
  secretDraft.value = ''
  testResult.value = null
}

async function testUpstream(): Promise<void> {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await window.api.backend.testBridgeUpstream()
  } catch (e) {
    testResult.value = { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    testing.value = false
  }
}

onMounted(refreshStatus)
</script>
