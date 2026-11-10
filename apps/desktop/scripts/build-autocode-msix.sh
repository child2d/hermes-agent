#!/usr/bin/env bash
#
# Build an installable Plankton MSIX with the AutoCode payload source baked in.
#
# Who runs this: whoever holds the MSIX signing credentials. An unsigned MSIX
# cannot be installed, so this script refuses to be useful without them —
# it will tell you what is missing instead of producing a dead artifact.
#
# Required env:
#   AZURE_SIGN_ENDPOINT / AZURE_CLIENT_ID / AZURE_SIGN_PUBLISHER   (Trusted Signing)
#   AUTOCODE_PAYLOAD_URL   e.g. https://auto-code.oss-cn-shenzhen.aliyuncs.com/autocode
#   AUTOCODE_OSS_AK / AUTOCODE_OSS_SK   read-only account for the payload bucket
#
# Optional:
#   PLANKTON_ENV=test|dev|prod     (default test)
#   SKIP_SIGN=1                    build unsigned, for inspection only
#
# Usage:
#   cd apps/desktop && ./scripts/build-autocode-msix.sh
#
set -uo pipefail
cd "$(dirname "$0")/.."   # apps/desktop

die() { echo "[autocode-msix] 错误: $*" >&2; exit 1; }
log() { echo "[autocode-msix] $*"; }

PLANKTON_ENV="${PLANKTON_ENV:-test}"
export PLANKTON_ENV

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

# --- 3. 签名 ------------------------------------------------------------------
if [[ "${SKIP_SIGN:-0}" != "1" ]]; then
  [[ -n "${AZURE_SIGN_ENDPOINT:-}" && -n "${AZURE_CLIENT_ID:-}" ]] \
    || die "缺少 AZURE_SIGN_* 签名环境变量。未签名 MSIX 同事装不上。
   只想看产物可以设 SKIP_SIGN=1。"
fi

# --- 4. 构建（国内网络走镜像，否则 electron / packaging tools 下不动）----------
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_CUSTOM_DIR="${ELECTRON_CUSTOM_DIR:-{{ version }}}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"

log "构建渲染层与主进程…"
npm run build || die "npm run build 失败"

log "确认 AutoCode 地址已编入 bundle…"
grep -q "${AUTOCODE_PAYLOAD_URL#https://}" dist/electron-main.mjs \
  || die "bundle 里没有 $AUTOCODE_PAYLOAD_URL —— define 没生效，检查 bundle-electron-main.mjs"

log "打包 MSIX…"
npm run builder -- --win msix --publish never || die "electron-builder 失败（签名或工具下载环节，看上面的输出）"

MSIX="$(ls -t release/*.msix 2>/dev/null | head -1)"
[[ -n "$MSIX" ]] || die "没找到 .msix 产物"
log "完成: $(cd "$(dirname "$MSIX")" && pwd)/$(basename "$MSIX")"
log "同事安装后点左侧栏 AutoCode 即可；首次会下载代码并建一次 venv（约 1-2 分钟）"
