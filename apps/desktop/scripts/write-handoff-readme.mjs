#!/usr/bin/env node
/**
 * write-handoff-readme.mjs — the README that travels WITH a Plankton artifact.
 *
 * Why it is GENERATED and not hand-written: every hand-off build needs the right
 * version, app id, sha256 and build commit in it, and a stale sha256 in a
 * hand-off note is worse than none (the colleague "verifies" against the wrong
 * number). `plankton-pack.sh` calls this automatically right after a dmg lands,
 * so the note next to the artifact always describes THAT artifact.
 *
 *   node scripts/write-handoff-readme.mjs <artifact> [--app <Plankton.app>] [--out <file.md>]
 *
 * The content is what a colleague needs on the receiving machine: how to install
 * it, why an UNSIGNED build shows "已损坏" (quarantine + Gatekeeper, not
 * corruption), the three commands that prove which one it is, the one-liner that
 * fixes it, and the log command that traces the decision.
 */

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TAG = '[plankton-handoff]'

/** Quote a value for a shell example only when it needs it. */
const quote = value => (/[^\w\-./:=@]/.test(value) ? `"${value}"` : value)

/** The engine home this environment's app uses: the segment comes from the
 *  plankton-envs table, and prod's historical root carries none. */
function engineHomeFor(spec, platform = process.platform) {
  const segment = spec && spec.homeDir ? `${spec.homeDir}/` : ''
  return platform === 'win32'
    ? `%LOCALAPPDATA%\\plankton\\${segment.replace(/\//g, '\\')}engine\\home`
    : `~/.plankton/${segment}engine/home`
}

/** Where the app keeps desktop state — Electron derives it from the baked app
 *  name (ENTERPRISE.md §2 lists all three environments). */
function desktopStateFor(spec, platform = process.platform) {
  const pascal = (spec && spec.pascal) || 'Plankton'
  return platform === 'win32' ? `%APPDATA%\\${pascal}` : `~/Library/Application Support/${pascal}`
}

/**
 * Build the hand-off note for one artifact.
 * @param {{ artifactPath: string, appDir?: string, env?: string, platform?: NodeJS.Platform }} options
 * @returns {{ markdown: string, sha256: string, appName: string, envName: string, version: string }}
 */
