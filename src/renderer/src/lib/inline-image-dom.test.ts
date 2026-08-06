import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { clearInlineImageCacheForTest, resolveInlineImages } from './inline-image-dom'

// Chat Inline Image: 渲染进程的 CSP（img-src 'self' data: https:）拦掉 file://，
// 相对路径又只相对 index.html 解析——本地图片不换成 data URL 就是一张永远
// 加载不出来的空框（飞书扫码登录的二维码正是这样丢的）。

const readInlineImage = vi.fn()

function mountMarkdown(html: string): HTMLElement {
  const container = document.createElement('div')
  container.innerHTML = html
  document.body.appendChild(container)
  return container
}

/** 等 resolveInlineImages 内部那次 IPC 的 promise 链跑完。 */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  clearInlineImageCacheForTest()
  readInlineImage.mockReset()
  vi.stubGlobal('window', Object.assign(globalThis.window, { api: { fs: { readInlineImage } } }))
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('resolveInlineImages', () => {
  test('工作区相对路径换成 data URL', async () => {
    readInlineImage.mockResolvedValue({ dataUrl: 'data:image/png;base64,QQ==' })
    const container = mountMarkdown('<p><img src="feishu-login-qr.png" alt="飞书登录二维码"></p>')

    resolveInlineImages(container, 'ws-1')
    await flush()

    expect(readInlineImage).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      reference: 'feishu-login-qr.png',
    })
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,QQ==')
  })

  test('绝对路径同样走解析', async () => {
    readInlineImage.mockResolvedValue({ dataUrl: 'data:image/png;base64,QQ==' })
    const container = mountMarkdown('<p><img src="/tmp/qr.png" alt="二维码"></p>')

    resolveInlineImages(container, 'ws-1')
    await flush()

    expect(readInlineImage).toHaveBeenCalledWith({ workspaceId: 'ws-1', reference: '/tmp/qr.png' })
  })

  test('percent-encoded 路径原样传给主进程——解码是 resolveFileReference 的职责', async () => {
    // markdown-it 的 normalizeLink 会把中文文件名编码掉，`%` 在文件名里本身也合法，
    // 渲染层再解一次只会把两种情况混在一起。
    readInlineImage.mockResolvedValue({ dataUrl: 'data:image/png;base64,QQ==' })
    const container = mountMarkdown('<img src="./out/%E4%BA%8C%E7%BB%B4%E7%A0%81.png">')

    resolveInlineImages(container, 'ws-1')
    await flush()

    expect(readInlineImage).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      reference: './out/%E4%BA%8C%E7%BB%B4%E7%A0%81.png',
    })
  })

  test('data: / https: / blob: 的图片原样放过', async () => {
    const container = mountMarkdown(
      '<img src="data:image/png;base64,QQ=="><img src="https://example.com/a.png"><img src="blob:x">',
    )

    resolveInlineImages(container, 'ws-1')
    await flush()

    expect(readInlineImage).not.toHaveBeenCalled()
    expect([...container.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual([
      'data:image/png;base64,QQ==',
      'https://example.com/a.png',
      'blob:x',
    ])
  })

  test('解析不到时抽掉 src 并留标记——浏览器改显示 alt，不画碎图', async () => {
    readInlineImage.mockResolvedValue(null)
    const container = mountMarkdown('<img src="missing.png" alt="飞书登录二维码">')

    resolveInlineImages(container, 'ws-1')
    await flush()

    const img = container.querySelector('img')!
    expect(img.hasAttribute('src')).toBe(false)
    expect(img.dataset.inlineImage).toBe('missing')
    expect(img.getAttribute('alt')).toBe('飞书登录二维码')
  })

  test('IPC 抛错按解析不到处理，不冒泡出去', async () => {
    readInlineImage.mockRejectedValue(new Error('boom'))
    const container = mountMarkdown('<img src="qr.png">')

    resolveInlineImages(container, 'ws-1')
    await flush()

    expect(container.querySelector('img')?.dataset.inlineImage).toBe('missing')
  })

  test('同一张图只读一次——流式渲染会把同一块 DOM 重建几十次', async () => {
    readInlineImage.mockResolvedValue({ dataUrl: 'data:image/png;base64,QQ==' })

    for (let i = 0; i < 5; i += 1) {
      const container = mountMarkdown('<img src="qr.png">')
      resolveInlineImages(container, 'ws-1')
      await flush()
    }

    expect(readInlineImage).toHaveBeenCalledTimes(1)
  })

  test('换工作区后同一条相对路径重新解析', async () => {
    readInlineImage.mockResolvedValue({ dataUrl: 'data:image/png;base64,QQ==' })

    resolveInlineImages(mountMarkdown('<img src="qr.png">'), 'ws-1')
    await flush()
    resolveInlineImages(mountMarkdown('<img src="qr.png">'), 'ws-2')
    await flush()

    expect(readInlineImage).toHaveBeenCalledTimes(2)
  })

  test('二次装饰同一份 DOM 不会把已换好的 data URL 再当路径解析', async () => {
    readInlineImage.mockResolvedValue({ dataUrl: 'data:image/png;base64,QQ==' })
    const container = mountMarkdown('<img src="qr.png">')

    resolveInlineImages(container, 'ws-1')
    await flush()
    resolveInlineImages(container, 'ws-1')
    await flush()

    expect(readInlineImage).toHaveBeenCalledTimes(1)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,QQ==')
  })
})
