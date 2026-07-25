import { registerBuiltinBackendPlugins } from './builtin-plugins'

/**
 * Main-process plugin composition root.
 *
 * Trusted bundled plugins import and register here before Context creates BackendManager.
 */
export function registerMainBackendPlugins(): void {
  registerBuiltinBackendPlugins()
}
