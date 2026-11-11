#!/usr/bin/env bash
#
# Build a distributable Plankton installer with the AutoCode payload source
# baked in, so a colleague's install works with zero configuration.
#
#   Windows (MSYS)  → NSIS .exe   (unsigned is fine; SmartScreen needs one click)
#   macOS           → .dmg        (needs a Mac; unsigned trips Gatekeeper)
#
# Required env (both platforms):
#   AUTOCODE_PAYLOAD_URL   e.g. https://auto-code.oss-cn-shenzhen.aliyuncs.com/autocode
#   AUTOCODE_OSS_AK / AUTOCODE_OSS_SK   read-only account for the payload bucket
#
# Prerequisites that are NOT in git:
#   build/agent-payload     the agent runtime (copy from an installed Plankton, or `npm run payload`)
#   build/enterprise/*      model-seed.json / sso-config.json / cli, staged by plankton-pack.sh
#
# Optional:
#   PLANKTON_ENV=test|dev|prod     (default test)
#   HERMES_PYTHON=<python>         (default: `python` on PATH)
#
# Usage:
#   cd apps/desktop && ./scripts/build-autocode-installer.sh
#
set -uo pipefail
cd "$(dirname "$0")/.."   # apps/desktop
REPO_ROOT="$(cd ../.. && pwd)"

die() { echo "[autocode-installer] 错误: $*" >&2; exit 1; }
log() { echo "[autocode-installer] $*"; }

PLANKTON_ENV="${PLANKTON_ENV:-test}"
export PLANKTON_ENV

# --- 平台分流 ----------------------------------------------------------------
# Windows: NSIS 安装器（.exe）。注意本仓库的打包脚手架在 Windows 上只白名单了
# dir/msix/zip，所以这里绕过它直接调 electron-builder。
# macOS:   .dmg 只能在 macOS 上构建（hdiutil / codesign 是系统工具），走官方
# 的 pack:plankton --dmg 通道。
case "$(uname -s)" in
  Darwin)
    export HERMES_PYTHON="${HERMES_PYTHON:-$(command -v python3)}"
    log "macOS：构建 .dmg"
    npm run build || die "npm run build 失败"
    npm run pack:plankton -- --dmg || die "dmg 构建失败（看签名与 payload staging 输出）"
    ls -lh release/*/*.dmg release/*.dmg 2>/dev/null | tail -3
    log "注意：未签名的 dmg 在别人机器上会被 Gatekeeper 拦，需右键打开或 xattr -dr com.apple.quarantine"
    exit 0
    ;;
  MINGW*|MSYS*|CYGWIN*) : ;;
  *) die "只支持 Windows(MSYS) 与 macOS" ;;
esac

# --- variant: extraResources only ships agent-payload for plankton variants ---
VARIANT="$(node -e '
  const spec = require(process.cwd() + "/plankton-envs.cjs").planktonEnvByName(process.argv[1])
  if (!spec) process.exit(1)
  process.stdout.write(spec.variant)
' "$PLANKTON_ENV")" || die "PLANKTON_ENV 必须是 test/dev/prod（当前: $PLANKTON_ENV）"
export HERMES_DESKTOP_VARIANT="$VARIANT"
log "env=$PLANKTON_ENV variant=$VARIANT"

# --- 1. agent 运行时必须已就绪 ------------------------------------------------
# 缺了它应用能开，但 AutoCode 里跑 agent 会失败（找不到 hermes-acp）。
if [[ ! -x build/agent-payload/bin/hermes-acp.exe && ! -f build/agent-payload/manifest.json ]]; then
  die "缺少 build/agent-payload。二选一：
  a) 从已安装的 Plankton 复制：robocopy \"C:\\Program Files\\WindowsApps\\<包名>\\app\\resources\\agent-payload\" build\\agent-payload /E
  b) 从源码构建：npm run payload   （需要 python3 + 网络，耗时较长）"
fi
log "agent-payload: $(du -sh build/agent-payload 2>/dev/null | cut -f1)"

# --- 2. AutoCode 更新源必须内置 -----------------------------------------------
# 否则同事装完点开只会显示「未找到源码目录」。
[[ -n "${AUTOCODE_PAYLOAD_URL:-}" ]] || die "缺少 AUTOCODE_PAYLOAD_URL（不内置的话，同事机器上点开是「未就绪」）"
[[ -n "${AUTOCODE_OSS_AK:-}" && -n "${AUTOCODE_OSS_SK:-}" ]] || die "缺少 AUTOCODE_OSS_AK / AUTOCODE_OSS_SK（该 bucket 关闭了匿名读，必须带签名）"
log "AutoCode 更新源: $AUTOCODE_PAYLOAD_URL"

# --- 3. enterprise 资源（staging 产物，绕过 plankton-pack.sh 时必须自备）------
for f in build/enterprise/model-seed.json build/enterprise/sso-config.json build/enterprise/cli/win32-x64/shaoke-cli.exe; do
  [[ -f "$f" ]] || die "缺少 $f（plankton-pack.sh 的 staging 步骤产出）。
  快速补救：从已安装的 Plankton 复制 resources/enterprise 下的同名文件到 build/enterprise/。"
done
log "enterprise 资源: 就绪"

# --- 4. 构建 ------------------------------------------------------------------
# NSIS 里 payload 里的二进制要由一个 python 辅助脚本处理
export HERMES_PYTHON="${HERMES_PYTHON:-python}"
[[ -x "$HERMES_PYTHON" ]] || command -v "$HERMES_PYTHON" >/dev/null || die "HERMES_PYTHON 不可执行: $HERMES_PYTHON"

export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_CUSTOM_DIR="${ELECTRON_CUSTOM_DIR:-{{ version }}}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}"

log "构建渲染层与主进程…"
npm run build || die "npm run build 失败"

log "确认 AutoCode 地址已编入 bundle…"
grep -q "${AUTOCODE_PAYLOAD_URL#https://}" dist/electron-main.mjs \
  || die "bundle 里没有 $AUTOCODE_PAYLOAD_URL —— define 没生效，检查 bundle-electron-main.mjs"

# 直接调 electron-builder：run-electron-builder.mjs 在 Windows 上只允许 dir/msix/zip，
# 不含 nsis。compression=store 避免对 4GB payload 做 LZMA（会慢到不可接受）。
log "打包 NSIS 安装器（.exe）…"
"$REPO_ROOT/node_modules/.bin/electron-builder" --config electron-builder.config.cjs \
  --win nsis --publish never -c.compression=store || die "electron-builder 失败（看上面输出）"

EXE="$(ls -t release/*.exe 2>/dev/null | head -1)"
[[ -n "$EXE" ]] || die "没找到 .exe 产物"

# post-build 闸门：这三样缺任何一样，装出来都会在登录页报「登录组件未就绪」
# 或点开 AutoCode 报「未找到源码目录」——都在别人的机器上才发现，所以在这里拦。
for f in release/win-unpacked/resources/enterprise/sso-config.json \
         release/win-unpacked/resources/enterprise/model-seed.json \
         release/win-unpacked/resources/agent-payload; do
  [[ -e "$f" ]] || die "产物里缺少 $f —— 打出来的包同事用不了"
done
log "产物自检通过（sso-config / model-seed / agent-payload 都在）"
log "完成: $(cd "$(dirname "$EXE")" && pwd)/$(basename "$EXE")（$(du -h "$EXE" | cut -f1)）"
log "未签名：同事首次运行会遇到 SmartScreen，点「更多信息 → 仍要运行」"
log "同事安装后点左侧栏 AutoCode；首次会下载代码并建一次 venv（约 1-2 分钟）"
