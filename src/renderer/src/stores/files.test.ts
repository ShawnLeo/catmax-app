import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { useFilesStore } from './files'
import { useWorkspaceStore } from './workspace'

const readFilePreview = vi.fn(async ({ relativePath }: { relativePath: string }) => ({
  relativePath,
  absolutePath: `/workspace/${relativePath}`,
  name: relativePath.split('/').pop()!,
  size: 10,
  mimeType: 'text/plain',
  kind: 'text' as const,
  isBinary: false,
  content: relativePath,
  dataUrl: null,
  language: 'text',
  truncated: false,
  encoding: 'utf-8' as const,
  modifiedAt: 1,
}))

// File Preview Tabs: 核心回归是复用已有 tab，并在关闭后保持可预测的活动项。
describe('files store preview tabs', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    readFilePreview.mockClear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        fs: {
          readFilePreview,
          searchFiles: vi.fn(),
          resolveFileReference: vi.fn(),
        },
      },
    })
    useWorkspaceStore().workspaces = [
      {
        id: 'workspace-1',
        path: '/workspace',
        name: 'workspace',
        preferredEditor: null,
        lastOpenedAt: 1,
        createdAt: 1,
      },
    ]
  })

  test('opens, switches, reuses, and closes preview tabs', async () => {
    const store = useFilesStore()

    await store.previewFile('workspace-1', 'package.json')
    await store.previewFile('workspace-1', 'README.md')

    expect(store.previewTabs.map((tab) => tab.relativePath)).toEqual(['package.json', 'README.md'])
    expect(store.activePreviewPath).toBe('README.md')
    expect(store.currentPreview?.content).toBe('README.md')

    store.selectPreview('package.json')
    expect(store.currentPreview?.content).toBe('package.json')

    await store.previewFile('workspace-1', 'package.json')
    expect(store.previewTabs).toHaveLength(2)
    expect(readFilePreview).toHaveBeenCalledTimes(2)

    store.closePreview('package.json')
    expect(store.activePreviewPath).toBe('README.md')
    expect(store.currentPreview?.content).toBe('README.md')
  })
})
