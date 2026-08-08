import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { parseSystemProxy } from '@main/backend/proxy-env'
import { ctx } from '@main/context'
import { setTrayContext as applyTrayContext, takePendingTrayCommand } from '@main/tray'
import { STORAGE_KEYS } from '@shared/constants'
import type {
  DetectedSystemProxy,
  OpenDialogArgs,
  OpenWithApp,
  PlatformInfo,
  TrayCommandId,
  TrayContext,
} from '@shared/ipc/system'
import { dialog, net, shell } from 'electron'

export const getPlatformInfo = async (): Promise<PlatformInfo> => {
  return {
    platform: process.platform as PlatformInfo['platform'],
    arch: process.arch as PlatformInfo['arch'],
    osVersion: process.getSystemVersion(),
    appVersion: process.env['npm_package_version'] ?? '0.0.0',
    electronVersion: process.versions.electron,
  }
}

export const openDialog = async (args: OpenDialogArgs) => {
  const win = ctx.getMainWindow()
  const options: Electron.OpenDialogOptions = {
    properties: args.properties ?? ['openDirectory'],
  }
  if (args.title !== undefined) options.title = args.title
  if (args.defaultPath !== undefined) options.defaultPath = args.defaultPath
  const result = await dialog.showOpenDialog(win!, options)
  return { canceled: result.canceled, filePaths: result.filePaths }
}

export const openExternal = async (args: { url: string }): Promise<void> => {
  await shell.openExternal(args.url)
}

/**
 * 检测当前系统的代理设置。
 * - macOS: 跑 `scutil --proxy` 解析
 * - Windows: 读注册表 HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
 * - Linux: 读 HTTP_PROXY / HTTPS_PROXY 环境变量
 *
 * 检测不到时返回 enabled=false + source='none'。
 */
export const detectProxy = async (): Promise<DetectedSystemProxy> => {
  // Linux: 直接读 env
  if (process.platform === 'linux') {
    const url =
      process.env.HTTPS_PROXY ??
      process.env.https_proxy ??
      process.env.HTTP_PROXY ??
      process.env.http_proxy
    if (url) {
      return {
        enabled: true,
        url,
        bypass: process.env.NO_PROXY ?? process.env.no_proxy ?? null,
        source: 'linux-env',
      }
    }
    return { enabled: false, url: '', bypass: null, source: 'none' }
  }

  // macOS: 跑 scutil --proxy
  if (process.platform === 'darwin') {
    try {
      const { execSync } = await import('node:child_process')
      const output = execSync('scutil --proxy', { encoding: 'utf-8', timeout: 3000 })
      const parsed = parseSystemProxy(output)
      if (parsed) {
        return { ...parsed, source: 'macos-scutil' }
      }
      return { enabled: false, url: '', bypass: null, source: 'none' }
    } catch {
      return { enabled: false, url: '', bypass: null, source: 'none' }
    }
  }

  // Windows: 读注册表（reg query）
  if (process.platform === 'win32') {
    try {
      const { execSync } = await import('node:child_process')
      const regQuery = (key: string) =>
        execSync(
          `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ${key}`,
          {
            encoding: 'utf-8',
            timeout: 3000,
          },
        ).trim()
      const enableStr = regQuery('ProxyEnable')
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(enableStr)
      if (!enabled) {
        return { enabled: false, url: '', bypass: null, source: 'none' }
      }
      const serverStr = regQuery('ProxyServer')
      const m = serverStr.match(/ProxyServer\s+REG_SZ\s+(\S+)/)
      const host = m?.[1] ?? ''
      const bypassStr = regQuery('ProxyOverride')
      const bm = bypassStr.match(/ProxyOverride\s+REG_SZ\s+(\S*)/)
      const bypass = bm?.[1] || null
      const url = /^https?:\/\//.test(host) ? host : `http://${host}`
      return { enabled: true, url, bypass, source: 'windows-registry' }
    } catch {
      return { enabled: false, url: '', bypass: null, source: 'none' }
    }
  }

  return { enabled: false, url: '', bypass: null, source: 'none' }
}

/** 窗口控制：最小化 */
export const windowMinimize = async (): Promise<void> => {
  const win = ctx.getMainWindow()
  if (win) win.minimize()
}

