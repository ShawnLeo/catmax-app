# Repository Guidelines

## Project Structure & Module Organization

This Electron + Vue 3 desktop application is organized by process boundary:

- `src/main/`: Electron main process, backends, IPC handlers, and services.
- `src/preload/`: typed renderer bridge.
- `src/renderer/src/`: Vue views, components, stores, styles, and assets.
- `src/shared/`: cross-process types, constants, and IPC contracts.
- `tests/`: Vitest suites; `resources/` and `build/`: packaging assets.
- `docs/`: architecture notes; `poc/`: standalone experiments.

Keep renderer code browser-safe: do not import Electron, Node APIs, `src/main`, or `src/preload`. Use typed `window.api` IPC. Normalize backend-specific protocols under `src/main/backend/<backend>/` before data reaches the UI.

## Build, Test, and Development Commands

- `pnpm install`: install dependencies (Node 20.19+, pnpm 10).
- `pnpm dev`: rebuild native modules for Electron and launch development mode with HMR.
- `pnpm build`: create the production build in `out/`.
- `pnpm typecheck`: check both main/preload and renderer TypeScript projects.
- `pnpm lint` / `pnpm lint:fix`: report or fix ESLint issues.
- `pnpm format`: format source files with Prettier.
- `pnpm rebuild:node && pnpm test`: rebuild native modules, then run Vitest.
- `pnpm dist:mac` or `pnpm dist:win`: build platform installers.

## Coding Style & Naming Conventions

Prettier enforces two spaces, single quotes, no semicolons, trailing commas, 100-character lines, and LF endings. ESLint enforces grouped, alphabetized imports and type-only imports. Use `PascalCase.vue` for components, `camelCase` for symbols, and kebab-case for services and utilities (for example, `settings-store.ts`). Prefix intentionally unused parameters with `_`.

Comment architectural boundaries and non-obvious state, security, compatibility, or fallback logic. Use searchable feature labels such as `// File Preview Tabs: ...` or `<!-- File Tree Body: ... -->`. Explain intent and invariants, not syntax; update stale comments with the code.

## Testing Guidelines

Vitest uses `happy-dom` and discovers `tests/**/*.test.ts` and `src/**/*.test.ts`. Name tests after the unit, such as `git-service.test.ts`. Cover service logic, IPC changes, protocol mapping, and errors. No threshold is configured; maintain or improve relevant coverage.

## Commit & Pull Request Guidelines

Use Conventional Commits: `feat(chat): ...`, `fix(backend): ...`, `refactor: ...`, or `chore(lint): ...`. Keep commits focused. PRs should explain the change, tests, and architectural impact; link issues and include screenshots for UI changes. Before review, run `pnpm typecheck`, `pnpm lint`, and relevant tests.
