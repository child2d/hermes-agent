#!/usr/bin/env bash
# One-command Plankton (enterprise) build.
#
# Pins every build-time variable the enterprise pack needs, guarantees the
# first-launch model-seed resource exists, refreshes the bundled engine payload
# from HEAD, then runs the normal `npm run pack` (frontend + electron bundle,
# then electron-builder --dir). No arguments.
#
#   cd apps/desktop && npm run pack:plankton
#
# Artifact: apps/desktop/release/mac-arm64/Plankton.app
# See apps/desktop/ENTERPRISE.md ("Build / pack / distribution").
set -euo pipefail
cd "$(dirname "$0")/.." # apps/desktop
REPO_ROOT="$(cd ../.. && pwd)"

# --- build-time pins (all overridable from the environment) -------------------
HERMES_PYTHON="${HERMES_PYTHON:-/opt/homebrew/bin/python3}"
ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://registry.npmmirror.com/-/binary/electron/}"
export HERMES_PYTHON
export ELECTRON_MIRROR
export HERMES_DESKTOP_VARIANT=plankton
# Unsigned local build (no Apple Developer identity on this machine).
export CSC_IDENTITY_AUTO_DISCOVERY=false

# --- first-launch model seed resource ----------------------------------------
# The real seed (which may carry the provider key) lives here on the build
# machine only; build/ is gitignored, so it never enters git. Absent, drop a
# non-secret placeholder so the pack-time Resources copy never dangles.
SEED_DIR="build/enterprise"
SEED="$SEED_DIR/model-seed.json"
mkdir -p "$SEED_DIR"
if [ ! -f "$SEED" ]; then
  cat >"$SEED" <<'JSON'
{
  "provider": "deepseek",
  "model": "deepseek-v4-flash",
  "base_url": "https://api.deepseek.com"
}
JSON
  chmod 600 "$SEED"
  echo "[plankton-pack] wrote keyless seed placeholder: $SEED"
fi

# --- refresh the bundled engine payload from HEAD ----------------------------
# build/agent-payload is a `git archive HEAD` snapshot (scripts/bundles/
# native.py:_prepare_native), so uncommitted source never reaches the packaged
# engine. Refresh the snapshot's source tree so the shipped engine matches the
# committed code; refuse to build a snapshot that would silently lag the tree.
if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  echo "[plankton-pack] ERROR: working tree is dirty; the engine payload is a HEAD snapshot." >&2
  echo "[plankton-pack]        Commit (or stash) your changes, then re-run." >&2
  exit 1
fi
PAYLOAD="build/agent-payload"
if [ -d "$PAYLOAD/hermes-agent" ]; then
  echo "[plankton-pack] refreshing payload source from HEAD"
  tmp="$(mktemp -d)"
  git -C "$REPO_ROOT" archive --format=tar HEAD -- \
    ':(exclude)tests' ':(exclude)tests-js' ':(exclude)website' ':(exclude)evals' \
    ':(exclude).github' ':(exclude)nix' ':(exclude)docker' ':(exclude)apps' \
    ':(exclude)ui-tui' ':(exclude)web' ':(exclude)scripts' | tar -x -C "$tmp"
  rm -rf "$PAYLOAD/hermes-agent"
  mv "$tmp" "$PAYLOAD/hermes-agent"
fi

echo "[plankton-pack] HERMES_PYTHON=$HERMES_PYTHON"
echo "[plankton-pack] ELECTRON_MIRROR=$ELECTRON_MIRROR"
echo "[plankton-pack] start  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
npm run pack
echo "[plankton-pack] done   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[plankton-pack] artifact: $(pwd)/release/mac-arm64/Plankton.app"