/**
 * 窗口控制：最大化/还原。
 *
 * macOS 上 maximize() 只把窗口拉到工作区大小（保留菜单栏/Dock），
 * 绿色按钮"没有完全放大整个屏幕"的体验来自这里——
 * macOS 绿色按钮的原生语义是全屏，所以 darwin 走 setFullScreen。
 * Windows/Linux 保持 maximize。
 */
export const windowMaximize = async (): Promise<void> => {
  const win = ctx.getMainWindow()
  if (!win) return
  if (process.platform === 'darwin') {
    win.setFullScreen(!win.isFullScreen())
  } else if (win.isMaximized()) {
    win.unmaximize()
  } else {
    win.maximize()
  }
}

/** 窗口控制：关闭 */
export const windowClose = async (): Promise<void> => {
  const win = ctx.getMainWindow()
  if (win) win.close()
}

/** 窗口控制：检查是否最大化（macOS 上反映全屏状态，与 windowMaximize 对齐） */
export const windowIsMaximized = async (): Promise<boolean> => {
  const win = ctx.getMainWindow()
  if (!win) return false
  return process.platform === 'darwin' ? win.isFullScreen() : win.isMaximized()
}

/** 窗口控制：切换始终置顶，并把主进程中的真实状态返回给渲染层。 */
export const windowToggleAlwaysOnTop = async (): Promise<boolean> => {
  const win = ctx.getMainWindow()
  if (!win) return false
  win.setAlwaysOnTop(!win.isAlwaysOnTop())
  return win.isAlwaysOnTop()
}

/** 窗口控制：检查是否始终置顶。 */
export const windowIsAlwaysOnTop = async (): Promise<boolean> => {
  return ctx.getMainWindow()?.isAlwaysOnTop() ?? false
}

/**
 * Tray: 渲染层启动时来取"窗口是被托盘菜单拉起来的"这条命令。
 * take-once 语义，取完主进程侧就清空，避免下次窗口重建时重放旧命令。
 */
export const takeTrayCommand = async (): Promise<TrayCommandId | null> => {
  return takePendingTrayCommand()
}

/**
 * Tray: 渲染层上报托盘菜单的门控条件（路由 / 工作区 / 登录态变化时）。
 * 只存不算——菜单在右键弹出那一刻才用最新值重建（见 main/tray.ts 的 buildMenu）。
 */
export const setTrayContext = async (args: TrayContext): Promise<void> => {
  applyTrayContext(args)
}

/**
 * 保存图片到用户选择的路径。
 *
 * Image Preview Overlay 顶部下载按钮入口。支持两种来源：
 * - data:URL（base64）：直接解码写盘，无网络依赖。
 * - http(s) URL：走 Electron net 拉取再流式写盘，避免 renderer CORS / blob 大小限制。
 *
 * 流程：先弹 showSaveDialog 让用户选路径（默认名用 suggestedName 或从 URL 推断），
 * 取消返回 null；保存成功返回最终路径。
 */
