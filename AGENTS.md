# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

> **This file is generated from `CLAUDE.md` and must stay a verbatim copy of it** (only this header
> and the "Other Guidance Files" entries differ). It drifted badly once before — it was three whole
> sections and two years of IPC domains out of date — because it was maintained by hand. If you edit
> `CLAUDE.md`, re-copy it here rather than patching the one section you happened to touch.

## Essential Development Commands

```bash
# Core development
pnpm dev              # Start dev server (HMR + Electron); auto-runs rebuild:native first
pnpm build            # Production build (outputs to out/)
pnpm typecheck        # tsc for main/preload/shared (tsconfig.node.json) + vue-tsc for renderer (tsconfig.web.json)
pnpm lint             # ESLint check
pnpm lint:fix         # ESLint auto-fix
pnpm format           # Prettier formatting

# Testing (IMPORTANT: dual ABI handling required)
pnpm rebuild:node     # Rebuild native modules for Node — REQUIRED before running tests
pnpm test             # Run all tests (vitest, ~66 files under tests/**/*.test.ts and src/**/*.test.ts)
pnpm test:watch       # Watch mode

# Run a single test file / single test
pnpm rebuild:node && npx vitest run tests/backend/turn/per-turn-coordinator.test.ts
pnpm rebuild:node && npx vitest run -t "test name substring"

# Native modules for Electron (auto-run by dev/build, not needed manually)
pnpm rebuild:native   # Rebuild better-sqlite3 + node-pty for Electron ABI

# Packaging
pnpm dist:mac         # macOS dmg (arm64 + x64)
pnpm dist:win         # Windows nsis installer
```

**Critical**: Always run `pnpm rebuild:node` before running tests. `better-sqlite3` and `node-pty` are native modules; Electron and Node use different V8/ABI versions, so the same modules must be recompiled when switching between running the app (Electron ABI) and running vitest (Node ABI). Forgetting this produces native binding errors, not test failures.

## Architecture Overview

### Three-Layer Process Model

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: RENDERER  (Vue3 + Pinia + Tailwind v4)              │
│   Zero business logic — all side-effects via IPC             │
└──────────────────────────┬────────────────────────────────────┘
                           │ Typed IPC (window.api.*)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 2: MAIN  (Node.js + Electron)                          │
