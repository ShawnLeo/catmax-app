import type { BackendCapabilities } from './types'

export interface BackendPluginManifest {
  /** 全局稳定 id；第三方插件推荐反向域名或组织前缀。 */
  id: string
  displayName: string
  version: string
  description?: string
  /** 插件可能产出的 block type，用于启动校验和诊断。 */
  blockTypes: string[]
  capabilities: BackendCapabilities
}

export function validateBackendPluginManifest(manifest: BackendPluginManifest): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(manifest.id)) {
    throw new Error(`invalid backend plugin id: ${manifest.id}`)
  }
  if (!manifest.displayName.trim()) throw new Error('backend plugin displayName is required')
  if (!manifest.version.trim()) throw new Error('backend plugin version is required')
  if (new Set(manifest.blockTypes).size !== manifest.blockTypes.length) {
    throw new Error(`backend plugin "${manifest.id}" declares duplicate block types`)
  }
  const undeclaredBlockTypes = manifest.capabilities.chat.blockTypes.filter(
    (type) => !manifest.blockTypes.includes(type),
  )
  if (undeclaredBlockTypes.length > 0) {
    throw new Error(
      `backend plugin "${manifest.id}" capabilities reference undeclared block types: ${undeclaredBlockTypes.join(', ')}`,
    )
  }
}
