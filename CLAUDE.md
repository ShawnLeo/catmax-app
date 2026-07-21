# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Essential Development Commands

```bash
# Core development
pnpm dev              # Start dev server (HMR + Electron)
pnpm build            # Production build (outputs to out/)
pnpm typecheck        # TypeScript checking (node + web)
pnpm lint             # ESLint check
pnpm lint:fix         # ESLint auto-fix
pnpm format           # Prettier formatting

# Testing (IMPORTANT: dual ABI handling required)
pnpm rebuild:node     # Rebuild native modules for Node (REQUIRED before tests)
pnpm test             # Run all tests (165 tests, vitest)
pnpm test:watch       # Watch mode

# Native modules for Electron
pnpm rebuild:native   # Rebuild better-sqlite3 + node-pty for Electron

# Packaging
pnpm dist:mac         # macOS dmg (arm64 + x64)
pnpm dist:win         # Windows nsis installer
```

**Critical**: Always run `pnpm rebuild:node` before running tests. Native modules (better-sqlite3, node-pty) must be compiled for both Electron (dev/build) and Node (testing) ABIs.

## Architecture Overview

### Three-Layer Process Model

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: RENDERER  (Vue3 + Pinia + Tailwind v4)            │
│   Zero business logic — all side-effects via IPC            │
└──────────────────────────┬──────────────────────────────────┘
                           │ Typed IPC (Heckmann pattern)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 2: MAIN  (Node.js + Electron)                         │
│   BackendManager + Adapters + IPC handlers + services        │
└──────────────────────────┬──────────────────────────────────┘
                           │ spawn + newline-delimited JSON
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ Layer 3: BACKEND  (External CLI processes, pluggable)       │
│   codex (JSON-RPC) / claude (stream-json)                   │
└─────────────────────────────────────────────────────────────┘
```

### Key Architectural Principles

**1. Backend Adapter Abstraction**
- All backend protocol details (codex JSON-RPC, claude stream-json) must be translated to `TurnEvent`/`NormalizedMessage` at Adapter boundary
- UI never sees backend protocol raw fields
- Adding new backend = new Adapter, UI remains unchanged
- Adapters live in `src/main/backend/<backend-id>/` with three files: `adapter.ts`, `protocol.ts`, `mapping.ts`

**2. Type-Safe IPC (Heckmann Pattern)**
- Handler function signatures are the contract
- Types automatically derive from main → preload → renderer
- Contract never drifts — changing handler signature breaks renderer compilation
- All IPC operations go through `window.api.*` in renderer

**3. Cross-Layer Import Rules (Strict)**
```
renderer/  →  Can import: shared/, renderer/, browser-compatible packages
              Forbidden: main/, preload/, electron, node:*

main/      →  Can import: shared/, main/, electron, node:*, any package
              Forbidden: renderer/

preload/   →  Can import: shared/, electron (contextBridge/ipcRenderer only)
              Forbidden: main/, renderer/, node:* (except allowlist)

shared/    →  Can import: shared/, type-only packages
              Forbidden: main/, renderer/, preload/, electron, node:*
```

**4. BackendManager Singleton**
- Single instance managed in `src/main/context.ts`
- Holds all adapter instances
- Routes backend operations and broadcasts `TurnEvent` via IPC
- Sessions always belong to their creating backend (immutable)

## Critical Patterns and Conventions

### Adding New IPC Methods (6-Step Process)

1. Define contract in `src/shared/ipc/<domain>.ts` (function signature)
2. Implement in `src/main/ipc/domains/<domain>/handlers.ts`
3. Register in `src/main/ipc/domains/<domain>/index.ts`
4. Aggregate in `src/main/ipc/register.ts`
5. Expose in `src/preload/api.ts` 
6. Use in renderer via `window.api.<domain>.<method>()`

**Never** use `ipcRenderer.invoke` directly in renderer — always `window.api.*`

### Adding New Backend Adapters

1. Add to `BackendId` type in `src/shared/backend/types.ts`
2. Create `src/main/backend/<id>/{adapter,protocol,mapping}.ts`
3. Implement `AgentBackend` interface
4. Register in `BackendManager` constructor
5. Declare capabilities in `BackendCapabilities`

UI automatically adapts to capabilities — no changes needed.

### Domain-Driven IPC Structure

9 IPC domains: `workspace`, `session`, `backend`, `git`, `fs`, `pty`, `credential`, `settings`, `system`

Each domain has:
- Contract in `src/shared/ipc/<domain>.ts`
- Handlers in `src/main/ipc/domains/<domain>/handlers.ts`
- Registration in `src/main/ipc/domains/<domain>/index.ts`

### Testing Strategy

- **165 tests** covering: shared types, services (database, git, pty, etc.), backend adapters, IPC handlers
- Tests mock spawn subprocesses — no real CLI dependency
- Run `pnpm rebuild:node` before tests (Node ABI vs Electron ABI)
- Key test scenarios: streaming output, tool calls, approval flow, interruption, protocol errors

## Important Files to Reference

- `src/shared/backend/types.ts` — `AgentBackend` interface, `TurnEvent`, `NormalizedMessage`
- `src/main/backend/manager.ts` — BackendManager singleton, adapter coordination
- `src/main/ipc/typed.ts` — Type-safe IPC foundation
- `src/shared/constants.ts` — IPC channels, storage keys, backend IDs
- `src/shared/settings-schema.ts` — AppSettings Zod schema

## When to Use What

| Task | Reference |
|---|---|
| Add/modify IPC methods | `.agents/skills/catmax-conventions/references/ipc-pattern.md` |
| Add/modify backend adapters | `.agents/skills/catmax-conventions/references/backend-adapter.md` |
| Vue components, styling, themes | `.agents/skills/catmax-conventions/references/ui-conventions.md` |
| Directory structure, cross-layer imports | `.agents/skills/catmax-conventions/references/architecture.md` |
| Naming, formatting, commit style | `.agents/skills/catmax-conventions/references/coding-style.md` |

## Strict Rules (Never Violate)

1. **Renderer layer zero business logic** — Never import `electron`, Node modules, or directly access `src/main/` in renderer
2. **New system operations require IPC contract** — Never let Vue directly call Node
3. **Adapters must implement AgentBackend** — Protocol details evaporate at adapter boundary
4. **Zod only for untrusted input** — subprocess messages, disk JSON, HTTP responses. Never for IPC parameters (TS types suffice)
5. **Time values use Unix milliseconds, IDs use UUID v4**

## Build Configuration

- **electron-vite**: Single entry (`electron.vite.config.ts`)
- **Dual TypeScript configs**: `tsconfig.node.json` (main/preload/shared), `tsconfig.web.json` (renderer)
- **Path aliases**: `@shared`, `@main`, `@renderer` (configured in electron.vite.config.ts and vitest.config.ts)
- **Package manager**: pnpm (required, not npm/yarn)
- **Node version**: ≥20.19

## Native Module Handling

The project uses `better-sqlite3` and `node-pty` which require native compilation. Electron and Node use different V8 versions, so modules must be compiled separately:

- `pnpm rebuild:native` — For Electron (auto-run before dev/build)
- `pnpm rebuild:node` — For Node/vitest (manual before tests)

## Theme System

Three-layer token architecture:
- Layer 1: Raw tokens (OKLCH color primitives)
- Layer 2: Semantic tokens (`--background`, `--foreground`, etc.) — Components ONLY reference this layer
- Layer 3: Component tokens (optional, for specific component needs)

Switch themes by changing `<html data-theme="dark|light|system|...">` — CSS variables automatically recalculate, no component code changes needed.