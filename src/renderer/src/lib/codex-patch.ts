/**
 * V4 patch / unified diff 解析器 re-export——实现已挪到 shared 层
 * （主进程 mapping + 渲染器 DiffView 共用）。
 * 保留这个文件是为了不改动 DiffView / codex-patch.test.ts 的现有 import 路径。
 */
export {
  extractFileFromV4Patch,
  parseUnifiedDiffHunks,
  parseV4Patch,
} from '@shared/backend/v4-patch'
export type { ParsedPatchFile, V4FileKind } from '@shared/backend/v4-patch'
