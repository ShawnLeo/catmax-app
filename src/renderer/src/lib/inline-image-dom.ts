/**
 * Chat Inline Image:
 * 把渲染完的 markdown DOM 里指向**本地文件**的 `<img>` 换成 data URL。
 *
 * 为什么必须换：渲染进程的 CSP 是 `img-src 'self' data: https:`，`file://` 直接被拦；
 * 而 `![二维码](qr.png)` 这种相对路径就算不被拦，也只会相对 index.html 解析，跟工作区
 * 毫无关系。两条都不通，`<img>` 就是一个永远加载不出来的空框——模型生成了图、告诉
 * 用户"请扫码"，用户却什么也看不到（飞书 device-code 登录就是这么坏掉的）。
 *
 * 所以走 `fs.readInlineImage`：主进程按工作区解析路径、读文件、返回 data URL。
 * 路径解析与文件面板同一条 `resolveFileReference`，工作区边界的判定只有一份。
 *
 * 缓存是必需的而不是优化：流式输出时 MarkdownView 每来一个 delta 就整块 v-html 重建，
 * 同一张图会被重新创建几十上百次。没有缓存就是同样次数的 IPC + 磁盘读 + base64。
 */

/** 已解析过的图片：`${workspaceId}\0${reference}` → data URL；null 表示解析失败（不重试）。 */
const cache = new Map<string, string | null>()
/** 同一张图的并发请求去重——同一帧里的多个 MarkdownView 可能同时要它。 */
const inflight = new Map<string, Promise<string | null>>()

/** 缓存上限：聊天里的内联图很少，超过就整体清空（下次重新读，用户无感）。 */
const MAX_CACHE_SIZE = 64

/**
 * 需要改写的 src：排除已经能直接加载的形态。
 * - `data:` —— 已经是内联数据
 * - `http:` / `https:` —— CSP 放行 https，交给网络层
 * - `blob:` —— 渲染层自己造的对象 URL
 * 其余（相对路径、绝对路径、`~/…`、`file://`）都当本地文件处理。
 */
function needsResolving(src: string): boolean {
  return src.trim() !== '' && !/^(data:|https?:|blob:)/i.test(src)
}

function cacheKey(workspaceId: string, reference: string): string {
  return `${workspaceId}\0${reference}`
}

function readInlineImage(workspaceId: string, reference: string): Promise<string | null> {
  const key = cacheKey(workspaceId, reference)
  const existing = inflight.get(key)
  if (existing) return existing

  const request = (async () => {
    const read = window.api.fs.readInlineImage
    // 开发时 renderer 已热更新而 main 还是旧进程——没有这个方法就当读不到，
    // 退回 alt 文本，不要让整块 markdown 炸掉。
    let dataUrl: string | null = null
    if (typeof read === 'function') {
      try {
        dataUrl = (await read({ workspaceId, reference }))?.dataUrl ?? null
      } catch {
        dataUrl = null
      }
    }
    if (cache.size >= MAX_CACHE_SIZE) cache.clear()
    cache.set(key, dataUrl)
    inflight.delete(key)
    return dataUrl
  })()

  inflight.set(key, request)
  return request
}

/**
 * 解析失败：抽掉 src 并留下标记。
 *
 * 去掉 src 之后 Chromium 会直接显示 alt 文本，不再画那个碎图图标——alt 一般是模型
 * 写的说明（"飞书登录二维码"），比碎图有用。标记留给样式和排查用。
 */
function markMissing(img: HTMLImageElement, reference: string): void {
  img.removeAttribute('src')
  img.dataset.inlineImage = 'missing'
  img.title = `图片未找到：${reference}`
}

/**
 * 解析容器内所有本地图片。渲染后（nextTick）调用。
 *
 * 同步命中缓存的直接改写（不闪一下空框）；未命中的走 IPC，回来时元素可能已被
 * 下一帧的 v-html 换掉——`isConnected` 挡住那种情况，避免给游离节点白设一次 src。
 */
export function resolveInlineImages(container: HTMLElement, workspaceId: string): void {
  for (const img of container.querySelectorAll('img')) {
    // 原始引用记在 dataset 上：src 一旦被换成 data URL 就找不回来了，而装饰可能在
    // 同一份 DOM 上跑第二次（文本没变但组件重新装饰）。
    const reference = img.dataset.inlineImageSrc ?? img.getAttribute('src') ?? ''
    if (!needsResolving(reference)) continue
    img.dataset.inlineImageSrc = reference

    const key = cacheKey(workspaceId, reference)
    if (cache.has(key)) {
      const cached = cache.get(key) ?? null
      if (cached) img.src = cached
      else markMissing(img, reference)
      continue
    }

    void readInlineImage(workspaceId, reference).then((dataUrl) => {
      if (!img.isConnected) return
      if (dataUrl) img.src = dataUrl
      else markMissing(img, reference)
    })
  }
}

/** 测试专用：清空缓存。 */
export function clearInlineImageCacheForTest(): void {
  cache.clear()
  inflight.clear()
}