│   BackendManager + PerTurnCoordinator + plugin-based adapters│
│   + IPC handlers + services (db/git/pty/settings/...)        │
└──────────────────────────┬────────────────────────────────────┘
                           │ spawn/SDK + newline-delimited JSON
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: BACKEND  (codex app-server JSON-RPC / claude via    │
│   @anthropic-ai/claude-agent-sdk)                             │
└─────────────────────────────────────────────────────────────┘
```

### Key Architectural Principles

**1. Backend Plugin System (not just a bare adapter interface)**

Backends are registered as `MainBackendPlugin`s, not just `AgentBackend` instances:

```ts
interface MainBackendPlugin {
  manifest: BackendPluginManifest // id, displayName, version, blockTypes[], capabilities
  createAdapter: (context: BackendPluginContext) => AgentBackend
  applySettings?: (adapter: AgentBackend, settings: AppSettings) => void
}
```

- `src/main/backend/builtin-plugins.ts` registers the two built-in plugins (`codex`, `claude`) via `src/main/backend/plugin-loader.ts` (`registerMainBackendPlugins`), which is the composition root run before `BackendManager` is constructed. `plugin-registry.ts` validates each manifest (`src/shared/backend/plugin.ts`) and holds the registry.
- `BackendManager` (`src/main/backend/manager.ts`, singleton on `ctx`) iterates registered plugins, calls `plugin.createAdapter(context)`, and enforces at construction time that (a) `adapter.id === plugin.manifest.id`, and (b) every block type the live adapter's `capabilities.chat.blockTypes` reports is a subset of `plugin.manifest.blockTypes` — a plugin can never emit an undeclared block type. The renderer mirrors this with a non-throwing warning (`registerRendererBackendBlocks` in `src/renderer/src/components/chat/blocks/plugin-registry.ts`).
- `BackendPluginContext.onBackendThreadIdResolved` lets an adapter report "this internal placeholder session id now has a real backend-assigned id" (needed because Claude only learns its real `session_id` after the SDK stream starts); `BackendManager` persists this mapping to sqlite.
- `applySettings` is how `settings.backendPaths.<id>` (binary path) and `proxySettingsToEnv(settings.httpProxy)` (see `src/main/backend/proxy-env.ts`) get pushed into a live adapter.
- `src/main/backend/health-check.ts` runs `<binary> --version` to classify backend availability (`not-installed` / `killed-by-os` / `timeout` / `non-zero-exit`) so the UI can explain _why_ a backend is unavailable.

**2. Turn Coordination Is Backend-Agnostic (`PerTurnCoordinator`)**

`src/main/backend/turn/per-turn-coordinator.ts` sits between `BackendManager` and every adapter. It does NOT parse any backend protocol; it guarantees things no adapter can be trusted to provide on its own:

- **Per-session serialization**: turns for the same session queue in a `SessionLane`; different sessions run concurrently.
- **Idle watchdog**: a turn producing no events for 30 min (`DEFAULT_TURN_IDLE_TIMEOUT_MS`) is force-errored.
- **Cooperative cancel + grace**: `cancel()` calls the adapter's `interrupt`, then force-synthesizes a terminal `turn_completed(interrupted)` after a 15s grace period if the adapter never cleanly stops.
- **Checkpointing**: high-frequency delta events are throttled to ~1s persistence; structural events (`turn_started`, `approval_requested`, `error`, `turn_completed`, ...) persist immediately.
- **Exactly-one terminal event guarantee**: even if an adapter's iterator throws or ends silently, exactly one `turn_completed` always fires.
- **Startup recovery**: `recoverInterrupted()` force-marks any turn left `queued`/`running`/`cancelling` from a previous process as `interrupted` (the local CLI/SDK process is gone, so it can never be reconnected).

Persistence goes through the narrow `TurnRunRepository` interface (`turn-run-repository.ts`) — `DatabaseTurnRunRepository` (sqlite) in production, `InMemoryTurnRunRepository` for tests — keeping the coordinator decoupled from storage.

**3. Message Content Model: Blocks + Context Tags**

- **Blocks** (`src/shared/backend/blocks/`): `NormalizedMessage.blocks: ContentBlock[]` is the ordered, backend-agnostic message content model, replacing an older `textBlocks`/`toolBlocks`/`contextBlocks` shape (still read for backward compatibility via `normalize-blocks.ts`'s `messageBlocks()`/`upgradeMessageBlocks()`, which never mutate old data). Base types live in `base.ts` (`TextContentBlock`, `ReasoningContentBlock`, `ToolCallContentBlock`, `ContextContentBlock`, `CompactDividerContentBlock`); backend-specific block types are added via TypeScript module augmentation in `codex.ts` (e.g. `PlanContentBlock`, `CodexActivityContentBlock`) and `claude.ts` (currently a stub — Claude reuses base `tool_call` blocks). `index.ts` assembles the `ContentBlockMap`/`BlockType` union that is the source of truth.
- **Context tags** (`context-tags.ts`, `context-tag-types.ts`, `context-tag-handlers.ts`) are a distinct, narrower concept: IDE-injected markers in raw user text (`<ide_selection>`, `<ide_opened_file>`, `<environment_context>`). `extractContextTags`/`serializeContextTags` are pure functions shared between main (`history-mapping`) and renderer (which wraps them with a richer `ContextTagHandler` in `src/renderer/src/lib/context-tag-registry.ts`) — kept Vue-free so main can import them too.
- See `docs/superpowers/specs/2026-07-25-chat-block-architecture-design.md` for the full design rationale (status: implemented, compat migration period; more backends like "pi agent"/"grok build" are planned to reuse this same block contract).

**4. Type-Safe IPC**

- Handler function signatures are the contract; `src/preload/api.ts` derives `window.api.*` from `src/shared/ipc/<domain>.ts` contracts, so changing a handler signature breaks renderer compilation instead of failing silently at runtime.
- **Never** call `ipcRenderer.invoke` directly in renderer code — always go through `window.api.*`.

**5. Cross-Layer Import Rules (enforced by both ESLint and tsconfig, not just convention)**

```
renderer/  →  Can import: shared/, renderer/, browser-safe packages
              Forbidden (ESLint no-restricted-imports + tsconfig.web.json has no @main/@preload alias):
              electron, node:*, better-sqlite3, @main/*, @preload/*

main/      →  Can import: shared/, main/, electron, node:*, any package
              Forbidden: renderer/

preload/   →  Can import: shared/, electron (contextBridge/ipcRenderer only)

shared/    →  Can import: shared/, type-only packages
              Forbidden: main/, renderer/, preload/, electron, node:*
```

The renderer restriction is enforced twice: an ESLint `overrides` block for `src/renderer/**`, and `tsconfig.web.json` simply not defining `@main`/`@preload` path aliases.

**6. BackendManager Singleton**

- Single instance on `ctx` (`src/main/context.ts`), which also holds `db`, `settingsStore`, and `ptyManager`.
- Routes backend operations, delegates turn lifecycle to `PerTurnCoordinator`, broadcasts `TurnEvent` over IPC (`backend:turnEvent`).
- Sessions always belong to their creating backend (immutable).

## Backend Adapters — Not Structurally Identical

Don't assume both adapters have the same file layout:

- **Codex** (`src/main/backend/codex/`): pure hand-rolled JSON-RPC over a long-lived spawned `codex app-server` process. `protocol.ts` is a business-logic-free framing layer (`LineBuffer` for newline-delimited JSON, `parseFrame` with Zod validation that never throws on bad input, request/response/notification encode/decode). `adapter.ts` handshakes (`initialize`), then per-session `thread/start`, per-turn `turn/start` + `item/*` notification subscription, `turn/interrupt`. `mapping.ts` translates Codex `item`s to blocks; `history-mapping.ts` reconstructs history from rollout files.
  **Threads live in the app-server's process memory.** Whenever that process is replaced — crash, idle eviction, or the `dispose()` + respawn that a Protocol Bridge toggle triggers — every `thread/start`-issued id becomes unknown to the new process, and the next `turn/start` fails with `thread not found: <id>`, which the user experiences as a mid-conversation session that suddenly can't send. The rollout file on disk survives, so `thread/resume` reloads it. Two places must do this and they cover different paths: `getHistory()` resumes before `thread/read` (covers *opening* a history session), and `startTurnRequest()` resumes-and-retries-once on `thread not found` (covers a session that was *already open* when the process changed). Neither subsumes the other.

  **codex reports a failed turn through an `error` *notification*, not through the `turn/start` RPC response** (which returns `ok` first). Dropping that notification is silent failure: `turn/completed` carries only a bare `status`, so the UI shows "message sent, nothing happened" and the user waits out the 60s idle timeout. `translateNotification` handles it — skipping `willRetry: true` (mid-retry "Reconnecting… 1/5"), and unwrapping `error.message`, which is usually a JSON *string* with the human-readable text buried in `detail`.

  **A model belongs to a provider, but catmax stores it per session** — so any provider change desynchronizes them. `resolveTurnModel()` drops a model the current provider doesn't list, falling back to the default; the renderer's `ensureValidModel()` does the same thing but only after `backendStore.models` refreshes, and the gap between a bridge toggle and that refresh is exactly when the user sends the message that fails. With the bridge *on* this layer is unnecessary — `bridge.ts`'s `resolveModel()` already rewrites names the upstream doesn't know. `setModelListProvider()` must therefore invalidate `cachedModelsPromise` whenever it flips between set and null, or the post-toggle list is still the old provider's.

  **A thread's `model_provider` is baked into its rollout, and `thread/resume` restores it — `-c model_provider=` does not override it.** This breaks a bridge toggle in *both* directions, and neither failure names the provider as the cause: a pre-bridge session resumed with the bridge on keeps going straight to ChatGPT (the bridge never sees a request; the visible error is `The '<upstream-model>' model is not supported when using Codex with a ChatGPT account.` — the *model* was swapped but the provider wasn't), and a bridge-era session resumed with the bridge off dies at `failed to load configuration: Model provider \`catmax-bridge\` not found`, after which the thread won't even load. `ThreadResumeParams.modelProvider` is the only override, so every resume passes it explicitly (`CodexAdapter.resumeParams()`): the bridge's id when the bridge is on, otherwise whatever `~/.codex/config.toml` actually resolves to (`readCodexDefaultProvider()`, profile-aware). Never hardcode `openai` for the off case — users customize `model_provider` (e.g. an `openai-custom` that disables WebSockets), and hardcoding silently discards that. `BridgeManager.codexModelProviderId()` and `codexSpawnArgs()` share one predicate so resume can never name a provider the spawn args didn't define.
- **Claude** (`src/main/backend/claude/`): migrated OFF spawning the `claude` CLI and parsing raw stream-json onto `@anthropic-ai/claude-agent-sdk`. The SDK still spawns a bundled claude binary internally, but exposes a typed `SDKMessage` stream and an in-process `canUseTool` callback for permissions — this eliminated the old ApprovalBridge / Unix socket / separate MCP-server subprocess / temp mcp-config machinery (electron.vite.config.ts's main entry used to have a separate `mcp-server` bundle, since deleted). `interrupt` calls the SDK's `query.interrupt()` directly. `sdk-mapping.ts` reuses most translation logic from `mapping.ts` since `SDKMessage` is structurally isomorphic to the old CLI stream-json shapes, just re-typed. Other files: `ask-user-server.ts` (custom `ask_user` MCP tool for clarifying questions), `background-task-state.ts` (subagent/background task tracking), `jsonl-reader.ts` (reads `~/.claude/projects/**/*.jsonl` for history independent of the live SDK connection).

What the two adapters *do* share lives in `src/main/backend/shared/assess-risk.ts` — one `low`/`medium`/`high` classifier over `ApprovalRequest`, called by both, that the approval UI uses to pick the default-focused button and destructive styling. Backend-specific approval shapes get normalized into `ApprovalRequest` first, so risk policy is never duplicated per backend.

When adding a new backend: add to `BackendId` (`src/shared/constants.ts`), create a plugin in the style of `builtin-plugins.ts` with a manifest declaring `blockTypes`, implement `AgentBackend`, register it in `plugin-loader.ts`. The renderer needs a matching entry in `src/renderer/src/backend-plugins/index.ts` that registers block-renderer components — a mismatch degrades to `FallbackBlockView`/`BlockErrorView` per block (warning, not a crash) rather than an app-wide failure.

## IPC Domains

10 domains under `src/main/ipc/domains/` (there is **no `credential` domain**. Backends manage their own auth externally, e.g. `codex login` / `claude login`, and catmax-app only persists the CLI binary path and proxy settings. The `backend.*ConfigFile` handlers let the settings page _edit_ the backends' own config files in place — including `~/.codex/auth.json` — but nothing is copied into catmax's own storage.

**One deliberate exception**: the Protocol Bridge (see below) must hold the upstream provider's API key to forward requests. When the user picks `credentialSource: 'stored'`, that key is written to `userData/bridge-credentials.json` (`{ secrets: { [providerId]: key } }`, keyed by the provider's UUID, atomic rename + `chmod 0600`) by `src/main/service/bridge-credentials.ts` — **never into `settings.json`** (which is `0644`, backed up, and readable wholesale by the renderer). It only ever travels renderer → main; IPC returns `credentialReady: boolean` and never the secret. `credentialSource: 'env'` stores only the env var _name_ and writes nothing to disk):

| Domain      | Purpose                                                                                                                                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend`   | Turn lifecycle (start/interrupt/approvals/agent questions), backend status/switch, models, turn-run listing, one-click install, direct editing of the backends' own local config files (`src/shared/backend/config-files.ts` whitelist → `src/main/service/backend-config-files.ts`), and Protocol Bridge status/credential/self-test |
| `session`   | Chat session create/resume, runtime config snapshot (model/effort/permissionMode/backend)                                                                                                                                                                                                                                             |
| `git`       | Read-only git status/diff/commit info                                                                                                                                                                                                                                                                                                 |
| `fs`        | Filesystem browsing + file preview (text/markdown/table/image/pdf/audio/video/document/archive/binary)                                                                                                                                                                                                                                |
| `pty`       | Terminal process management (create/write/resize/kill + `pty:data` push)                                                                                                                                                                                                                                                              |
| `settings`  | `settings.get` / `update` (patch) / `reset` against the `AppSettings` Zod schema                                                                                                                                                                                                                                                      |
| `system`    | Platform info, native dialogs, system HTTP proxy detection                                                                                                                                                                                                                                                                            |
| `workspace` | Workspace CRUD, per-workspace default editor                                                                                                                                                                                                                                                                                          |
| `skills`    | Unified Skill Center: scan/enable/mirror/migrate/remove/reveal/open. Entries are addressed by `id` (`<scope>:<name>`) only — never by path, same boundary as backend config files                                                                                                                                                        |
| `mcp`       | Unified MCP Server Center: scan/reveal/refreshRuntime/setEnabled/trustProject/sync/unsync/remove. Same `id`-only boundary as `skills` — `trustProject` is the one method taking a path, and it validates that the path belongs to the current workspace — **plus a second boundary: MCP configs routinely hold plaintext credentials, so `McpSnapshot` is redacted in main before it crosses IPC** — the renderer only ever sees `hasInlineSecret: boolean` |

