# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
pnpm test             # Run all tests (vitest, ~47 files under tests/**/*.test.ts and src/**/*.test.ts)
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
- **Claude** (`src/main/backend/claude/`): migrated OFF spawning the `claude` CLI and parsing raw stream-json onto `@anthropic-ai/claude-agent-sdk`. The SDK still spawns a bundled claude binary internally, but exposes a typed `SDKMessage` stream and an in-process `canUseTool` callback for permissions — this eliminated the old ApprovalBridge / Unix socket / separate MCP-server subprocess / temp mcp-config machinery (electron.vite.config.ts's main entry used to have a separate `mcp-server` bundle, since deleted). `interrupt` calls the SDK's `query.interrupt()` directly. `sdk-mapping.ts` reuses most translation logic from `mapping.ts` since `SDKMessage` is structurally isomorphic to the old CLI stream-json shapes, just re-typed. Other files: `ask-user-server.ts` (custom `ask_user` MCP tool for clarifying questions), `background-task-state.ts` (subagent/background task tracking), `jsonl-reader.ts` (reads `~/.claude/projects/**/*.jsonl` for history independent of the live SDK connection).

When adding a new backend: add to `BackendId` (`src/shared/constants.ts`), create a plugin in the style of `builtin-plugins.ts` with a manifest declaring `blockTypes`, implement `AgentBackend`, register it in `plugin-loader.ts`. The renderer needs a matching entry in `src/renderer/src/backend-plugins/index.ts` that registers block-renderer components — a mismatch degrades to `FallbackBlockView`/`BlockErrorView` per block (warning, not a crash) rather than an app-wide failure.

## IPC Domains

8 domains under `src/main/ipc/domains/` (there is **no `credential` domain**. Backends manage their own auth externally, e.g. `codex login` / `claude login`, and catmax-app only persists the CLI binary path and proxy settings. The `backend.*ConfigFile` handlers let the settings page _edit_ the backends' own config files in place — including `~/.codex/auth.json` — but nothing is copied into catmax's own storage.

**One deliberate exception**: the Protocol Bridge (see below) must hold the upstream provider's API key to forward requests. When the user picks `credentialSource: 'stored'`, that key is written to `userData/bridge-credentials.json` with mode `0600` by `src/main/service/bridge-credentials.ts` — **never into `settings.json`** (which is `0644`, backed up, and readable wholesale by the renderer). It only ever travels renderer → main; IPC returns `credentialReady: boolean` and never the secret. `credentialSource: 'env'` stores only the env var _name_ and writes nothing to disk):

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

Each domain: contract in `src/shared/ipc/<domain>.ts`, handlers in `src/main/ipc/domains/<domain>/handlers.ts`, registration in `src/main/ipc/domains/<domain>/index.ts`, aggregated in `src/main/ipc/register.ts`, exposed via `src/preload/api.ts`.

**Adding a new IPC method** (6 steps): 1) contract in `src/shared/ipc/<domain>.ts` → 2) implement in `handlers.ts` → 3) register in domain `index.ts` → 4) aggregate in `register.ts` → 5) expose in `src/preload/api.ts` → 6) use via `window.api.<domain>.<method>()`.

## Protocol Bridge (`src/shared/protocol/` + `src/main/protocol/`)

Codex only speaks the OpenAI **Responses** protocol — `wire_api = "chat"` was deprecated 2025-12 and became a hard error 2026-02, and the current config reference states `responses` is the only supported value. To let codex reach upstreams that speak something else, catmax runs a local converting proxy.

```
codex app-server ──Responses──▶ BridgeServer (127.0.0.1:random) ──Anthropic──▶ upstream
```

- **IR hub-and-spoke, not pairwise.** `src/shared/protocol/ir.ts` defines a block-centric intermediate representation; each protocol contributes one `ProtocolCodec` (`codec.ts`) with a client half (`decodeRequest` / `createResponseEncoder`) and an upstream half (`encodeRequest` / `createStreamDecoder`). N codecs cover N² pairs — adding `openai.chat` means one new file in `codecs/` plus one line in `registry.ts`, and every existing codec is untouched. Fidelity is protected by `IrRequest.vendor` (verbatim original body, used for same-protocol passthrough) and `IrOpaque` (payloads the target protocol can't express — Anthropic thinking `signature`, Responses `encrypted_content` — carried through and restored).
- **Encoders/decoders are stateful objects, not pure functions** — Responses requires `output_item.added`/`done` pairing and dense `output_index` allocation, which needs cross-event state. `ResponseEncoder.finish()` enforces the same exactly-one-terminal-event invariant `PerTurnCoordinator` does.
- **codex is reconfigured at spawn time, not on disk.** `BridgeManager.codexSpawnArgs()` emits `-c model_provider=...` overrides consumed by `CodexAdapter.setExtraArgs()`; `~/.codex/config.toml` is never touched, so disabling the bridge is a complete revert. codex receives only the bridge's per-boot token via `CATMAX_BRIDGE_TOKEN`; **the real upstream key never enters codex's env or config**.
- **Upstream quirks are data, not branches** — `UpstreamCapabilities` (`supportsImages`, `respectsThinkingBudget`, `defaultMaxOutputTokens`, …) drives downgrade decisions, with per-provider presets in `bridge-config.ts`.
- Reference implementation studied when designing this: cc-switch's `src-tauri/src/proxy/providers/`. Design rationale and the Responses/Chat/Anthropic protocol comparison: `docs/superpowers/specs/2026-07-29-protocol-bridge-design.md`.

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

- Vitest, `happy-dom` environment, discovers `tests/**/*.test.ts` and `src/**/*.test.ts` (both locations are intentional — co-located tests live alongside stores/lib in `src/renderer/src/`, everything else lives under `tests/{backend,renderer,shared,ipc,service}/`).
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
- `docs/superpowers/plans/plan-{1..5}-*[-smoke-test].md` — the phased implementation plan the app was originally built from (foundation → backend/chat → claude/sidebar → git/files/editor → terminal/cmdk → history/packaging/shortcuts).