export const saveImage = async (args: {
  url: string
  suggestedName?: string
}): Promise<string | null> => {
  const win = ctx.getMainWindow()
  const { url, suggestedName } = args

  // 推断默认文件名：显式建议 > data:URL MIME > URL 路径 > 兜底 image
  const defaultName = suggestedName || inferImageName(url)

  const result = await dialog.showSaveDialog(win!, {
    title: '保存图片',
    defaultPath: defaultName,
    filters: [
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  })
  if (result.canceled || !result.filePath) return null

  if (url.startsWith('data:')) {
    // data:URL：解析 base64 payload 直接写盘（无网络依赖）
    const parsed = parseDataUrl(url)
    if (!parsed) throw new Error('无法解析 data:URL')
    writeFileSync(result.filePath, parsed.data)
    return result.filePath
  }

  // http(s) URL：走 Electron net 拉取整个 buffer 再写盘。
  // 一次性写而不是流式——图片通常不大，省掉临时文件的复杂度。
  const response = await net.fetch(url)
  if (!response.ok) {
    throw new Error(`下载失败：HTTP ${response.status}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(result.filePath, buffer)
  return result.filePath
}

/**
 * File Context Menu: 用系统默认应用打开文件或目录（shell.openPath）。
 * path 必须是已解析的绝对路径；resolveFileReference 已在渲染层完成工作区边界校验。
 */
export const openPath = async (args: { path: string }): Promise<void> => {
  await shell.openPath(args.path)
}

/**
 * File Context Menu: 在 Finder / 资源管理器中定位（选中）文件。
 * 与 session.revealInFolder 同源——showItemInFolder 的语义是「选中这一项」。
 */
export const showItemInFolder = async (args: { path: string }): Promise<void> => {
  shell.showItemInFolder(args.path)
}

/**
 * File Context Menu: 用指定应用打开文件（`open -a <appPath> <filePath>`，仅 darwin）。
 * 用 execFile 传 argv 数组而非字符串拼接，由 OS 处理空格/Unicode 转义。
 */
export const openWithApp = async (args: { filePath: string; appPath: string }): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    execFile('open', ['-a', args.appPath, args.filePath], (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/**
 * Open With: 读回用户选择的全局打开方式应用（存 app_state 表）。
 * 与 session.getLastRuntimeConfig 同源——主进程 app_state 是真相，渲染层只读快照。
 * 未选过返回 null（调用方据此显示「系统默认」并用 openPath）。
 */
export const getOpenWithApp = async (): Promise<OpenWithApp | null> => {
  const raw = ctx.db.getState(STORAGE_KEYS.OPEN_WITH_APP)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as OpenWithApp
    return parsed?.name && parsed?.path ? parsed : null
  } catch {
    return null
  }
}

/** Open With: 持久化用户选择的全局打开方式应用（null = 清除，回到系统默认）。 */
export const setOpenWithApp = async (args: { app: OpenWithApp | null }): Promise<void> => {
  if (args.app) {
    ctx.db.setState(STORAGE_KEYS.OPEN_WITH_APP, JSON.stringify(args.app))
  } else {
    ctx.db.deleteState(STORAGE_KEYS.OPEN_WITH_APP)
  }
}

/**
 * Open With: 列出系统已安装的**编程 IDE**（全局「打开方式」选择器用）。
 *
 * 这是个编程 Agent，打开方式只放编程类应用——白名单见 isIdeApp。
 *
 * 扫 /Applications 和 ~/Applications 下的顶层 .app（不递归——包内 helper .app 不该出现）。
 * 每个 app：读 Info.plist 拿 bundleId（白名单判定）+ CFBundleName（展示名），
 * 通过的再跑一次 swift 取图标（NSWorkspace.icon，不挑图标文件位置，全平台通用）。
 * 仅 darwin 有意义；其它平台返回空数组。
 *
 * 不用 Launch Services：那条路径必须绑定具体文件，全局选择器没有文件上下文；
 * 扫目录 + bundleId 白名单是「列已装 IDE」最直接、最稳的方式。
 */
export const listApplications = async (): Promise<OpenWithApp[]> => {
  if (process.platform !== 'darwin') return []
  // Finder 固定第一项（默认打开方式）。Finder.app 在 /System/Library/CoreServices，
  // 不在扫的 /Applications 目录里，这里硬塞；open -a Finder <file> = 在 Finder 里定位，
  // 正是「文件系统」语义。
  const finderAppPath = '/System/Library/CoreServices/Finder.app'
  const finderIcon = await readAppIcon(finderAppPath)
  const apps: OpenWithApp[] = [
    {
      name: 'Finder',
      path: finderAppPath,
      ...(finderIcon !== null && { icon: finderIcon }),
    },
  ]
  const dirs = ['/Applications', join(homedir(), 'Applications')]
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue // 目录不存在（~/Applications 常缺）静默跳过
    }
    for (const entry of entries) {
      if (!entry.endsWith('.app')) continue
      const appPath = join(dir, entry)
      if (!statSync(appPath).isDirectory()) continue
      const plist = readAppPlist(appPath)
      // 白名单只放编程 IDE；非 IDE 直接跳过（连图标都不取，省一次 swift 子进程）
      if (!isIdeApp(plist.bundleId, entry)) continue
      const name = plist.name ?? entry.replace(/\.app$/, '')
      const icon = await readAppIcon(appPath)
      apps.push({ name, path: appPath, ...(icon !== null && { icon }) })
    }
  }
  return apps
}

/** 一份 plist 里 Open With 关心的字段 */
interface AppPlist {
  /** CFBundleIdentifier，白名单判定的依据 */
  bundleId: string
  /** CFBundleName，展示名；读不到为 null */
  name: string | null
}

/**
 * 从 .app 的 Info.plist 读 bundleId + name。plist 是二进制或 XML——这里只跑 XML 正则，
 * 匹配不到（二进制 plist）回退 null/空。bundleId 在二进制 plist 下读不到，这种 app 会
 * 被白名单拒绝——可接受（主流 IDE 的 plist 实测都是 XML；少数被拒的，bundleId 正则补不上）。
 */
function readAppPlist(appPath: string): AppPlist {
  try {
    const plistPath = join(appPath, 'Contents', 'Info.plist')
    if (!existsSync(plistPath)) return { bundleId: '', name: null }
    const content = readFileSync(plistPath, 'utf-8')
    const bundleId = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(content)?.[1]
    const name = /<key>CFBundleName<\/key>\s*<string>([^<]*)<\/string>/.exec(content)?.[1]
    return { bundleId: bundleId ?? '', name: name ?? null }
  } catch {
    return { bundleId: '', name: null }
  }
}

/**
 * 编程 IDE 白名单。bundleId 优先（最准），文件名兜底（极少数 app plist 里没有
 * CFBundleIdentifier）。匹配前统一小写，所以下面写法不区分大小写。
 *
 * 覆盖（截至 2026-08 的主流 + 当红 AI IDE）：
 * - 传统 IDE：JetBrains 全家、VS Code、Android Studio、Xcode、Sublime、Nova
 * - 当红 AI IDE：Cursor、Windsurf、Zed、Google Antigravity、Kiro、Trae
 * 加新 IDE 往这两个常量里加一条即可（先查准 bundle id，避免前缀太宽误伤）。
 */
const IDE_BUNDLE_ID_PREFIXES = [
  'com.jetbrains.', // IntelliJ / WebStorm / PyCharm / GoLand / DataGrip / CLion / PhpStorm / Rider / RubyMine / Fleet
  'com.microsoft.vscode', // VS Code（含 insiders）
  'com.google.android.studio',
  'com.apple.dt.xcode',
  'com.sublimetext.',
  'com.panic.nova',
  'dev.zed.', // Zed（dev.zed.Zed，大写 Z 用前缀小写匹配）
]
const IDE_BUNDLE_IDS_EXACT = new Set([
  // 当红 AI IDE（精确 bundle id，避免宽前缀误伤其它 todesktop/exafunction 应用）
  'com.todesktop.230313mzl4w4u92', // Cursor
  'com.exafunction.windsurf', // Windsurf
  'com.google.antigravity', // Google Antigravity
  'dev.kiro.desktop', // Kiro (AWS)
  'cn.trae.app', // Trae
])
const IDE_NAME_KEYWORDS = ['vscode', 'cursor', 'zed', 'windsurf', 'intellij', 'android studio']

function isIdeApp(bundleId: string, entry: string): boolean {
  const id = bundleId.toLowerCase()
  if (IDE_BUNDLE_IDS_EXACT.has(id)) return true
  if (IDE_BUNDLE_ID_PREFIXES.some((prefix) => id.startsWith(prefix))) return true
  const name = entry.toLowerCase()
  return IDE_NAME_KEYWORDS.some((kw) => name.includes(kw))
}

/**
 * 取 app 图标为 base64 PNG data URL（NSWorkspace.icon → 32x32 PNG）。
 * 走一次性 `swift -e` 子进程——NSWorkspace 不挑图标文件位置（.icns / Assets.car /
 * Electron app 都通用），比 iconutil 拆 .icns 更可靠。单次 ~250ms，~2KB。
 * 非 darwin / 失败返回 null（调用方不显示图标，不影响功能）。
 */
async function readAppIcon(appPath: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  return new Promise<string | null>((resolve) => {
    execFile(
      'swift',
      ['-e', APP_ICON_SWIFT_SOURCE, appPath],
      { maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout) => {
        if (error || !stdout || stdout.length === 0) {
          resolve(null)
          return
        }
        resolve(`data:image/png;base64,${stdout.toString('base64')}`)
      },
    )
  })
}

/** NSWorkspace.icon 取图标并缩放到 32x32 PNG（输出到 stdout） */
const APP_ICON_SWIFT_SOURCE = `
import AppKit
import Foundation
let image = NSWorkspace.shared.icon(forFile: CommandLine.arguments[1])
let px = 32
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
rep.size = NSSize(width: px, height: px)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
image.draw(in: NSRect(x: 0, y: 0, width: px, height: px), from: .zero, operation: .sourceOver, fraction: 1.0)
NSGraphicsContext.restoreGraphicsState()
if let png = rep.representation(using: .png, properties: [:]) {
  FileHandle.standardOutput.write(png)
}`

/**
 * File Context Menu: 查询能打开该文件的应用列表（macOS「打开方式」）。
 *
 * 走一次性 `swift -e` 子进程包装 Launch Services 的 LSCopyApplicationURLsForURL——
 * 无原生依赖、冷启 ~140ms。source 经 argv（非 stdin）传入，规避 shell 转义；
 * 文件路径也走 argv，空格/Unicode 免费。
 *
 * 非 darwin 直接返回空数组（调用方据此隐藏「打开方式」菜单项）。
 */
export const openWithApps = async (args: { path: string }): Promise<OpenWithApp[]> => {
  if (process.platform !== 'darwin') return []
  if (!existsSync(args.path)) return []
  return new Promise<OpenWithApp[]>((resolve) => {
    execFile(
      'swift',
      // swift -e 把 source 作为单个 argv 元素，文件路径作为 CommandLine.arguments[1]
      ['-e', OPEN_WITH_SWIFT_SOURCE, args.path],
      { maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve([])
          return
        }
        resolve(parseOpenWithApps(stdout))
      },
    )
  })
}

/** 解析 swift 输出（每行 `name\tbundleId\tpath`）为去重排序的应用列表 */
function parseOpenWithApps(stdout: string): OpenWithApp[] {
  const seen = new Set<string>()
  const apps: OpenWithApp[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trimEnd()
    if (!trimmed) continue
    const [name, bundleId, path] = trimmed.split('\t')
    if (!name || !path) continue
    const key = bundleId || path
    if (seen.has(key)) continue
    seen.add(key)
    apps.push({ name, path })
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name))
}

/** Launch Services 查询源——返回 name\tbundleId\tpath 每行一个应用 */
const OPEN_WITH_SWIFT_SOURCE = `
import CoreServices
import Foundation
let url = URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL
if let raw = LSCopyApplicationURLsForURL(url, .all) {
  let nsarr = raw.takeRetainedValue() as NSArray
  for case let appURL as URL in nsarr {
    let b = Bundle(url: appURL)
    let name = (b?.object(forInfoDictionaryKey: "CFBundleName") as? String) ?? appURL.deletingPathExtension().lastPathComponent
    print("\\(name)\\t\\(b?.bundleIdentifier ?? "")\\t\\(appURL.path)")
  }
}`

/** 从 data:URL 解析出 MIME 与二进制数据 */
function parseDataUrl(url: string): { mime: string; data: Buffer } | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url)
  if (!match) return null
  const mime = match[1] ?? 'image/png'
  const isBase64 = Boolean(match[2])
  const payload = match[3] ?? ''
  const data = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload))
  return { mime, data }
}

/** 从 url / data:URL 推断图片文件名（带扩展名） */
function inferImageName(url: string): string {
  if (url.startsWith('data:')) {
    const mime = /^data:([^;,]+)/.exec(url)?.[1] ?? 'image/png'
    const ext = mime.split('/')[1]?.split('+')[0] ?? 'png'
    return `image.${ext}`
  }
  try {
    const u = new URL(url)
    const base = u.pathname.split('/').pop()?.split('?')[0] ?? ''
    // 有扩展名直接用，否则按常见图片兜底
    if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(base)) return base
    return `${base || 'image'}.png`
  } catch {
    return 'image.png'
  }
}
