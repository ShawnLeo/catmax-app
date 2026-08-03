/**
 * 内测登录态 IPC 契约。
 *
 * 设计取舍：内测阶段密钥**本地不校验**（任意非空输入即视为登录成功），
 * 真实校验留待后续接入服务端。因此这里只回传登录态元信息，密钥本身
 * 永不跨 IPC 回传（参考 bridge-credentials.ts 的"只出不进 renderer"原则）。
 */
import type { BridgeProvider } from '../protocol/bridge-config'

/** 登录方式。当前内测仅支持「密钥登录」一种。 */
export type LoginMethod = 'secret-key'

/**
 * Internal Beta Login: 登录成功后 main 回传给 renderer 的内测桥 provider。
 *
 * main 负责：存密钥到 bridge-credentials.json（0600，renderer 碰不到）+ 写 Claude 覆盖文件。
 * renderer 负责：拿到这个 provider 后调 settings.update 写 protocolBridge——走 IPC 单一链路，
 * 这样 renderer store 自动刷新 + UI 更新 + main settingsStore.update handler 会启动桥。
 * 密钥本身不在这个对象里（它只含 provider 元数据，密钥已由 main 存进 0600 凭证文件）。
 */
export interface InternalBetaBridgeSetup {
  /** 要写进 settings.protocolBridge.providers 的内测 provider（固定 id） */
  provider: BridgeProvider
}

/** 登录态快照（renderer 只读这个布尔 + 标签来渲染 UI） */
export interface AuthStatus {
  loggedIn: boolean
  /** 未登录时为 null；登录后为实际登录方式，用于侧栏底部展示标签 */
  loginMethod: LoginMethod | null
  /**
   * Internal Beta Login: 登录成功时携带的内测桥 provider（仅 login 返回值非空）。
   * getStatus/logout 不带此字段。renderer 收到后用它驱动 settings.update。
   */
  internalBetaBridge?: InternalBetaBridgeSetup | null
}

export type AuthHandlers = {
  /** 读取当前持久化的登录态（app 启动时由路由守卫调用，决定是否放行） */
  'auth.getStatus': () => Promise<AuthStatus>
  /**
   * 用密钥登录。内测阶段：secretKey 非空即成功，不做任何校验。
   * 成功后：main 存密钥到 bridge-credentials + 写 Claude 覆盖文件，
   * 并在返回值里带回内测桥 provider 让 renderer 写 settings。
   */
  'auth.login': (args: { secretKey: string }) => Promise<AuthStatus>
  /** 退出登录：清除登录态 + 删 Claude 覆盖文件 + 清 bridge-credentials 密钥 */
  'auth.logout': () => Promise<AuthStatus>
}
