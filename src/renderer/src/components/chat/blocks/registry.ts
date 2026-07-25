import type { BlockType } from '@shared/backend/blocks'
import { defineAsyncComponent, type Component } from 'vue'

type Loader = () => Promise<{ default: Component }>
type FallbackStrategy = 'hide' | 'show-raw'

const loaders = new Map<string, { loader: Loader; fallback: FallbackStrategy }>()
const components = new Map<string, Component>()

export function registerBlock(
  type: BlockType | (string & {}),
  loader: Loader,
  fallback: FallbackStrategy = 'show-raw',
): void {
  loaders.set(type, { loader, fallback })
  components.delete(type)
}

export function getBlockRenderer(type: string): Component {
  const cached = components.get(type)
  if (cached) return cached
  const registration = loaders.get(type)
  const component = registration
    ? defineAsyncComponent({
        loader: registration.loader,
        errorComponent:
          registration.fallback === 'hide' ? () => null : () => import('./base/BlockErrorView.vue'),
        delay: 0,
        timeout: 10_000,
      })
    : defineAsyncComponent(() => import('./base/FallbackBlockView.vue'))
  components.set(type, component)
  return component
}

export function isBlockRegistered(type: string): boolean {
  return loaders.has(type)
}

export function clearBlockRegistry(): void {
  loaders.clear()
  components.clear()
}
