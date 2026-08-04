<template>
  <section class="flex flex-col gap-4">
    <header class="flex items-start justify-between gap-3">
      <div>
        <h2 class="text-[length:var(--ui-text-u3)] font-semibold text-foreground">MCP Server</h2>
        <p class="text-[length:var(--ui-text-base)] text-muted-foreground">
          统一查看和开关两个后端的 MCP server。<strong>开关写的是后端各自的配置文件</strong>（codex
          的 <code class="font-mono">enabled</code> / claude 的
          <code class="font-mono">disabledMcpServers</code>），所以你在终端里跑 codex、claude
          时同样生效——这一点和技能中心不同。跨后端同步在后续版本开放。
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <!-- 两个按钮刻意分开：扫盘是毫秒级、离线可用；探测运行时要冷启 claude 握手
             再轮询十几秒（见 mcp.refreshRuntime 的契约注释）。合成一个按钮的话，
             用户每次只想刷新列表都要白等十几秒。 -->
        <Button
          size="sm"
          variant="ghost"
          :disabled="store.runtimeLoading"
          :title="
            store.runtimeProbedAt
              ? `上次探测：${new Date(store.runtimeProbedAt).toLocaleTimeString()}`
              : '向两个后端询问每个 server 连没连上、有几个工具。claude 侧需要冷启一次握手，约十几秒，不消耗 token。'
          "
          @click="store.refreshRuntime()"
        >
          {{ store.runtimeLoading ? '探测中…' : '探测连接状态' }}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          :disabled="store.loading || store.runtimeLoading"
          @click="store.refresh()"
        >
          {{ store.loading ? '扫描中…' : '重新扫描' }}
        </Button>
      </div>
    </header>

    <!-- 写盘失败 / 有损警告。开关是写用户配置文件的操作，失败必须说出来——
         静默失败会变成"我明明关了它，它却还在跑"，而这是最难自查的一类问题。 -->
    <div
      v-if="store.notice"
      :class="[
        'flex items-start justify-between gap-3 rounded-md border p-3 text-[length:var(--ui-text-d3)]',
        store.notice.kind === 'error'
          ? 'border-destructive/40 bg-destructive/10 text-foreground'
          : 'border-border bg-muted/40 text-muted-foreground',
      ]"
    >
      <div class="flex flex-col gap-1">
        <p v-for="line in store.notice.lines" :key="line">{{ line }}</p>
      </div>
      <Button size="sm" variant="ghost" @click="store.notice = null">知道了</Button>
    </div>

    <!-- 有损同步的确认。判据来自 main（要未脱敏的配置才能判），所以只能是两步：
         先拿到 warnings 弹这个，用户点了才带 confirmLossy 重发。 -->
    <div
      v-if="store.pendingLossySync"
      class="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-[length:var(--ui-text-d3)] text-foreground"
    >
      <p>
        把 <strong>{{ store.pendingLossySync.entry.name }}</strong> 补给
        {{ store.pendingLossySync.target }} 会有以下损失：
      </p>
      <p v-for="line in store.pendingLossySync.warnings" :key="line" class="pl-3">· {{ line }}</p>
      <div class="flex gap-1">
        <Button size="sm" variant="outline" @click="store.confirmPendingSync()">仍然继续</Button>
        <Button size="sm" variant="ghost" @click="store.pendingLossySync = null">取消</Button>
      </div>
    </div>

    <!-- 没探测过时说清楚「不知道」，而不是让一排灰点被读成「都没连上」。 -->
    <p
      v-if="!store.runtimeProbedAt && store.entries.length > 0"
      class="rounded-md border border-border bg-muted/40 p-3 text-[length:var(--ui-text-d3)] text-muted-foreground"
    >
      列表来自配置文件扫描，还没有向后端询问过实际连接状态——后端徽章上的灰点表示<strong>未探测</strong>，不是未连接。点「探测连接状态」可以看到每个
      server 在两个后端里是否真的连上、有几个工具。
    </p>

    <!-- 「配置在但没生效」是这个功能最该显眼的一类问题。needs-trust / needs-approval
         的 server 在列表里看得见，用户极易以为它已经在用了——所以顶起一条提示，
         而不是让人在长列表里自己找徽章。 -->
    <p
      v-if="store.ineffectiveServers.length > 0"
      class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-[length:var(--ui-text-d3)] text-foreground"
    >
      有 {{ store.ineffectiveServers.length }} 个 server
      的配置存在、但后端实际不会加载它（需要信任项目或批准
      <code class="font-mono">.mcp.json</code
      >）。这类条目在列表里带红色「未生效」徽章，鼠标悬停可看后端给出的原因。
    </p>

    <!-- 漂移提示。MCP 没有软链可依，两端是独立副本，漂移一定会发生；而它的表现是
         「同一个工具在两个后端里行为不一样」——用户最不会想到来这里找原因，所以顶上来。 -->
    <p
      v-if="store.driftedServers.length > 0"
      class="rounded-md border border-border bg-muted/40 p-3 text-[length:var(--ui-text-d3)] text-muted-foreground"
    >
      有 {{ store.driftedServers.length }} 个 server 在两个后端里的配置已经不一致（<span
        class="font-mono"
        >{{ store.driftedServers.map((e) => e.name).join('、') }}</span
      >）。它们是各自独立的副本，catmax 不会自动拉平——展开每一行可以看到两边分别写的是什么。
    </p>

    <!-- 密钥提示。这里只能提示，不能代劳：把明文改成环境变量引用要用户自己决定
         变量名并去 shell 里设置，catmax 替他做主只会做出一个他不知道的配置。 -->
    <p
      v-if="store.serversWithInlineSecret.length > 0"
      class="rounded-md border border-border bg-muted/40 p-3 text-[length:var(--ui-text-d3)] text-muted-foreground"
    >
      有 {{ store.serversWithInlineSecret.length }} 个 server 的配置里含明文凭据。catmax
      在界面上只显示掩码、也不会把它传给渲染层，但<strong>配置文件本身是明文的</strong>。 codex
      侧可以改用 <code class="font-mono">bearer_token_env_var</code> /
      <code class="font-mono">env_http_headers</code> 存环境变量名来降低暴露面。
    </p>

    <div class="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/20 p-3">
      <Input
        v-model="searchQuery"
        class="min-w-[14rem] flex-1"
        placeholder="搜索 server 名称、命令或 URL"
        aria-label="搜索 MCP server"
      />
      <DropdownMenu
        v-model="backendFilter"
        :options="backendFilterOptions"
        :trigger-width="148"
        title="按后端可见性筛选"
      />
      <DropdownMenu
        v-model="transportFilter"
        :options="transportFilterOptions"
        :trigger-width="148"
        title="按传输类型筛选"
      />
      <DropdownMenu
        v-model="stateFilter"
        :options="stateFilterOptions"
        :trigger-width="148"
        title="按生效状态筛选"
      />
      <span class="text-[length:var(--ui-text-d3)] text-muted-foreground">
        显示 {{ filteredEntries.length }} / {{ store.entries.length }}
      </span>
    </div>

    <div class="flex flex-col gap-2">
      <!-- 只有两个作用域。系统/企业下发的 server 不是第三个抽屉——它们混在「用户」
           里显示，靠行内的「企业下发 · 只读」徽章区分。做成第三个 tab 的话，那个
           tab 下每一行的开关/删除/同步全是灰的，等于给用户看一个点不动的分组。 -->
      <div
        class="grid grid-cols-2 gap-1 rounded-md bg-muted/60 p-1"
        role="tablist"
        aria-label="MCP server 作用域"
      >
        <button
          v-for="tab in TABS"
          :key="tab.value"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.value"
          :class="tabClass(activeTab === tab.value)"
          @click="activeTab = tab.value"
        >
          {{ tab.label }}
          <span class="opacity-70">{{ groups[tab.value].length }}</span>
        </button>
      </div>

      <div role="tabpanel" :aria-label="activeLabel">
        <McpRow
          v-for="entry in groups[activeTab]"
          :key="entry.id"
          :entry="entry"
          :busy="store.busyIds.has(entry.id)"
          :platform="platform"
          @reveal="store.reveal"
          @toggle="store.setEnabled"
          @trust="store.trustProject"
          @sync="store.sync"
          @unsync="store.unsync"
          @write="store.write"
          @remove="store.remove"
        />
        <p
          v-if="groups[activeTab].length === 0"
          class="px-1 py-3 text-[length:var(--ui-text-d3)] text-muted-foreground"
        >
          {{ activeEmpty }}
        </p>
      </div>
    </div>

    <!-- 读不动的配置文件要摊出来。当成"没有 server"处理会让用户以为配置丢了。 -->
    <div v-if="store.issues.length > 0" class="flex flex-col gap-1">
      <h3 class="px-1 text-[length:var(--ui-text-d3)] font-medium text-muted-foreground">
        扫描时跳过的配置文件
      </h3>
      <p
        v-for="issue in store.issues"
        :key="issue.path"
        class="px-1 font-mono text-[length:var(--ui-text-d3)] text-muted-foreground"
      >
        {{ issue.path }} — {{ issue.message }}
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import McpRow from '@renderer/components/mcp/McpRow.vue'
import { Button } from '@renderer/components/ui/button'
import { DropdownMenu, type DropdownOption } from '@renderer/components/ui/dropdown-menu'
import { Input } from '@renderer/components/ui/input'
import { useMcpStore } from '@renderer/stores/mcp'
import { BACKEND_IDS, type BackendId } from '@shared/constants'
import type { McpScope, McpTransport } from '@shared/mcp/types'
import { configSummary, pickDisplayLocation } from '@shared/mcp/view'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const store = useMcpStore()
const platform = ref('')
const searchQuery = ref('')
const activeTab = ref<McpScope>('global')

