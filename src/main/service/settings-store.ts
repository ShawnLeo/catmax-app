import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

import { appSettingsSchema, type AppSettings } from '@shared/settings-schema'
import { app } from 'electron'

import { logger } from './logger'

const log = logger.domain('settings-store')

export class SettingsStore {
  private filePath: string
  private cache: AppSettings | null = null

  constructor(filePath?: string) {
    this.filePath = filePath ?? this.defaultPath()
  }

  private defaultPath(): string {
    try {
      return join(app.getPath('userData'), 'settings.json')
    } catch {
      return join(process.cwd(), 'settings.json')
    }
  }

  /** 读取并校验 settings.json。文件不存在返回默认值；损坏时也返回默认值（带警告）。 */
  load(): AppSettings {
    if (this.cache) return this.cache

    if (!existsSync(this.filePath)) {
      log.info('settings file not found, using defaults')
      const defaults = appSettingsSchema.parse({})
      this.cache = defaults
      this.save(defaults)
      return defaults
    }

    const raw = readFileSync(this.filePath, 'utf-8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      log.error('settings.json is not valid JSON, using defaults:', e)
      const defaults = appSettingsSchema.parse({})
      this.cache = defaults
      return defaults
    }

    const result = appSettingsSchema.safeParse(parsed)
    if (!result.success) {
      log.warn('settings.json failed schema validation, using defaults:', result.error.issues)
      const defaults = appSettingsSchema.parse({})
      this.cache = defaults
      return defaults
    }

    this.cache = result.data
    log.info('loaded settings')
    return result.data
  }

  /** 部分更新 settings，写盘，返回完整 settings。 */
  update(patch: Partial<AppSettings>): AppSettings {
    const current = this.load()
    // 嵌套对象做浅 merge
    const runtimeDefaults: Record<string, unknown> = { ...current.defaultRuntimeConfig }
    for (const [backendId, backendPatch] of Object.entries(patch.defaultRuntimeConfig ?? {})) {
      runtimeDefaults[backendId] = {
        ...current.defaultRuntimeConfig[backendId],
        ...backendPatch,
      }
    }
    const merged = {
      ...current,
      ...patch,
      theme: { ...current.theme, ...(patch.theme ?? {}) },
      httpProxy: { ...current.httpProxy, ...(patch.httpProxy ?? {}) },
      backendPaths: { ...current.backendPaths, ...(patch.backendPaths ?? {}) },
      defaultRuntimeConfig: runtimeDefaults,
    }
    const validated = appSettingsSchema.parse(merged)
    this.cache = validated
    this.save(validated)
    log.info('updated settings')
    return validated
  }

  reset(): AppSettings {
    const defaults = appSettingsSchema.parse({})
    this.cache = defaults
    this.save(defaults)
    log.info('reset to defaults')
    return defaults
  }

  private save(settings: AppSettings): void {
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(this.filePath, JSON.stringify(settings, null, 2), 'utf-8')
  }
}
