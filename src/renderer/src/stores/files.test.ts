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

  // File Preview Tabs (VS Code Preview Mode): 文件树单击 → 预览态；再单击其他文件覆盖原位；
  // 双击 / pinPreviewTab 转正；转正后不再被覆盖。
  test('transient tab is reused in place until pinned', async () => {
    const store = useFilesStore()

    // 文件树单击：打开预览态 tab
    await store.previewFile('workspace-1', 'a.txt', false, undefined, true)
    expect(store.previewTabs.map((t) => t.relativePath)).toEqual(['a.txt'])
    expect(store.previewTabs[0]?.isTransient).toBe(true)
    expect(store.activePreviewPath).toBe('a.txt')

    // 单击另一个文件：原位覆盖，tab 数量不变
    await store.previewFile('workspace-1', 'b.txt', false, undefined, true)
    expect(store.previewTabs.map((t) => t.relativePath)).toEqual(['b.txt'])
    expect(store.previewTabs[0]?.isTransient).toBe(true)
    expect(store.activePreviewPath).toBe('b.txt')

    // 双击转正
    store.pinPreviewTab('b.txt')
    expect(store.previewTabs[0]?.isTransient).toBe(false)

    // 再单击第三个文件：因当前活动 tab 已转正，不再覆盖，而是新增常驻 tab
    await store.previewFile('workspace-1', 'c.txt', false, undefined, true)
    expect(store.previewTabs.map((t) => t.relativePath)).toEqual(['b.txt', 'c.txt'])
    expect(store.previewTabs[1]?.isTransient).toBe(true)

    // 常驻入口（聊天引用等，asTransient 默认 false）打开已存在的预览态 tab 时应转正
    await store.previewFile('workspace-1', 'c.txt')
    expect(store.previewTabs.find((t) => t.relativePath === 'c.txt')?.isTransient).toBe(false)
  })
})
