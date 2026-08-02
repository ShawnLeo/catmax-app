import { parseFileMentions } from '@renderer/lib/file-mention'
import type { DirEntry } from '@shared/ipc/fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TriggerMatch } from '../types'

import { fileSuggestionProvider } from './file'

function entry(relativePath: string, isDirectory = false): DirEntry {
  return {
    name: relativePath.split('/').pop()!,
    relativePath,
    isDirectory,
    isSymlink: false,
    size: 0,
    modifiedAt: 0,
  }
}

const readDirectory = vi.fn()
const searchFiles = vi.fn()

beforeEach(() => {
  readDirectory.mockReset()
  searchFiles.mockReset()
  vi.stubGlobal('window', { api: { fs: { readDirectory, searchFiles } } })
})

function match(query: string): TriggerMatch {
  return { char: '@', start: 0, end: query.length + 1, query }
}

const ctx = { workspaceId: 'ws-1', backendId: 'claude' }

describe('fileSuggestionProvider', () => {
  const multiCtx = {
    ...ctx,
    workspaceFolders: [
      {
        id: 'primary',
        workspaceId: 'ws-1',
        path: '/code/app',
        alias: 'app',
        role: 'primary' as const,
        sortOrder: 0,
        createdAt: 1,
      },
      {
        id: 'docs',
        workspaceId: 'ws-1',
        path: '/code/docs',
        alias: 'docs',
        role: 'secondary' as const,
        sortOrder: 1,
        createdAt: 1,
      },
    ],
  }

  it('多根工作区空 query 先列主/次文件夹别名', async () => {
    const items = await fileSuggestionProvider.search(match(''), multiCtx)
    expect(items.map((item) => item.insert)).toEqual(['@app/', '@docs/'])
    expect(readDirectory).not.toHaveBeenCalled()
  })

  it('多根工作区按 alias 浏览指定文件夹', async () => {
    readDirectory.mockResolvedValue([entry('guide.md')])
    const items = await fileSuggestionProvider.search(match('docs/'), multiCtx)
    expect(readDirectory).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      folderId: 'docs',
      relativePath: '',
    })
    expect(items[0]?.insert).toBe('@docs/guide.md ')
  })

  it('未指定 alias 时跨全部文件夹搜索并返回限定路径', async () => {
    searchFiles.mockResolvedValue([{ ...entry('guide.md'), folderId: 'docs', folderAlias: 'docs' }])
    const items = await fileSuggestionProvider.search(match('guide'), multiCtx)
    expect(searchFiles).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      query: 'guide',
      limit: 30,
      allFolders: true,
    })
    expect(items[0]?.id).toBe('docs/guide.md')
  })

  it('没有工作区时什么都不查', async () => {
    const empty = { workspaceId: undefined, backendId: 'claude' }
    expect(await fileSuggestionProvider.search(match('a'), empty)).toEqual([])
    expect(searchFiles).not.toHaveBeenCalled()
  })

  it('空 query 列根目录，而不是发一次搜不到东西的搜索', async () => {
    readDirectory.mockResolvedValue([entry('src', true), entry('README.md')])
    const items = await fileSuggestionProvider.search(match(''), ctx)

    expect(readDirectory).toHaveBeenCalledWith({ workspaceId: 'ws-1', relativePath: '' })
    expect(searchFiles).not.toHaveBeenCalled()
    expect(items.map((i) => i.label)).toEqual(['src', 'README.md'])
  })

  it('query 以 / 结尾时列那一层目录——这是「选中目录后接着往下钻」的那一步', async () => {
    readDirectory.mockResolvedValue([entry('src/lib', true)])
    await fileSuggestionProvider.search(match('src/'), ctx)
    expect(readDirectory).toHaveBeenCalledWith({ workspaceId: 'ws-1', relativePath: 'src' })
  })

  it('普通 query 走全工作区搜索', async () => {
    searchFiles.mockResolvedValue([entry('src/components/Composer.vue')])
    const items = await fileSuggestionProvider.search(match('Composer'), ctx)

    expect(searchFiles).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      query: 'Composer',
      limit: 30,
    })
    expect(items[0]).toMatchObject({ label: 'Composer.vue', detail: 'src/components' })
  })

  it('目录读不到时回退到搜索，而不是给个空列表', async () => {
    readDirectory.mockRejectedValue(new Error('ENOENT'))
    searchFiles.mockResolvedValue([entry('src/nope.ts')])
    const items = await fileSuggestionProvider.search(match('nope/'), ctx)
    expect(items).toHaveLength(1)
  })

  /*
   * 联想插进去的文本必须和拖放/右键写进去的是同一种形态，否则会出现「弹层里选了
   * 文件，输入框却没高亮、上方也没出现引用 pill」——那两处都是从 parseFileMentions
   * 派生的。这条把两边钉在一起。
   */
  it('插入的文本能被 parseFileMentions 原样读回', async () => {
    searchFiles.mockResolvedValue([entry('src/a.ts'), entry('docs/my notes.md')])
    const items = await fileSuggestionProvider.search(match('a'), ctx)

    for (const item of items) {
      const parsed = parseFileMentions(item.insert)
      expect(parsed).toHaveLength(1)
      expect(parsed[0]!.path).toBe(item.id)
    }
  })

  it('文件补尾随空格收干净触发段，目录不补以便继续往下钻', async () => {
    searchFiles.mockResolvedValue([entry('src/a.ts'), entry('src/lib', true)])
    const [file, dir] = await fileSuggestionProvider.search(match('src'), ctx)

    expect(file!.insert).toBe('@src/a.ts ')
    expect(file!.keepOpen).toBeUndefined()
    expect(dir!.insert).toBe('@src/lib/')
    expect(dir!.keepOpen).toBe(true)
  })

  /*
   * 带空格的目录会被包成 `@"a b/"`，收尾的引号让触发段就此结束，再往下钻是钻不
   * 动的。与其让弹层开着却搜不到任何东西，不如按普通项收尾。
   */
  it('含空格的目录不保持打开', async () => {
    searchFiles.mockResolvedValue([entry('my docs', true)])
    const [dir] = await fileSuggestionProvider.search(match('my'), ctx)
    expect(dir!.keepOpen).toBeUndefined()
    expect(dir!.insert).toBe('@"my docs/" ')
  })
})
