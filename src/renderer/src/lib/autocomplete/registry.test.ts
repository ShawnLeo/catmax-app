import { describe, expect, it } from 'vitest'

import { SuggestionRegistry } from './registry'
import { charTrigger } from './trigger'
import type { SuggestionProvider } from './types'

function provider(id: string, char: string): SuggestionProvider {
  return {
    id,
    detect: charTrigger({ char }),
    search: async () => [{ id: `${id}-1`, label: id, insert: `${char}${id} ` }],
  }
}

describe('SuggestionRegistry', () => {
  it('把触发段派给认领它的 provider', () => {
    const registry = new SuggestionRegistry()
    registry.register(provider('file', '@'))
    registry.register(provider('command', '/'))

    expect(registry.detect('@src', 4)?.provider.id).toBe('file')
    expect(registry.detect('/comp', 5)?.provider.id).toBe('command')
    expect(registry.detect('普通文本', 4)).toBeNull()
  })

  it('多个 provider 认领同一段时按注册顺序取第一个', () => {
    const registry = new SuggestionRegistry()
    registry.register(provider('first', '@'))
    registry.register(provider('second', '@'))
    expect(registry.detect('@a', 2)?.provider.id).toBe('first')
  })

  it('注销后不再参与', () => {
    const registry = new SuggestionRegistry()
    const dispose = registry.register(provider('file', '@'))
    expect(registry.detect('@a', 2)).not.toBeNull()
    dispose()
    expect(registry.detect('@a', 2)).toBeNull()
    expect(registry.list()).toEqual([])
  })
})
