/**
 * Hot Update: state-machine.mjs 的类型声明。
 *
 * 手写而不是由 tsc 生成：bootstrap 故意不经过任何构建（见设计文档 §5.3），
 * 它是 asar 内唯一不可热更新的代码，交给构建工具就等于把它和业务代码打到一起。
 * 这份声明只为让 tests/bootstrap/*.test.ts 能有类型地 import 它。
 */

export interface HotUpdateState {
  baseVersion: string
  runtimeId: string
  active: number
  confirmed: number
  staged: number | null
  bootAttempts: number
  lastCheckAt: number
}

export interface BootEnv {
  appVersion: string
  runtimeId: string
  hasVersion: (n: number) => boolean
}

export interface BootDecision {
  active: number
  nextState: HotUpdateState
  /** 判定为坏包、应当删除的版本号 */
  discard: number[]
  reason: string
  /** 应当清空整个 versions/ 目录（baseVersion / runtimeId 守门触发） */
  resetAll: boolean
}

export const MAX_BOOT_ATTEMPTS: number
export const BUILTIN: 0

export function createInitialState(appVersion: string, runtimeId: string): HotUpdateState
export function decideBoot(state: HotUpdateState | null, env: BootEnv): BootDecision
export function confirmBoot(state: HotUpdateState): HotUpdateState
export function versionsToPrune(
  state: HotUpdateState,
  existing: number[],
  keepRecent?: number
): number[]
