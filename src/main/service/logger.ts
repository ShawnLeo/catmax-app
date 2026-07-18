/**
 * 简单日志器（生产环境可换 pino，MVP 用 console 即可）。
 * 用 [domain] 前缀格式化，便于在 DevTools 查看。
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error'

function log(level: LogLevel, domain: string, msg: string, ...args: unknown[]): void {
  const prefix = `[${domain}]`
  const fn =
    level === 'debug'
      ? console.debug
      : level === 'warn'
        ? console.warn
        : level === 'error'
          ? console.error
          : console.info
  fn(prefix, msg, ...args)
}

export const logger = {
  domain(name: string) {
    return {
      debug: (msg: string, ...args: unknown[]) => log('debug', name, msg, ...args),
      info: (msg: string, ...args: unknown[]) => log('info', name, msg, ...args),
      warn: (msg: string, ...args: unknown[]) => log('warn', name, msg, ...args),
      error: (msg: string, ...args: unknown[]) => log('error', name, msg, ...args),
    }
  },
}
