/**
 * Packaging Slimming: 删掉本次构建架构用不上的 claude 平台二进制。
 *
 * `@anthropic-ai/claude-agent-sdk` 把 CLI 二进制拆成 8 个 optionalDependencies
 * （darwin/win32/linux × x64/arm64，linux 还有 musl 变体），每个约 245~254MB。
 * electron-builder 收集 node_modules 时只按 package.json 的 `os` 字段过滤，
 * **不看 `cpu`**——实测 arm64 的 dmg 里 darwin-arm64(245M) 和 darwin-x64(254M)
 * 两个都在，安装包白白多一倍。
 *
 * 为什么只能在这里删，而不是写进 electron-builder.yml 的 files：
 * node_modules 走的是独立的 file matcher（app-builder-lib 的
 * getNodeModuleFileMatcher），它只接受 `!` 排除规则、不接受白名单，所以没法表达
 * "排除全部平台包，再按 ${arch} 放回当前这个"。而单写死 `!...-x64/**` 又会在
 * 构建 x64 时把唯一需要的那个删掉。
 *
 * 只删 app.asar.unpacked 里的二进制（大头）；asar 内残留的 package.json/LICENSE
 * 只有几 KB，且 SDK 不会去 resolve 一个当前平台用不到的包，留着无害。
 */

const fs = require('node:fs')
const path = require('node:path')

// electron-builder 的 Arch 是数字 enum，afterPack 拿到的是数字。
const ARCH_NAMES = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
}

const SDK_SCOPE_DIR = 'node_modules/@anthropic-ai'
const PLATFORM_PKG_PREFIX = 'claude-agent-sdk-'

function formatMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function dirSize(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(full)
    else if (entry.isFile()) total += fs.statSync(full).size
  }
  return total
}

/** macOS 的 unpacked 在 .app bundle 里，win/linux 在 appOutDir/resources 下。 */
function resolveUnpackedScopeDir(appOutDir, electronPlatformName) {
  if (electronPlatformName === 'darwin') {
    const appBundle = fs
      .readdirSync(appOutDir)
      .find((name) => name.endsWith('.app'))
    if (!appBundle) return null
    return path.join(
      appOutDir,
      appBundle,
      'Contents/Resources/app.asar.unpacked',
      SDK_SCOPE_DIR
    )
  }
  return path.join(appOutDir, 'resources/app.asar.unpacked', SDK_SCOPE_DIR)
}

exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context
  const archName = ARCH_NAMES[context.arch]

  // universal 包按定义要同时带 x64 和 arm64，一个都不能删。
  if (archName === 'universal') {
    console.log('  • after-pack: universal 构建，保留全部架构的 claude 二进制')
    return
  }

  const scopeDir = resolveUnpackedScopeDir(appOutDir, electronPlatformName)
  if (!scopeDir || !fs.existsSync(scopeDir)) {
    console.warn(`  • after-pack: 未找到 ${SDK_SCOPE_DIR}，跳过（路径可能变了）`)
    return
  }

  const keep = `${PLATFORM_PKG_PREFIX}${electronPlatformName}-${archName}`
  const platformPkgs = fs
    .readdirSync(scopeDir)
    .filter((name) => name.startsWith(PLATFORM_PKG_PREFIX))

  if (!platformPkgs.includes(keep)) {
    // 与其静默产出一个跑不起来的包，不如让构建失败。
    throw new Error(
      `after-pack: 目标架构的 claude 二进制 ${keep} 不存在（现有：${platformPkgs.join(', ') || '无'}）。` +
        `检查 pnpm.supportedArchitectures 是否覆盖了 ${electronPlatformName}-${archName}。`
    )
  }

  let freed = 0
  for (const pkg of platformPkgs) {
    if (pkg === keep) continue
    const full = path.join(scopeDir, pkg)
    freed += dirSize(full)
    fs.rmSync(full, { recursive: true, force: true })
    console.log(`  • after-pack: 删除 ${pkg}`)
  }

  console.log(
    `  • after-pack: ${electronPlatformName}-${archName} 保留 ${keep}，释放 ${formatMB(freed)}`
  )
}
