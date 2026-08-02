/**
 * File Mention: 给引用 pill 生成小缩略图。
 *
 * 为什么不直接复用 readFilePreview 的 dataUrl：那条通道把整个文件 base64 打包发进
 * 渲染层（上限 12MB，一张手机照片就是六七 MB 的字符串），只为了画一个 20px 的方块，
 * 而且这些字符串会一直挂在 pill 上直到消息发出去。缩放放在主进程做，渲染层拿到的
 * 就只有几 KB。
 *
 * 两条路径，因为 NativeImage 只解码 PNG/JPEG 一类的位图：
 * - 能解码的：缩到 maxSize 再 toDataURL，绝大多数情况走这里。
 * - 解码不了的（svg / gif / webp / avif）：只要文件本身够小就把原文交给渲染层，
 *   `<img>` 自己会解码。宁可多传几百 KB，也好过给这些很常见的格式退回一个灰图标。
 *
 * 不引任何图像库——nativeImage 是 Electron 内置的。
 */
import { promises as fs } from 'node:fs'
import { extname } from 'node:path'

import { nativeImage } from 'electron'

import { imageMimeType } from './file-tree'
import { logger } from './logger'

const log = logger.domain('image-thumbnail')

/** 缩略图边长上限（CSS 像素的 2 倍余量，够 HiDPI 屏用）。 */
const DEFAULT_MAX_SIZE = 96

/**
 * 交给 NativeImage 解码的文件大小上限。
 *
 * 解码是同步的、发生在主进程，一张超大图会把整个 UI 卡住——这里挡的是那个，
 * 不是内存。
 */
const MAX_DECODE_BYTES = 24 * 1024 * 1024

/**
 * 走「原文直传」回退路径的大小上限，比上面严得多。
 *
 * 这条路径上文件是原样进渲染层的，没有缩放收益，所以只放行小文件——
 * 图标类 svg、表情 gif 基本都在这个量级以内。
 */
const MAX_PASSTHROUGH_BYTES = 2 * 1024 * 1024

/**
 * 读一张图的缩略图，返回 data URL；不是图片、太大、或解码失败都返回 null
 * （调用方据此退回普通文件图标）。
 */
export async function readImageThumbnail(
  absolutePath: string,
  maxSize = DEFAULT_MAX_SIZE,
): Promise<string | null> {
  const mimeType = imageMimeType(extname(absolutePath).slice(1).toLowerCase())
  if (!mimeType) return null

  let size: number
  try {
    const stat = await fs.stat(absolutePath)
    if (!stat.isFile()) return null
    size = stat.size
  } catch {
    return null
  }

  if (size > MAX_DECODE_BYTES) return null

  try {
    const image = nativeImage.createFromPath(absolutePath)
    if (!image.isEmpty()) {
      const { width, height } = image.getSize()
      // 只缩不放——把一个 16px 的图标拉到 96px 只会变糊。
      const scaled =
        width > maxSize || height > maxSize
          ? image.resize(width >= height ? { width: maxSize } : { height: maxSize })
          : image
      return scaled.toDataURL()
    }
  } catch (error) {
    log.debug('nativeImage decode failed, trying passthrough:', absolutePath, error)
  }

  // NativeImage 解码不了（svg/gif/webp/avif），小文件原样交给渲染层的 <img>
  if (size > MAX_PASSTHROUGH_BYTES) return null
  try {
    const data = await fs.readFile(absolutePath)
    return `data:${mimeType};base64,${data.toString('base64')}`
  } catch {
    return null
  }
}