export function handoffReadmeFor({ artifactPath, appDir = '', env = '', platform = process.platform }) {
  const require = createRequire(import.meta.url)
  const { planktonEnvByName } = require(path.join(APP_DIR, 'plankton-envs.cjs'))

  const resolved = path.resolve(artifactPath)
  if (!fs.existsSync(resolved)) {
    throw new Error(`no such artifact: ${resolved}`)
  }
  const artifactName = path.basename(resolved)
  const sizeMb = (fs.statSync(resolved).size / (1024 * 1024)).toFixed(0)

  // Name/version come off the file name; identity, when available, off the app
  // bundle next to the artifact (a dmg's own copy needs mounting, the .app does not).
  const stem = artifactName.replace(/\.(dmg|app|msix|exe|zip)$/i, '')
  const version = (stem.match(/-(\d+\.\d+\.\d+)/) || [])[1] || 'unknown'

  let appDirPath = appDir ? path.resolve(appDir) : ''
  if (!appDirPath) {
    for (const root of [path.dirname(resolved), path.join(path.dirname(resolved), 'mac-arm64')]) {
      if (!fs.existsSync(root)) continue
      const found = fs
        .readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name.endsWith('.app'))
        .map(entry => path.join(root, entry.name))[0]
      if (found) {
        appDirPath = found
        break
      }
    }
  }

  let appName = stem.replace(/\d+\.\d+\.\d+.*$/, '').replace(/-$/, '') || 'Plankton'
  let appId = ''
  let buildCommit = ''
  let buildBranch = ''
  let builtAt = ''
  const plist = appDirPath ? path.join(appDirPath, 'Contents', 'Info.plist') : ''
  if (plist && fs.existsSync(plist)) {
    try {
      const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }))
      appName = info.CFBundleName || appName
      appId = info.CFBundleIdentifier || ''
    } catch {
      /* best effort: the note stays useful without the bundle identity */
    }
  }
  const stampPath = appDirPath ? path.join(appDirPath, 'Contents', 'Resources', 'install-stamp.json') : ''
  if (stampPath && fs.existsSync(stampPath)) {
    try {
      const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'))
      buildCommit = stamp.commit || ''
      buildBranch = stamp.branch || ''
      builtAt = stamp.builtAt || ''
    } catch {
      /* ignore */
    }
  }

  // Environment: the artifact's own release directory first (`release/<env>/`),
  // then the caller, then PLANKTON_ENV, then prod.
  const envFromPath = (resolved.match(/release[\\/](dev|test|prod)[\\/]/) || [])[1] || ''
  const spec = planktonEnvByName(envFromPath || env || process.env.PLANKTON_ENV || 'prod') || null
  const variant = spec ? spec.variant : ''
  const envName = spec ? spec.env : 'prod'
  const engineHome = engineHomeFor(spec, platform)
  const desktopState = desktopStateFor(spec, platform)

  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex')
  const isDmg = artifactName.toLowerCase().endsWith('.dmg')
  const appInstalled = `/Applications/${appName}.app`

  const markdown = `# ${appName} 安装说明

| | |
|---|---|
| 安装包 | \`${artifactName}\`（${sizeMb} MB）|
| 应用 | ${appName} ${version}${appId ? ` · \`${appId}\`` : ''} |
| 环境 | **${envName}**${variant ? `（\`${variant}\`）` : ''} —— 独立应用，与你机器上其它 Plankton 环境并存、互不干扰 |
| SHA-256 | \`${sha256}\` |
${buildCommit ? `| 构建 | \`${buildBranch || ''}\` @ \`${buildCommit.slice(0, 10)}\`${builtAt ? ` · ${builtAt}` : ''} |\n` : ''}
## 安装

