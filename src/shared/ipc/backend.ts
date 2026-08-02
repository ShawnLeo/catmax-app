/**
 * backend domain IPC 契约。
 * 函数签名即契约——main 实现，renderer 通过 window.api 调用。
 */
import type {
  BackendConfigFileContent,
  BackendConfigFileInfo,
  BackendConfigWriteResult,
  ConfigSyntaxResult,
} from '../backend/config-files'
import type { BackendInstallProgress, BackendInstallResult } from '../backend/install'
import type { SlashCommandInfo } from '../backend/slash-commands'
import type {
  AgentAnswer,
  ApprovalDecision,
  BackendStatus,
  ModelOption,
  StartTurnArgs,
  TurnConfigUpdate,
  TurnEvent,
  WarmupBackendArgs,
} from '../backend/types'
import type { BackendId } from '../constants'
import type { TurnRunRecord } from '../domain'
import type { BridgeStatus } from '../protocol/bridge-config'

/**
 * renderer → BackendManager 的 turn 启动参数。
 *
 * clientTurnId 是 UI 乐观进入 running 状态时生成的稳定 ID，仅由 per-turn 协调器消费；
 * BackendManager 会在调用 adapter 前移除它，避免协调层元数据渗入 backend 协议。
 */
export type CoordinatedStartTurnArgs = StartTurnArgs & {
  clientTurnId?: string
}

