/**
 * 后端错误码 → 人类可读的诊断 + 修复指引。
 *
 * healthCheck 失败时 main 返回的 BackendStatus.error 字段是机器码（health-check.ts），
 * renderer 这里转成「短描述 + 详细说明 + 修复步骤」给用户看。
 */

export interface BackendErrorInfo {
  /** 一句话标题 */
  title: string
  /** 详细说明（可多行） */
  detail: string
  /** 建议的修复步骤 */
  fix?: string[]
}

const ERROR_INFO: Record<string, BackendErrorInfo> = {
  'not-installed': {
    title: '未安装',
    detail: '在 PATH 里找不到这个 CLI。需要先安装它。',
    fix: [
      'codex: npm i -g @openai/codex',
      'claude: npm i -g @anthropic-ai/claude-code',
      '安装后重启 catmax',
    ],
  },
  'killed-by-os': {
    title: '被系统拦截（SIGKILL）',
    detail:
      '进程刚启动就被 macOS 强制终止。最常见的原因是 Gatekeeper 拦截——例如签名证书被吊销、未签名、或来自未受信任的下载源。',
    fix: [
      '打开「系统设置 → 隐私与安全性」，看看底部是否有「已阻止 codex ...」的提示，点「仍要打开」',
      '或在终端手动跑一次该 CLI（如 `codex --version`），跟随提示放通',
      '若签名证书被吊销：从 npm 重装可绕过（npm i -g @openai/codex --force）',
      '终极方案：sudo xattr -dr com.apple.provenance <二进制路径>',
    ],
  },
  timeout: {
    title: '响应超时',
    detail: 'CLI 启动了但 5 秒内没返回版本号。可能在等输入、卡在网络请求、或系统负载太高。',
    fix: ['在终端手动跑 `<cli> --version` 看看是否同样卡住', '检查代理设置是否影响 CLI'],
  },
  'non-zero-exit': {
    title: '异常退出',
    detail: 'CLI 启动了但报错退出（exit code != 0）。通常说明 CLI 本身有问题。',
    fix: ['在终端手动跑 `<cli> --version` 看错误信息', '尝试 `npm i -g <package>` 重装'],
  },
  'spawn-error': {
    title: '启动失败',
    detail: '无法 spawn CLI 进程。可能权限不足、文件损坏、或环境异常。',
  },
  'spawn-failed': {
    // 兼容旧的健康检查错误码
    title: '启动失败',
    detail: '无法 spawn CLI 进程。',
  },
  'not-initialized': {
    title: '未初始化',
    detail: '该后端尚未加载。',
  },
}

/** 把 BackendStatus.error 转成可读信息。未知错误码兜底。 */
export function explainBackendError(code: string | null | undefined): BackendErrorInfo {
  if (!code) {
    return { title: '不可用', detail: '后端不可用，但没有具体错误信息。' }
  }
  return ERROR_INFO[code] ?? { title: code, detail: `未知的错误码：${code}` }
}