1. 双击 \`${artifactName}\`，把 **${appName}.app** 拖进「应用程序」文件夹。
2. 打开它。首次启动会初始化本环境的引擎（内置运行时，不需要另装 Python，也不需要联网下载）。
3. 登录：包内已带本环境的登录配置，直接登录即可。

## 打开时提示「已损坏，无法打开」怎么办

**这不是安装包损坏**，可以放心。这个包是内部构建，**没有 Apple 开发者签名、也没有公证**；
只要文件是通过浏览器、微信、邮件、网盘等渠道传过来的，macOS 会给它打上 \`com.apple.quarantine\`
（隔离）标记，而 Gatekeeper 对「带隔离标记 + 拿不出可信签名」的应用统一报「已损坏」。程序本身是好的。

### 1) 先确认是哪一类（看第一条就够）

\`\`\`bash
# 有输出 = 就是隔离标记的问题（末尾字段能看到是谁打的，如 WeChat / Safari）
xattr -p com.apple.quarantine ${quote(appInstalled)}

# 签名状态：期望看到 Signature=adhoc、TeamIdentifier=not set
codesign -dvv ${quote(appInstalled)} 2>&1 | grep -E "Signature|TeamIdentifier|Authority"

# Gatekeeper 的判定
spctl -a -vvv -t exec ${quote(appInstalled)}
\`\`\`

### 2) 去掉隔离标记（要用 sudo —— 这个包的引擎目录是只读的）

\`\`\`bash
sudo xattr -dr com.apple.quarantine ${quote(appInstalled)}
open ${quote(appInstalled)}
\`\`\`

> \`sudo\` 是必需的，不是保险：包内置的引擎目录 \`Contents/Resources/agent-payload/\` 有约 2.4 万个只读文件
> （权限 0444，防止运行时被改写），而删除扩展属性需要对该文件有写权限。用普通用户执行会刷一屏
> \`xattr: [Errno 13] Permission denied\` —— 那是权限问题，**不是包损坏**，别据此判断安装包坏了。
> 不想用 sudo 的话：先 \`xattr -d com.apple.quarantine <安装包>.dmg\` 去掉镜像自身的隔离位，
> 再重新挂载、把 app 拷出来（拷出来的副本就不会带隔离位）。
> 「右键 → 打开」对「已损坏」**无效**（那只对「无法验证开发者」有效）；请用上面这条。

### 3) 想看系统日志（追踪这次拦截）

\`\`\`bash
log show --last 5m --info --debug --predicate \\
  'process == "syspolicyd" OR process == "amfid" OR process == "taskgated"' \\
  | grep -i -E "plankton|quarantine|notariz|assess|denied|amfi"

# 实时看（复现一次）： log stream --info --predicate 'process == "syspolicyd" OR process == "amfid"'
\`\`\`

看到 \`quarantine\`、\`Error checking with notarization daemon\`、\`Assessment failed\` 属于这一类；
若日志里是签名/结构损坏相关的报错，把原文发回，另作判断。

### 4) 以后避免再遇到：换一条不打隔离标记的通道

\`curl\`、U 盘、\`scp\`/SMB 拷贝都**不会**打这个标记；浏览器、微信、邮件、AirDrop 会。

\`\`\`bash
curl -fSLO <分发地址>/${artifactName}
shasum -a 256 ${artifactName}     # 必须与本文件顶部的 SHA-256 一致
\`\`\`

## 校验下载是否完整

\`\`\`bash
shasum -a 256 ~/Downloads/${artifactName}    # 与本文件顶部的 SHA-256 一致
${isDmg ? `hdiutil verify ~/Downloads/${artifactName}    # 期望 "... is VALID"` : ''}
\`\`\`

## 数据在哪 / 怎么卸载

- 桌面状态：\`${desktopState}\`
- 引擎数据（配置、会话、技能、日志、工具）：\`${engineHome}\`
- 卸载：把 ${quote(appInstalled)} 拖进废纸篓；要连数据一起清空，再删掉上面两个目录。

> 同一个环境不要同时开两个实例（共用一份 \`state.db\`）；不同环境可以同时开。

---

**内部备注（分发方看，请勿上传公网）**：本包未签名、未公证，且内置本环境的 SSO 配置
（\`Contents/Resources/enterprise/sso-config.json\` 含客户端密钥与内网 issuer）。
给同事试装请走内网通道；要能「任何渠道双击即开」，需 Developer ID 签名 + 公证。
`

  return { markdown, sha256, appName, envName, version }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isMain) {
  const argv = process.argv.slice(2)
  let artifact = ''
  let appArg = ''
  let outArg = ''
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--app') appArg = argv[++i] || ''
    else if (arg === '--out') outArg = argv[++i] || ''
    else if (arg.startsWith('--app=')) appArg = arg.slice('--app='.length)
    else if (arg.startsWith('--out=')) outArg = arg.slice('--out='.length)
    else if (!artifact) artifact = arg
    else {
      console.error(`${TAG} unknown argument '${arg}'`)
      process.exit(1)
    }
  }
  if (!artifact) {
    console.error('usage: node scripts/write-handoff-readme.mjs <artifact> [--app <App.app>] [--out <file.md>]')
    process.exit(1)
  }
  const built = handoffReadmeFor({ artifactPath: artifact, appDir: appArg })
  const outPath = outArg
    ? path.resolve(outArg)
    : path.join(
        path.dirname(path.resolve(artifact)),
        `${path.basename(artifact).replace(/\.[^.]+$/, '')}.安装说明.md`
      )
  fs.writeFileSync(outPath, built.markdown)
  console.log(`${TAG} wrote ${outPath}`)
  console.log(`${TAG}   artifact=${path.resolve(artifact)}`)
  console.log(`${TAG}   sha256=${built.sha256}`)
}