type BackendFilter = 'all' | BackendId | 'both'
type TransportFilter = 'all' | McpTransport
type StateFilter = 'all' | 'effective' | 'ineffective' | 'disabled'

const backendFilter = ref<BackendFilter>('all')
const transportFilter = ref<TransportFilter>('all')
const stateFilter = ref<StateFilter>('all')

const backendFilterOptions: DropdownOption<BackendFilter>[] = [
  { value: 'all', label: '全部后端' },
  { value: 'codex', label: 'Codex 可见' },
  { value: 'claude', label: 'Claude 可见' },
  { value: 'both', label: '两个后端都可见' },
]
const transportFilterOptions: DropdownOption<TransportFilter>[] = [
  { value: 'all', label: '全部传输类型' },
  { value: 'stdio', label: 'stdio（本地）' },
  { value: 'http', label: 'http（远程）' },
  { value: 'sse', label: 'sse（远程）' },
]
const stateFilterOptions: DropdownOption<StateFilter>[] = [
  { value: 'all', label: '全部状态' },
  { value: 'effective', label: '已生效' },
  { value: 'ineffective', label: '未生效' },
  { value: 'disabled', label: '已关闭' },
]

const TABS: { value: McpScope; label: string }[] = [
  { value: 'global', label: '用户（全局）' },
  { value: 'project', label: '项目（当前工作区）' },
]