Each domain: contract in `src/shared/ipc/<domain>.ts`, handlers in `src/main/ipc/domains/<domain>/handlers.ts`, registration in `src/main/ipc/domains/<domain>/index.ts`, aggregated in `src/main/ipc/register.ts`, exposed via `src/preload/api.ts`.

**Adding a new IPC method** (6 steps): 1) contract in `src/shared/ipc/<domain>.ts` → 2) implement in `handlers.ts` → 3) register in domain `index.ts` → 4) aggregate in `register.ts` → 5) expose in `src/preload/api.ts` → 6) use via `window.api.<domain>.<method>()`.

## Protocol Bridge (`src/shared/protocol/` + `src/main/protocol/`)

Codex only speaks the OpenAI **Responses** protocol — `wire_api = "chat"` was deprecated 2025-12 and became a hard error 2026-02, and the current config reference states `responses` is the only supported value. To let codex reach upstreams that speak something else, catmax runs a local converting proxy.

```
codex app-server ──Responses──▶ BridgeServer (127.0.0.1:random) ──Anthropic──▶ upstream
```

- **The bridge config is a multi-provider library, not one upstream.** `ProtocolBridgeSettings` is `{ enabled, currentProviderId, providers: Record<id, BridgeProvider> }` (`src/shared/protocol/bridge-config.ts` + `settings-schema.ts`); each `BridgeProvider` is a saved `BridgeUpstreamConfig` plus stable UUID `id`, user-editable `name`, and the `presetId` it was created from (echo-only). Switching upstreams only moves `currentProviderId` — provider entries and their stored secrets are never rewritten, which is why the secret file is keyed by provider id rather than holding a single key. Anything that reads "the bridge upstream" must resolve `providers[currentProviderId]` and handle `currentProviderId === ''` (nothing selected) as bridge-off.
- **IR hub-and-spoke, not pairwise.** `src/shared/protocol/ir.ts` defines a block-centric intermediate representation; each protocol contributes one `ProtocolCodec` (`codec.ts`) with a client half (`decodeRequest` / `createResponseEncoder`) and an upstream half (`encodeRequest` / `createStreamDecoder`). N codecs cover N² pairs — adding `openai.chat` means one new file in `codecs/` plus one line in `registry.ts`, and every existing codec is untouched. Fidelity is protected by `IrRequest.vendor` (verbatim original body, used for same-protocol passthrough) and `IrOpaque` (payloads the target protocol can't express — Anthropic thinking `signature`, Responses `encrypted_content` — carried through and restored).
- **Encoders/decoders are stateful objects, not pure functions** — Responses requires `output_item.added`/`done` pairing and dense `output_index` allocation, which needs cross-event state. `ResponseEncoder.finish()` enforces the same exactly-one-terminal-event invariant `PerTurnCoordinator` does.
- **codex is reconfigured at spawn time, not on disk.** `BridgeManager.codexSpawnArgs()` emits `-c model_provider=...` overrides consumed by `CodexAdapter.setExtraArgs()`; `~/.codex/config.toml` is never touched, so disabling the bridge is a complete revert. codex receives only the bridge's per-boot token via `CATMAX_BRIDGE_TOKEN`; **the real upstream key never enters codex's env or config**.
- **Anything the bridge writes into a response outlives the bridge.** codex persists the response items it receives into the rollout, so `encrypted_content` — the field `IrOpaque` rides in — becomes part of the session's permanent history. Turn the bridge off and codex replays that same history to ChatGPT, which tries to verify a payload only the bridge can read: `The encrypted content for item rs_… could not be verified`, and the session can never send again. Hence `preserveThinkingSignature` defaults to **false**; the only preset enabling it is `anthropic`, where official tool-use turns genuinely require the signature. Without it `anthropic-messages.ts` degrades the thinking block to plain text, so meaning survives. DeepSeek's "signature" measured 36 characters — a marker, not a cryptographic signature — which is why paying the rollout-poisoning cost for it makes no sense. Sessions created before this default flipped stay broken; `codexErrorMessage()` detects that specific error and tells the user to re-enable the bridge or start a new session. The general rule for any future opaque payload: **assume the client persists it and replays it to a different provider.**
- **Upstream quirks are data, not branches** — `UpstreamCapabilities` (`supportsImages`, `dropSamplingWhenThinking`, `defaultMaxOutputTokens`, …) drives downgrade decisions, with per-provider presets in `bridge-config.ts`. Every field must correspond to an actual encode-time branch: a `respectsThinkingBudget` flag was removed because no codec could act on it (`budget_tokens` is mandatory whenever `thinking.type=enabled`, so the bridge must send it regardless of whether the upstream honors it). Upstream facts with no available action — DeepSeek ignoring the budget — belong in the preset `description` shown in settings, not in `UpstreamCapabilities`. Note `upstreamCapabilitiesSchema` is a non-strict `z.object`, so removing a field leaves old `settings.json` files valid (the stale key is stripped).
- **The model list must bypass codex entirely.** codex's `model/list` JSON-RPC returns the ChatGPT catalog **compiled into the codex binary** (`gpt-5.6-sol`, …). It ignores `model_provider` and never requests the provider's `/v1/models` — verified by pointing a codex 0.146 app-server at a live bridge and observing that codex never hit the bridge's `/models` while `model/list` still returned `gpt-*`. So when the bridge is on, `CodexAdapter.setModelListProvider()` (wired in `builtin-plugins.ts`) replaces that list with one fetched from the upstream by `src/main/protocol/upstream-models.ts`; codex is never asked. Consequently `bridge.ts`'s `resolveModel()` only overrides the requested model when it is **not** in the upstream's list, so the model the user picks actually takes effect while codex-invented `gpt-*` ids still get replaced by the configured fallback.
- **The bridge deliberately 404s `GET /models`.** An earlier version hand-forged codex's private `models_cache.json` shape (34 undocumented fields) to quiet codex's models-manager refresh. That schema drifts between codex releases — 0.146 rejects it with ``unknown variant `disabled`, expected `text` or `text_and_image` `` and logs the whole refresh as an ERROR. Serving a response that _fails to decode_ is worse than serving none, and catmax no longer needs codex's catalog at all (see the previous bullet). 404 is the path every third-party provider already takes, so it is codex's best-tested fallback. Do not reintroduce a forged catalog.
- **The models endpoint is not under `baseUrl`.** DeepSeek serves chat at `https://api.deepseek.com/anthropic` but its model list only at the OpenAI-style `https://api.deepseek.com/models` (`/anthropic/models` is a 404) — hence a separate `upstream.modelsUrl` field. Left blank, `candidateModelsUrls()` probes `<origin>/v1/models` then `<origin>/models`, which is what makes configs saved before this field existed keep working. The probe sends Bearer **and** `x-api-key` because the list endpoint's protocol style need not match the chat endpoint's.
- Reference implementation studied when designing this: cc-switch's `src-tauri/src/proxy/providers/`. Design rationale and the Responses/Chat/Anthropic protocol comparison: `docs/superpowers/specs/2026-07-29-protocol-bridge-design.md`.

## Session Persistence: Disk Is Truth, SQLite Is an Index

`src/main/service/schema.sql` is imported as `./schema.sql?raw` and inlined into the bundle at build time — it must never be read from disk at runtime, because the packaged `out/main/` contains only `index.js`. `database.ts`'s `migrate()` just `exec`s that string on boot; it is `CREATE TABLE IF NOT EXISTS` only, with no version tracking, so altering an existing table needs a hand-written guarded `ALTER`. The schema holds `workspaces`, `sessions`, `messages`, `turn_runs`, `deleted_sessions`, `app_state`. The actual conversation content is **not** in sqlite: it lives in the backends' own files (codex rollouts, `~/.claude/projects/**/*.jsonl`) and is re-read on demand by each adapter's `getHistory()`. `messages` only stores previews/counts for list rendering, and `sessions` is a `(backend, backend_thread_id)`-unique index over those files.

Because disk is truth, the two sides drift and `src/main/ipc/domains/session/handlers.ts` reconciles them — with a deliberate asymmetry that is easy to break:

- **`reconcileSessions`** (automatic, on workspace open) syncs db against the current backend's `listSessions()`. It **honors the `deleted_sessions` tombstone**: a session the user deleted is not re-added just because its rollout/jsonl file is still on disk. It also only ever touches the *current* backend's rows, and swallows a failing `listSessions` (an uninstalled codex used to hang the whole workspace open on a 30s `initialize` timeout).
- **`scanImportable` / `importSessions`** (explicit, user-initiated) **ignore the tombstone**, so a deletion stays recoverable by hand.

`removeSession` writes the tombstone *before* attempting to delete the underlying file, so a failed physical delete still can't resurrect the session. Any new code path that adds sessions from disk must decide which of these two semantics it has.

## Renderer Structure Notes

- **Stores** (`src/renderer/src/stores/`, Pinia): `message.ts` (~29KB, the core chat/turn state machine) and `files.ts` (~17KB, file tree/preview state) are the largest and most central. Also: `backend`, `session`, `settings`, `workspace`, `git`, `terminal`, `ui`, `chat-input`, `image-preview`.
- **Composables**: `useTheme`, `useStreamMessage`, `useShortcut`.
- **`components/chat/blocks/`**: mirrors the shared block-type contract — `base/`, `codex/`, `claude/` subfolders plus `registry.ts` (renderer block-type → component map, with `getBlockRenderer` falling back gracefully) and `plugin-registry.ts` (validates renderer registrations against each backend plugin's manifest, warns on gaps).
- **`lib/context-tag-registry.ts`** / **`lib/context-tag-handlers.ts`**: renderer-side wrapper around the shared context-tag extractors, adding a `component` field for rendering.

## Theme System

Three-layer token architecture (`src/renderer/src/assets/styles/themes.css`):

- Layer 1: raw tokens — OKLCH color primitives (neutral gray scale + a small number of intentional accent colors, e.g. purple reserved solely for "max effort" emphasis, blue reserved solely for unread-activity indicators — kept semantically distinct from success/danger green/red)
- Layer 2: semantic tokens (`--background`, `--foreground`, etc.) — components may ONLY reference this layer
- Layer 3: component tokens (optional, for specific component needs)

Switching themes = changing `<html data-theme="dark|light|system|...">`; CSS variables recalculate automatically, no component code changes needed (`src/renderer/src/composables/useTheme.ts`).

## Native Module Handling

`better-sqlite3` and `node-pty` require native compilation, and Electron/Node use different V8 versions:

- `pnpm rebuild:native` — for Electron (auto-run before dev/build)
- `pnpm rebuild:node` — for Node/vitest (run manually before `pnpm test`)

## Testing

- Vitest, `happy-dom` environment, discovers `tests/**/*.test.ts` and `src/**/*.test.ts` (both locations are intentional — co-located tests live alongside stores/lib in `src/renderer/src/`, everything else lives under `tests/{backend,protocol,renderer,shared,ipc,service}/`).
- Tests mock spawned subprocesses/SDK calls — no real CLI dependency needed to run the suite.
- Always `pnpm rebuild:node` first (see Native Module Handling above).
- Path aliases (`@shared`, `@main`, `@renderer`) are declared separately in both `electron.vite.config.ts` and `vitest.config.ts` — keep them in sync manually if adding new aliases.

## Coding Conventions

- Prettier: no semicolons, single quotes, trailing commas, 100-char lines, LF.
- ESLint: grouped + alphabetized imports, type-only imports written inline (`import { type Foo, bar }`), `PascalCase.vue` components, kebab-case service/util filenames (e.g. `settings-store.ts`), `_`-prefixed unused params/vars allowed.
- Comment architectural boundaries and non-obvious state/security/compatibility/fallback logic with searchable feature labels, e.g. `// File Preview Tabs: ...` or `<!-- File Tree Body: ... -->`. Explain intent/invariants, not syntax; keep comments in sync with the code.
- Commits: Conventional Commits (`feat(chat): ...`, `fix(backend): ...`, `refactor: ...`, `chore(lint): ...`), one focused change per commit.
- Before requesting review: `pnpm typecheck`, `pnpm lint`, and relevant tests should pass.
- `Zod` is only for validating untrusted input at boundaries (subprocess messages, disk JSON, HTTP responses) — not for IPC parameters, where TS types already suffice.
- Time values use Unix milliseconds; IDs use UUID v4.

## Important Files to Reference

- `src/shared/backend/types.ts` — `AgentBackend` interface, `TurnEvent`, `NormalizedMessage`
- `src/shared/backend/plugin.ts` — `MainBackendPlugin`/manifest types and validation
- `src/main/backend/manager.ts` — `BackendManager` singleton, plugin/adapter wiring
- `src/main/backend/turn/per-turn-coordinator.ts` — turn queueing/watchdog/cancel/recovery
- `src/main/ipc/typed.ts` — type-safe IPC foundation
- `src/shared/constants.ts` — IPC channels, storage keys, backend IDs
- `src/shared/settings-schema.ts` — `AppSettings` Zod schema

## Design Docs

- `docs/superpowers/specs/2026-07-18-catmax-app-design.md` — original architecture design (process model, adapter abstraction, typed IPC).
- `docs/superpowers/specs/2026-07-25-chat-block-architecture-design.md` — the block/content-model design described above.
- `docs/superpowers/specs/2026-07-29-protocol-bridge-design.md` — Protocol Bridge design and the Responses/Chat/Anthropic protocol comparison.
- `docs/superpowers/specs/2026-08-02-unified-skill-center-design.md` — Unified Skill Center. Load-bearing measured facts: codex natively scans `~/.agents/skills` and `<repo>/.agents/skills`; claude's binary contains no `.agents` string at all, so catmax bridges it with managed symlinks. Disabling is name-keyed because claude's only working mechanism (`settings.skillOverrides`, via the existing flag-tier override) has no path selector — and `Options.managedSettings` and `Options.skills` do **not** work for this (both verified against the bundled claude 2.1.220). `codex app-server generate-ts` dumps the full app-server protocol as TypeScript, which is how the skill RPCs were pinned down. **codex caches its skill list in the app-server process and does not watch the filesystem** — a skill dropped into a scanned root is invisible to `skills/list` until one call passes `forceReload: true`, and no notification fires (measured on 0.145.0). So every catmax path that writes to a skill directory must call `AgentBackend.refreshSkills?.()` afterwards or the running codex keeps serving a stale list while catmax's own UI shows the new one. `skills/changed` is subscribed but is *not* a filesystem signal — the only trigger observed is `skills/extraRoots/set`; the reliable refresh is the renderer rescanning on popover-open, workspace switch, and window refocus.
- `docs/superpowers/specs/2026-08-03-mcp-server-center-design.md` — Unified MCP Server Center. **Do not reuse the Skill Center's assumptions here; five of them were measured false for MCP.** Load-bearing measured facts (codex 0.145.0 / claude 2.1.220): codex MCP is **not** stdio-only — `[mcp_servers.*]` accepts `url` / `bearer_token_env_var` / `http_headers` / `env_http_headers`, and it has **no `type`/`transport` field**, so transport is inferred from `command` vs `url` and claude's `sse` collapses into `http` when synced to codex (lossy, not blocked). codex has a real MCP RPC surface (`mcpServerStatus/list`, `config/mcpServer/reload` for hot reload, `mcpServer/oauth/login`) plus generic `config/value/write` / `config/batchWrite` with `keyPath` + `mergeStrategy` + `expectedVersion` (sha256 optimistic lock) — **never hand-splice its TOML**. codex config is a 7-layer stack (`mdm` / `system` `/etc/codex/config.toml` / `enterpriseManaged` / `user` / `project` `<repo>/.codex/config.toml` / `sessionFlags` / legacy), and the **project layer is trust-gated**: it parses and shows up in `config/read`'s `layers[]` but is not merged unless the user config has `[projects."<abs>"] trust_level = "trusted"` — so a project MCP server can be visible in the list yet never load. On the claude side, `~/.claude.json`'s `projects.<abs>.disabledMcpServers` is a name-keyed disable that covers **every** source (top-level, project bucket, `.mcp.json`) — verified end-to-end through the SDK — so the "can't disable a global server" workaround is unnecessary; `enabled/disabledMcpjsonServers` are *trust* decisions for `.mcp.json`, not switches. `.claude.json` lives at `$CLAUDE_CONFIG_DIR/.claude.json` when that env var is set and `$HOME/.claude.json` otherwise (**not** under `~/.claude/`). Finally, MCP configs routinely contain plaintext credentials, so `mcp-secrets.ts` redacts every `McpLocation.config` inside `mcp-scanner`'s `makeLocation()` — the single chokepoint — before the snapshot crosses IPC.

  **`McpScope` is deliberately only `global | project` — there is no `system` scope.** Enterprise/system layers are another *source* for the same global servers, not a third place a user can put one. Making them a scope splits a name defined in both `/etc/codex/config.toml` and `~/.codex/config.toml` into two entries, one of which is dead (codex's user layer overrides system), and it misstates writability, which is per-location: a server can have a read-only system layer *and* a writable user override. Read-only-ness is `McpEntry.managed = locations.every(l => !MCP_ROOT_META[l.kind].writable)` — that flag, not scope, is the guard every write path (enable/remove/sync) must check. Two consequences in `shared/mcp/view.ts`: the row summary uses `pickDisplayLocation()` (first *writable* location) rather than `locations[0]`, which after the merge may be the overridden system copy; and drift is compared **between backends only** — a system-vs-user difference inside codex is normal layering, not drift.

  **Runtime status (`listMcpRuntime`) is measured, and four things about it are counter-intuitive.** (1) codex's notification is `mcpServer/startupStatus/updated`, *not* `mcpServerStatusUpdated`. (2) `mcpServerStatus/list` has **no status field at all** — connection state is inferred from `serverInfo !== null`, and a `serverInfo: null` entry may be disabled, starting, *or* failed, so it maps to `unknown`, never `failed` (an `enabled = false` server still appears in the list). Real failure reasons arrive only via that notification, which the adapter accumulates and applies to `unknown` entries only. (3) claude connects MCP servers **asynchronously after the handshake** — reading `mcpServerStatus()` once always returns `pending` (measured: all pending at t+3.2s, settled at t+9.2s), so it must poll. (4) codex's `tools` is a **map**, claude's is an **array**. Because the two backends' costs differ by orders of magnitude — codex asks an already-running process, claude needs a fresh handshake plus ~8s of polling — `mcp.refreshRuntime` is a separate IPC method from `mcp.list` and a separate button in the UI; never fold it into the scan, which runs on window focus. `McpEntry.runtime` is keyed **per backend** (the same server can be connected in one and failed in the other), and runtime entries with no matching config entry are dropped on purpose (codex reports a built-in `codex_apps`; this feature manages config, it is not a process monitor).

  **Toggling writes both backends' own config files** — unlike the Skill Center, where the claude side only affects catmax's own sessions, an MCP toggle is visible to `codex`/`claude` in the user's terminal too. catmax's `mcp-state.json` is the source of truth and both backends are projections of it (neither backend's disable mechanism can express the other's), so `setEnabled` writes state *first*, then projects; reversing that loses the user's intent when one side fails. Three measured constraints on the codex write (`config/value/write`, verified in a sandbox `CODEX_HOME`): comments and formatting **are** preserved, so never hand-splice TOML; **`value: null` deletes the key**, which is how re-enabling reverts to no-override; and the server name in `keyPath` **must be quoted** (`mcp_servers."my.server".enabled`) because an unquoted dotted name is parsed as nested tables and codex *writes the broken section before failing validation* — use `tomlKeySegment()`. The write also validates the whole config, so it must target the file where the server is actually defined (`codexWriteTarget()`), never a guessed user `config.toml`. We deliberately **omit `expectedVersion`**: that sha256 lock guards read-modify-write cycles, and a targeted keyPath edit has none — sending it would only make a toggle fail because the user edited their config elsewhere. On the claude side, `mcp-claude-writer.ts` writes `projects.<abs>.disabledMcpServers` as a **full list, not a delta**, via temp-file + rename with an explicit `chmod 0600`, **never backs the file up**, and refuses to write at all if the JSON doesn't parse (rebuilding it would destroy the user's login state and project history).

  **Cross-backend sync defaults to an *injection layer*, not a config-file copy** (`mcp-inject.ts`): codex gets `-c mcp_servers.<name>.*` spawn args (the `sessionFlags` layer, measured to override the user layer), claude gets extra `Options.mcpServers` entries. Nothing is written to any user config file, so turning it off is a complete revert and no credential is ever copied to a second location. `McpState.injected` therefore stores only **names**, never config copies — the source config is re-read at injection time via `scanMcpServersRaw()`, which is deliberately a separate, scary-named export rather than a `scanMcpServers({ redact: false })` flag: **its return value contains plaintext secrets and must never cross IPC.** `McpEntry.injectedInto` is kept separate from `visibleTo` because their reversibility differs — an injected server is not in any config file and is invisible to the backend run from a terminal. Two constraints: codex's `-c` **does not accept quoted keyPath segments** (unlike `config/value/write`), so a server name containing a dot is parsed as nested tables and **codex then fails to start at all** — `canInjectIntoCodex()` is a hard gate, not a best-effort; and because `-c` is a spawn argument, syncing to codex requires `applySettings` (to refresh `extraArgs`) followed by `reconnectBackend`, in that order. claude needs neither — its options are rebuilt per query.

  **`mode: 'write'` copies the config — credentials included — into a second file**, so it is the non-default path and its result always states which file was written (louder when `hasInlineSecret`). Write the server as **one whole section** (`config/value/write` with the object at `mcp_servers."<name>"`): the RPC validates the entire config on every call, so writing field-by-field fails mid-way (`enabled` before `command`/`url` exists → `invalid transport`). Deleting is the same keyPath with `value: null`. Note the asymmetry with Phase 4: `config/value/write` **does** accept quoted keyPath segments, so a dotted server name that `-c` injection must refuse can still be written to the user config — that is the fallback to offer. `removeMcpServer` enforces three guards and refuses wholesale rather than deleting partially: project scope only, every touched file inside the workspace (`isInsideFolder`, so `/a/foo-bar` is not inside `/a/foo`), and **`.mcp.json` is refused outright** — it is team-shared and version-controlled, so deleting it decides for everyone and shows up as an unexplainable diff in someone else's git.
- `docs/superpowers/plans/plan-{1..5}-*[-smoke-test].md` — the phased implementation plan the app was originally built from (foundation → backend/chat → claude/sidebar → git/files/editor → terminal/cmdk → history/packaging/shortcuts).

## Other Guidance Files in This Repo

- `.claude/skills/catmax-conventions/` — the same conventions in Chinese, with deeper `references/` (`architecture.md`, `ipc-pattern.md`, `backend-adapter.md`, `coding-style.md`, `ui-conventions.md`). Consult it for the step-by-step recipes; this file is the map.
- `CLAUDE.md` — the source this file is copied from, read by Claude Code. Edit that one; re-copy here.
- `README.md` — user-facing feature/setup overview, Chinese. Some claims are out of date relative to the code (e.g. it advertises `safeStorage`-encrypted credentials; no `safeStorage` call exists in `src/` — see the credential note under IPC Domains for what actually happens).
