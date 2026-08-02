import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * NativeImage 是 Electron 内置的，vitest 跑在裸 Node 上拿不到——用一个可编排的
 * 假实现替掉，这样能精确控制"解码成功 / 解码失败"两条分支，而不用真的准备
 * 一张 svg 和一张 png。
 */
const decodable = new Set<string>()

vi.mock('electron', () => ({
  nativeImage: {
    createFromPath: (path: string) => ({
      isEmpty: () => !decodable.has(path),
      getSize: () => ({ width: 800, height: 600 }),
      resize: (opts: { width?: number; height?: number }) => ({
        toDataURL: () => `data:image/png;base64,resized-${opts.width ?? opts.height}`,
      }),
      toDataURL: () => 'data:image/png;base64,original',
    }),
  },
}))

const { readImageThumbnail } = await import('@main/service/image-thumbnail')

let dir: string

async function write(name: string, bytes: number): Promise<string> {
  const path = join(dir, name)
  await fs.writeFile(path, Buffer.alloc(bytes, 1))
  return path
}

beforeAll(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'catmax-thumb-'))
})

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('readImageThumbnail', () => {
  it('非图片扩展名直接返回 null，不去碰文件', async () => {
    const path = await write('a.ts', 10)
    expect(await readImageThumbnail(path)).toBeNull()
  })

  it('文件不存在返回 null', async () => {
    expect(await readImageThumbnail(join(dir, 'nope.png'))).toBeNull()
  })

  it('能解码的图缩到 maxSize——宽大于高时按宽缩', async () => {
    const path = await write('photo.jpg', 1000)
    decodable.add(path)
    expect(await readImageThumbnail(path, 96)).toBe('data:image/png;base64,resized-96')
  })

  // 解码不了的格式（svg/gif/webp）不该退回灰图标——它们在引用里太常见了
  it('解码失败但文件够小时原样透传，交给渲染层的 <img>', async () => {
    const path = await write('icon.svg', 16)
    const result = await readImageThumbnail(path)
    expect(result).toBe(`data:image/svg+xml;base64,${Buffer.alloc(16, 1).toString('base64')}`)
  })

  it('解码失败且文件超过透传上限时返回 null', async () => {
    const path = await write('big.gif', 3 * 1024 * 1024)
    expect(await readImageThumbnail(path)).toBeNull()
  })

  it('大到不值得同步解码的图直接返回 null，避免卡住主进程', async () => {
    const path = await write('huge.png', 25 * 1024 * 1024)
    decodable.add(path)
    expect(await readImageThumbnail(path)).toBeNull()
  })
})
