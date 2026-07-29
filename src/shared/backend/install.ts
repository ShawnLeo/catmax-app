/**
 * Backend Install: 后端"一键安装"的共享类型。
 *
 * 背景：claude 的二进制由 Agent SDK 内置，codex 需要用户自己装。
 * 主进程负责下载官方产物并落盘，全程通过 `backend:installProgress`
 * 推送进度给设置页；安装完成后把路径写进 settings.backendPaths.<id>。
 */
import type { BackendId } from '../constants'

/**
 * 支持一键安装的 backend。
 * claude 不在列——它的 binary 随 @anthropic-ai/claude-agent-sdk 一起打包，装不了也不用装。
 */
export const INSTALLABLE_BACKEND_IDS: BackendId[] = ['codex']

export function isInstallableBackend(id: BackendId): boolean {
  return INSTALLABLE_BACKEND_IDS.includes(id)
}

/**
 * 安装阶段。只有 downloading 有确定进度（tarball ~100MB），
 * 其余阶段 UI 显示不确定态进度条。
 */
export type BackendInstallPhase =
  | 'resolving' // 查 registry 拿版本号 + tarball 地址
  | 'downloading' // 下载 tarball
  | 'verifying' // 校验 sha512
  | 'extracting' // 解压到 userData
  | 'finalizing' // chmod + 健康检查
  | 'done'
  | 'error'
  | 'cancelled'

export interface BackendInstallProgress {
  backendId: BackendId
  phase: BackendInstallPhase
  /** 已下载字节数，非 downloading 阶段为 0 */
  receivedBytes: number
  /** 总字节数；服务端没给 content-length 时为 null */
  totalBytes: number | null
  /** 正在安装的版本号，resolving 结束后才有 */
  version: string | null
  /** phase === 'error' 时的人类可读原因 */
  error: string | null
}

export interface BackendInstallResult {
  ok: boolean
  /** 成功时的可执行文件绝对路径（已写入 settings.backendPaths） */
  binaryPath?: string
  /** 成功时安装的版本号 */
  version?: string
  /** 失败原因（人类可读） */
  error?: string
  /** 用户主动取消（不是失败，UI 不报红） */
  cancelled?: boolean
}