export type BackendHandlers = {
  'backend.list': () => Promise<BackendStatus[]>
  'backend.current': () => Promise<{ id: BackendId }>
  'backend.switch': (args: { id: BackendId }) => Promise<void>
  'backend.listModels': () => Promise<ModelOption[]>
  /**
   * 列出指定 backend 的模型（不切换当前 backend）。
   * 用于设置页同时展示 codex / claude 两个 backend 的可选模型。
   * 注意：codex 首次调用会 spawn app-server 子进程。
   */
  'backend.listModelsFor': (args: { id: BackendId }) => Promise<ModelOption[]>
  'backend.refreshModels': () => Promise<ModelOption[]>
  /**
   * 强制刷新指定 backend 的模型列表（清缓存后重拉），不依赖当前 backend。
   * 协议桥那一节用它刷 codex 的列表——当前 backend 可能并不是 codex。
   */
  'backend.refreshModelsFor': (args: { id: BackendId }) => Promise<ModelOption[]>
  'backend.warmup': (args: { id: BackendId; config: WarmupBackendArgs }) => Promise<void>
  /**
   * 列出某后端在该 cwd 下可用的斜杠命令（含项目/用户 Skill），供输入框联想。
   *
   * 后端不支持斜杠命令（codex）或拉取失败时返回空数组——renderer 会退回静态兜底表。
   * 首次拉取要冷启一次握手（claude 实测 2.1–2.6 秒），所以调用方应在打开工作区时
   * 就预取，而不是等用户敲下 `/`。
   */
  'backend.slashCommands': (args: { id: BackendId; cwd: string }) => Promise<SlashCommandInfo[]>
  'backend.startTurn': (args: CoordinatedStartTurnArgs) => Promise<{ turnId: string }>
  'backend.interruptTurn': (args: { turnId: string }) => Promise<void>
  'backend.steerTurn': (args: { turnId: string; prompt: string }) => Promise<void>
  /** 停止单个后台任务（后台任务面板上的"停止"按钮），不影响所在 turn 的其他任务。 */
  'backend.stopBackgroundTask': (args: { taskId: string }) => Promise<void>
  /**
   * 读取后台任务输出文件的尾部（后台任务面板展开时轮询）。
   *
   * outputFile 由 BackgroundTaskSnapshot 带过来，但 renderer 传来的路径一律不可信：
   * main 侧会校验它确实是 `<taskId>.output` 且位于 `tasks/` 目录下，否则拒读。
   */
  'backend.readBackgroundTaskOutput': (args: {
    taskId: string
    outputFile: string
    /** 最多返回的尾部字节数（默认 64KB）。 */
    maxBytes?: number
  }) => Promise<{ exists: boolean; content: string; size: number; truncated: boolean }>
  'backend.listTurnRuns': (args?: { sessionId?: string }) => Promise<TurnRunRecord[]>
  'backend.respondApproval': (args: ApprovalDecision) => Promise<void>
  /** 响应 agent 的问题（ask_user 工具）：把用户答案回流给阻塞中的 handler */
  'backend.respondQuestion': (args: {
    turnId: string
    requestId: string
    answer: AgentAnswer
  }) => Promise<void>
  /** 运行中热切换 model/effort/permissionMode（仅 supportsHotSwap 的 backend） */
  'backend.updateTurnConfig': (args: { turnId: string; config: TurnConfigUpdate }) => Promise<void>
  /**
   * Backend Install: 下载并安装后端 CLI（目前只有 codex）。
   * 整个过程可能几分钟（tarball ~100MB），进度走 `backend:installProgress` 推送。
   * 成功时会把二进制路径写进 settings.backendPaths 并热应用到 adapter。
   */
  'backend.install': (args: { id: BackendId }) => Promise<BackendInstallResult>
  /** 取消进行中的安装；没有进行中的安装时是 no-op */
  'backend.cancelInstall': (args: { id: BackendId }) => Promise<void>
  /**
   * Backend Config Files: 直接读写后端自己的本地配置文件（~/.codex/config.toml 等）。
   *
   * `id` 只能是 `BACKEND_CONFIG_FILES` 里的稳定 id——路径由主进程查表算出，
   * renderer 传不进任意路径，这条 IPC 不是通用文件读写通道。
   */
  'backend.listConfigFiles': () => Promise<BackendConfigFileInfo[]>
  'backend.readConfigFile': (args: { id: string }) => Promise<BackendConfigFileContent>
  /**
   * 写回。`expectedMtimeMs` 是读到内容时的 mtime（当时不存在则为 null），
   * 与磁盘不符时返回 conflict 而不是覆盖；`force` 是用户在冲突提示里选"仍然覆盖"。
   */
  'backend.writeConfigFile': (args: {
    id: string
    content: string
    expectedMtimeMs: number | null
    force?: boolean
  }) => Promise<BackendConfigWriteResult>
  /** 编辑过程中的实时语法校验（不写盘）——保存时主进程还会再校验一次 */
  'backend.validateConfigFile': (args: {
    id: string
    content: string
  }) => Promise<ConfigSyntaxResult>
  /** 在系统文件管理器里定位该文件；文件不存在时打开其所在目录 */
  'backend.revealConfigFile': (args: { id: string }) => Promise<void>
  /**
   * Protocol Bridge: 本机协议转换桥的状态。
   * 只回运行态和「凭证是否就绪」，**密钥本身永不过 IPC**。
   */
  'backend.bridgeStatus': () => Promise<BridgeStatus>
  /**
   * 保存 / 清除上游密钥（传空串即清除）。
   * 写到 userData 下 0600 的单独文件，不进 settings.json。
   */
  'backend.setBridgeCredential': (args: {
    providerId: string
    secret: string
  }) => Promise<BridgeStatus>
  /** 用指定 provider 的配置打一次上游，验证 base_url / key / 模型名是否可用 */
  'backend.testBridgeUpstream': (args: { providerId: string }) => Promise<{
    ok: boolean
    message: string
  }>
  /** 查询指定 provider 的凭证是否已就绪（只回布尔，不回传密钥） */
  'backend.bridgeCredentialReady': (args: { providerId: string }) => Promise<boolean>
}

/** 主→渲染推送事件类型 */
export type BackendPushEvents = {
  /**
   * turn 事件——envelope 带 sessionId 让 renderer 把事件路由到对应 session 状态
   * （多 turn 并发时各个 session 的事件互不串台）。
   */
  'backend:turnEvent': { turnId: string; sessionId: string; event: TurnEvent }
  'backend:switched': { id: BackendId }
  'backend:statusChanged': { status: BackendStatus }
  /** Backend Install: 安装进度（含终态 done/error/cancelled） */
  'backend:installProgress': BackendInstallProgress
}
