<template>
  <!-- Unified MCP Server Center: 一条 MCP server。设置页和（后续的）新建会话页 popover
       共用同一行，两处显示的可见性/传输/生效状态必须一模一样，抄两份迟早说法不一致。 -->
  <div class="flex items-start gap-3 rounded-md p-3 hover:bg-muted">
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-2">
        <span
          :class="[
            'font-medium text-[length:var(--ui-text-base)]',
            entry.enabled ? 'text-foreground' : 'text-muted-foreground line-through',
          ]"
        >
          {{ entry.name }}
        </span>

        <!-- 传输类型。stdio/sse/http 三种两端都支持，但 codex 没有判别字段，
             所以 sse 同步过去会塌缩——徽章要显眼，同步时才好解释为什么有警告。 -->
        <span
          class="rounded-full bg-muted/60 px-1.5 py-0.5 font-mono text-[length:var(--ui-text-d3)] text-muted-foreground"
          :title="transportTitle"
        >
          {{ transport }}
        </span>

        <!-- 可见性：这是整个功能的核心信息。运行时状态挂在同一枚徽章上——
             「codex 看得到它」和「codex 里它连上了没有」是同一个问题的两半，
             分成两排徽章反而要用户自己对应。 -->
        <span
          v-for="backend in BACKENDS"
          :key="backend"
          :class="[
            'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[length:var(--ui-text-d3)]',
            entry.visibleTo.includes(backend)
              ? 'bg-muted text-foreground/70'
              : entry.injectedInto.includes(backend)
                ? 'bg-muted text-foreground/70 italic'
                : 'bg-muted/50 text-muted-foreground/60 line-through',
          ]"
          :title="backendTitle(backend)"
        >
          <BackendIcon :backend="backend" class="h-3 w-3" />
          {{ backend }}
          <!-- 注入进去的要跟"用户自己配的"区分开：它只在 catmax 内生效，
               用户在终端里跑同一个后端时看不到。 -->
          <span v-if="entry.injectedInto.includes(backend)" class="opacity-70">补</span>
          <span
            v-if="entry.visibleTo.includes(backend)"
            :class="['h-1.5 w-1.5 rounded-full', RUNTIME_DOT[runtimeStateOf(backend)]]"
          />
          <span v-if="entry.runtime[backend]?.toolCount" class="opacity-70">
            {{ entry.runtime[backend]?.toolCount }} 工具
          </span>
        </span>

        <!-- 只读来源。判据是"一处也改不动"（entry.managed），不是"来自系统层"——
             一个 server 可以同时有系统层定义和用户层覆盖，那时它是可写的。 -->
        <span
          v-if="entry.managed"
          class="rounded-full bg-muted/50 px-1.5 py-0.5 text-[length:var(--ui-text-d3)] text-muted-foreground"
          title="由系统或企业管控层下发，catmax 改不动它——开关、删除、同步都不可用"
        >
          企业下发 · 只读
        </span>

        <!-- 「配置在、但没生效」——这个功能最该避免的撒谎就是把它显示成正常。 -->
        <span
          v-if="ineffective"
          class="rounded-full bg-destructive/15 px-1.5 py-0.5 text-[length:var(--ui-text-d3)] text-destructive"
          :title="ineffective.detail"
        >
          {{ INEFFECTIVE_LABEL[ineffective.reason] }}
        </span>

        <span
          v-if="hasInlineSecret"
          class="rounded-full bg-muted/50 px-1.5 py-0.5 text-[length:var(--ui-text-d3)] text-muted-foreground"
          title="配置里含明文凭据。catmax 只显示掩码，但文件本身是明文——建议改用环境变量引用。"
        >
          含明文凭据
        </span>
      </div>

      <!-- 配置摘要：stdio 显示命令，远程显示 URL。 -->
      <p
        class="mt-1 truncate font-mono text-[length:var(--ui-text-d3)] text-muted-foreground"
        :title="summary"
      >
        {{ summary }}
      </p>

      <!-- 每一处身影单独一行：同一个 server 在两端的配置可能已经漂移，
           把来源摊开显示比合成一条"看起来一致"的摘要诚实。 -->
      <div class="mt-1 flex flex-col gap-0.5">
        <span
          v-for="location in entry.locations"
          :key="`${location.kind}:${location.address}`"
          class="truncate text-[length:var(--ui-text-d3)] text-muted-foreground/80"
          :title="location.filePath ?? '仅在 catmax 注入层中存在，无配置文件'"
        >
          {{ ROOT_LABEL[location.kind] }}
          <template v-if="location.nativeDisabled"> · 已在该处禁用</template>
        </span>
      </div>

      <div v-if="drifted" class="mt-1 text-[length:var(--ui-text-d3)] text-destructive">
        ⚠ 两端配置不一致（同名 server 在不同后端里的写法已经漂移）
      </div>

      <!-- 失败原因逐后端摊开。「连不上」不说为什么等于没说，而两个后端的失败原因
           常常不同（一个环境变量没设、另一个是命令找不到）。 -->
      <div
        v-for="failure in failures"
        :key="failure.backend"
        class="mt-1 truncate text-[length:var(--ui-text-d3)] text-destructive"
        :title="failure.error"
      >
        {{ failure.backend }} 启动失败：{{ failure.error }}
      </div>

      <!-- 描述只存在于运行时 serverInfo 里，配置侧两端都没有这个字段。 -->
      <p
        v-if="runtimeDescription"
        class="mt-1 truncate text-[length:var(--ui-text-d3)] text-muted-foreground"
        :title="runtimeDescription"
      >
        {{ runtimeDescription }}
      </p>

      <div class="mt-2 flex flex-wrap items-center gap-1">
        <!-- needs-trust 是「配置在、codex 永远不加载」，而解法用户自己很难猜到
             （要去 ~/.codex/config.toml 手写 trust_level）。给个按钮，但文案要说清
             信任的是整个项目层，不只是 MCP。 -->
        <Button
          v-if="needsTrust && entry.folderPath"
          variant="outline"
          size="sm"
          :disabled="busy"
          title="在 codex 的用户配置里把该项目标记为 trusted。注意这会同时允许该项目的 .codex/config.toml 注入 hooks 和 exec policies，不只是 MCP。"
          @click="emit('trust', entry.folderPath)"
        >
          信任该项目
        </Button>
        <!-- 「补齐」：把这个 server 注入给看不到它的那个后端。不写用户配置文件，
             关掉即完全恢复——文案要说清是「在 catmax 里」，不然用户会以为终端也生效。 -->
        <Button
          v-for="target in syncTargets"
          :key="`sync-${target}`"
          variant="outline"
          size="sm"
          :disabled="busy"
          :title="`在 catmax 里把它补给 ${target}：不写任何配置文件，只在 catmax 的会话中生效；你在终端里跑 ${target} 时仍然看不到它。`"
          @click="emit('sync', entry, target)"
        >
          在 catmax 里补给 {{ target }}
        </Button>
        <!-- 写入用户配置：终端里也能用，代价是配置（含其中的凭据）被复制到第二个文件。
             做成次要样式并把代价写进 tooltip——它不该看起来和「补齐」一样轻。 -->
        <Button
          v-for="target in syncTargets"
          :key="`write-${target}`"
          variant="ghost"
          size="sm"
          :disabled="busy"
          :title="`把这段配置写进 ${target} 自己的配置文件，终端里跑 ${target} 时也能用。${
            hasInlineSecret ? '⚠️ 这份配置含明文凭据，写入后它会在两个文件里各有一份。' : ''
          }`"
          @click="emit('write', entry, target)"
        >
          写入 {{ target }} 配置
        </Button>
        <!-- 删除只对项目级开放（守卫在 main 侧，这里只是不显示无意义的按钮）。 -->
        <Button
          v-if="canRemove"
          variant="ghost"
          size="sm"
          :disabled="busy"
          class="text-destructive"
          @click="emit('remove', entry)"
        >
          删除
        </Button>
        <Button
          v-for="target in entry.injectedInto"
          :key="`unsync-${target}`"
          variant="ghost"
          size="sm"
          :disabled="busy"
          :title="`撤销注入。${target} 的用户配置文件从没被改过，撤销是干净的。`"
          @click="emit('unsync', entry, target)"
        >
          取消补给 {{ target }}
        </Button>
        <Button
          v-if="hasConfigFile"
          variant="ghost"
          size="sm"
          :disabled="busy"
          @click="emit('reveal', entry)"
        >
          {{ revealLabel }}
        </Button>
      </div>
    </div>

    <!-- 开关。样式与 SkillRow 一致（同一个设置页里两种开关长得不一样很突兀）。
         managed 的条目**不渲染**开关而不是给个灰的——灰开关会让人以为"再点点就能开"，
         而它根本不属于用户。 -->
    <button
      v-if="!entry.managed"
      :class="[
        'relative mt-1 h-6 w-11 shrink-0 rounded-full border-2 shadow-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        busy ? 'cursor-wait opacity-60' : 'cursor-pointer',
        entry.enabled ? 'border-success bg-success' : 'border-foreground/60 bg-muted',
      ]"
      type="button"
      role="switch"
      :aria-checked="entry.enabled"
      :aria-label="`启用 MCP server ${entry.name}`"
      :title="toggleTitle"
      :disabled="busy"
      @click="emit('toggle', entry, !entry.enabled)"
    >
      <span
        :class="[
          'absolute top-0.5 left-0.5 h-4 w-4 rounded-full shadow-md transition-transform',
          entry.enabled ? 'translate-x-5 bg-primary-foreground' : 'bg-foreground',
        ]"
      />
    </button>
  </div>
</template>

<script setup lang="ts">
import BackendIcon from '@renderer/components/icons/BackendIcon.vue'
import { Button } from '@renderer/components/ui/button'
import { BACKEND_IDS, type BackendId } from '@shared/constants'
import type {
  McpEntry,
  McpIneffectiveReason,
  McpRootKind,
  McpRuntimeState,
} from '@shared/mcp/types'
import { configSummary, hasCrossBackendDrift, pickDisplayLocation } from '@shared/mcp/view'
import { computed } from 'vue'

const props = defineProps<{
  entry: McpEntry
  busy: boolean
  platform: string
}>()

const emit = defineEmits<{
  reveal: [entry: McpEntry]
  toggle: [entry: McpEntry, enabled: boolean]
  trust: [folderPath: string]
  sync: [entry: McpEntry, target: BackendId]
  unsync: [entry: McpEntry, target: BackendId]
  write: [entry: McpEntry, target: BackendId]
  remove: [entry: McpEntry]
}>()

const BACKENDS = BACKEND_IDS as readonly BackendId[]

const ROOT_LABEL: Record<McpRootKind, string> = {
  'codex-system': 'codex 系统层 /etc/codex/config.toml',
  'codex-user': 'codex 用户层 ~/.codex/config.toml',
  'codex-project': 'codex 项目层 <repo>/.codex/config.toml',
  'codex-session': 'codex catmax 注入层',
  'claude-managed': 'claude 企业层 managed-mcp.json',
  'claude-user': 'claude 用户层 ~/.claude.json',
  'claude-project': 'claude 项目分桶 ~/.claude.json projects',
  'claude-mcpjson': 'claude 仓库共享 <repo>/.mcp.json',
  'claude-injected': 'claude catmax 注入层',
}

const INEFFECTIVE_LABEL: Record<McpIneffectiveReason, string> = {
  'needs-trust': '未生效 · 需信任项目',
  'needs-approval': '未生效 · 需批准',
  'blocked-by-policy': '未生效 · 企业策略禁止',
}

/**
 * 运行时状态点。
 *
 * `unprobed` 与 `unknown` 必须分开：前者是「还没问过」，后者是「问了，但后端自己
 * 也说不清」（codex 的响应里根本没有状态字段，见 McpRuntimeState 的注释）。
 * 都画成灰色但文案不同——把没问过的显示成「未连接」就是在编。
 */
type RuntimeDisplayState = McpRuntimeState | 'unprobed'

const RUNTIME_DOT: Record<RuntimeDisplayState, string> = {
  connected: 'bg-green-500',
  connecting: 'bg-amber-500',
  failed: 'bg-destructive',
  'needs-auth': 'bg-amber-500',
  disabled: 'bg-muted-foreground/40',
  unknown: 'bg-muted-foreground/40',
  unprobed: 'bg-muted-foreground/25',
}

const RUNTIME_LABEL: Record<RuntimeDisplayState, string> = {
  connected: '已连接',
  connecting: '连接中',
  failed: '启动失败',
  'needs-auth': '需要登录授权',
  disabled: '已禁用',
  unknown: '状态未知（该后端没有提供状态字段）',
  unprobed: '尚未探测运行时状态',
}

function runtimeStateOf(backend: BackendId): RuntimeDisplayState {
  const state = props.entry.runtime[backend]?.state
  if (!state) return 'unprobed'
  // codex 说不清的时候，配置侧往往说得清：`enabled = false` 的 server 照样出现在
  // mcpServerStatus/list 里且 serverInfo 为 null（实测 computer-use 就是），
  // 后端只能回 unknown。配置是直接证据，用它把 unknown 收敛成「已禁用」。
  if (state === 'unknown' && !props.entry.enabled) return 'disabled'
  return state
}

function backendTitle(backend: BackendId): string {
  const injected = props.entry.injectedInto.includes(backend)
  if (!props.entry.visibleTo.includes(backend) && !injected) {
    return `${backend} 的配置里没有这个 server`
  }
  const runtime = props.entry.runtime[backend]
  const parts = [
    injected
      ? `catmax 把它补给了 ${backend}（不在 ${backend} 自己的配置文件里，终端里看不到）`
      : `${backend} 读得到这个 server`,
    RUNTIME_LABEL[runtimeStateOf(backend)],
  ]
  if (runtime?.serverVersion) parts.push(runtime.serverVersion)
  if (runtime?.error) parts.push(runtime.error)
  return parts.join(' · ')
}

const primary = computed(() => pickDisplayLocation(props.entry.locations))
const transport = computed(() => primary.value?.config.transport ?? 'stdio')

const transportTitle = computed(() =>
  transport.value === 'sse'
    ? 'sse 传输。codex 没有传输类型字段，同步到 codex 会塌缩成与 http 相同的写法。'
    : transport.value === 'http'
      ? 'streamable HTTP 远程 MCP'
      : '本地 stdio 子进程',
)

const summary = computed(() => configSummary(primary.value))

/** 取第一条不生效的原因——UI 只需要告诉用户"这里有问题"，详情在 title 里。 */
const ineffective = computed(
  () => props.entry.locations.find((l) => l.ineffective !== null)?.ineffective ?? null,
)

const hasInlineSecret = computed(() => props.entry.locations.some((l) => l.hasInlineSecret))
const hasConfigFile = computed(() => props.entry.locations.some((l) => l.filePath !== null))

/**
 * 跨后端漂移。与 Skill 不同——技能靠软链保证两端一致，MCP 是各自独立的副本，
 * 一定会漂移。只比摘要（命令行 / URL），不比全部字段：超时、env 顺序这些
 * 差异噪音太大，报出来用户也不会去修。
 */
const drifted = computed(() => hasCrossBackendDrift(props.entry))

const failures = computed(() =>
  BACKENDS.flatMap((backend) => {
    const error = props.entry.runtime[backend]?.error
    return error ? [{ backend, error }] : []
  }),
)

/** 取第一个非空的描述——两个后端连的是同一个 server，描述本该一样。 */
const runtimeDescription = computed(
  () => BACKENDS.map((b) => props.entry.runtime[b]?.description).find(Boolean) ?? '',
)

const revealLabel = computed(() =>
  props.platform === 'darwin' ? '在访达中显示' : '在文件管理器中显示',
)

/**
 * 能补给哪些后端：既没在自己配置里配、也还没被注入过的。
 *
 * managed 的排除掉——企业下发的配置连读都只是读，把它复制进另一个后端等于绕过管控。
 */
const syncTargets = computed(() =>
  props.entry.managed
    ? []
    : BACKENDS.filter(
        (b) => !props.entry.visibleTo.includes(b) && !props.entry.injectedInto.includes(b),
      ),
)

/**
 * 能不能删。判据与 main 侧守卫（§10.2）保持一致，这里只是不显示一个必定被拒的按钮——
 * **真正的守卫在 main**，renderer 的判断不作数。
 *
 * `.mcp.json` 里的排除掉：那是团队共享、进版本库的文件，catmax 删它等于替整个团队
 * 做决定，还会在别人的 git 里冒出一个没人解释得清的改动。
 */
const canRemove = computed(
  () =>
    props.entry.scope === 'project' &&
    !props.entry.managed &&
    !props.entry.locations.some((l) => l.kind === 'claude-mcpjson'),
)

const needsTrust = computed(() =>
  props.entry.locations.some((l) => l.ineffective?.reason === 'needs-trust'),
)

/**
 * 开关的 tooltip 必须写清影响范围。
 *
 * 这与 Skill 中心不同：那边 claude 侧的开关只影响 catmax 内的会话，而 MCP 的开关
 * 两端写的都是用户自己的配置文件（codex 的 `enabled` / claude 的
 * `disabledMcpServers`），**终端里跑的 codex 和 claude 也会跟着关**。
 * 不说清楚的话，用户会以为这只是 catmax 的一个显示开关。
 */
const toggleTitle = computed(() => {
  const scope = props.entry.visibleTo.join(' 和 ')
  return props.entry.enabled
    ? `关闭后 ${scope} 都不再加载它——写的是它们各自的配置文件，你在终端里跑这些命令时同样是关的。`
    : `重新启用 ${scope} 对它的加载。`
})
</script>