let releaseFocusRefresh: (() => void) | null = null

onMounted(async () => {
  // 与技能页同理：用户常常切出去改配置再切回来（`claude mcp add`、手编 config.toml），
  // 不跟着窗口聚焦重扫的话，他会对着一份过期列表判断"到底配没配上"。
  releaseFocusRefresh = store.retainFocusRefresh()
  platform.value = (await window.api.system.platformInfo()).platform
  await store.refresh()
})

onBeforeUnmount(() => {
  releaseFocusRefresh?.()
  releaseFocusRefresh = null
})

const filteredEntries = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase()
  return store.entries.filter((entry) => {
    // 与 McpRow 用同一个取法，否则会出现「搜得到但行里显示的是另一份配置」。
    const primary = pickDisplayLocation(entry.locations)
    const text = `${entry.name} ${configSummary(primary)}`.toLocaleLowerCase()

    const backendMatch =
      backendFilter.value === 'all' ||
      (backendFilter.value === 'both'
        ? entry.visibleTo.length === BACKEND_IDS.length
        : entry.visibleTo.includes(backendFilter.value))

    const transportMatch =
      transportFilter.value === 'all' || primary?.config.transport === transportFilter.value

    const ineffective = entry.locations.some((l) => l.ineffective !== null)
    const stateMatch =
      stateFilter.value === 'all' ||
      (stateFilter.value === 'ineffective'
        ? ineffective
        : stateFilter.value === 'disabled'
          ? !entry.enabled
          : !ineffective && entry.enabled)

    return (!query || text.includes(query)) && backendMatch && transportMatch && stateMatch
  })
})

const groups = computed<Record<McpScope, typeof store.entries>>(() => ({
  global: filteredEntries.value.filter((e) => e.scope === 'global'),
  project: filteredEntries.value.filter((e) => e.scope === 'project'),
}))

const activeLabel = computed(() => TABS.find((t) => t.value === activeTab.value)?.label ?? '')

const activeEmpty = computed(() =>
  activeTab.value === 'global'
    ? '~/.codex/config.toml 和 ~/.claude.json 里都没有 MCP server'
    : '当前工作区的 .codex/config.toml、.mcp.json 和 claude 项目分桶里都没有 MCP server',
)

function tabClass(active: boolean): string {
  return [
    'rounded px-2 py-1.5 text-[length:var(--ui-text-d3)] transition-colors',
    active
      ? 'bg-background text-foreground shadow-sm'
      : 'text-muted-foreground hover:text-foreground',
  ].join(' ')
}
</script>
