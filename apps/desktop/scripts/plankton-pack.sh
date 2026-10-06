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

# --- bundled shaoke-cli (per-OS/arch) ----------------------------------------
# The artifact carries a CLI copy that first launch drops into
# <HERMES_HOME>/bin (see electron/enterprise-cli.ts). The binary must NOT live
# in git, so it is staged here into the gitignored build/ tree. Source:
#   $PLANKTON_SHAOKE_CLI_SRC (explicit), else the CLI on PATH.
# after-pack independently asserts it landed in the app (R1, fail-closed).
case "$(uname -s)" in
  Darwin) PACK_OS=darwin ;;
  Linux)  PACK_OS=linux ;;
  *)      PACK_OS="$(uname -s | tr '[:upper:]' '[:lower:]')" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) PACK_ARCH=arm64 ;;
  x86_64|amd64)  PACK_ARCH=x64 ;;
  *)             PACK_ARCH="$(uname -m)" ;;
esac
CLI_DIR="build/enterprise/cli/${PACK_OS}-${PACK_ARCH}"
CLI_DEST="$CLI_DIR/shaoke-cli"
[ "$PACK_OS" = win32 ] && CLI_DEST="$CLI_DIR/shaoke-cli.exe"
CLI_SRC="${PLANKTON_SHAOKE_CLI_SRC:-$(command -v shaoke-cli || true)}"
if [ -z "$CLI_SRC" ] || [ ! -f "$CLI_SRC" ]; then
  echo "[plankton-pack] ERROR: no shaoke-cli to bundle (set PLANKTON_SHAOKE_CLI_SRC, or put shaoke-cli on PATH)." >&2
  echo "[plankton-pack]        The artifact must carry the CLI; refusing to pack without it." >&2
  exit 1
fi
mkdir -p "$CLI_DIR"
cp -f "$CLI_SRC" "$CLI_DEST"
chmod 755 "$CLI_DEST"
if [ ! -x "$CLI_DEST" ]; then
  echo "[plankton-pack] ERROR: staged CLI is not executable: $CLI_DEST" >&2
  exit 1
fi
# Format + architecture: present+executable is not enough — a wrong-OS or
# wrong-arch binary (e.g. PLANKTON_SHAOKE_CLI_SRC pointing at another platform's
# build) is just as unrunnable. Prove the staged SOURCE's magic matches the
# target before it is packed (after-pack re-checks the packaged copy).
node scripts/plankton-cli-format.mjs assert --platform "$PACK_OS" --arch "$PACK_ARCH" --file "$CLI_DEST" \
  || { echo "[plankton-pack] ERROR: staged CLI failed format/arch validation (see above)." >&2; exit 1; }
echo "[plankton-pack] staged CLI: $CLI_DEST (from $CLI_SRC)"

# The enterprise plugin payload is committed in-repo; assert it is present so a
# packaging run cannot silently ship without it (after-pack asserts again).
# Includes the baymax pack's ONE skill (skills/baymax/SKILL.md): the agent-facing
# carrier of the domain command surface / agent instructions / onboarding (W2,
# N2 §0.1). __init__.py is fail-closed on it, so a staged artifact without it
# would ship green and only die at plugin load — enumerate it here so the pack
# stops before that.
PLUGIN_PAYLOAD="enterprise/plankton-enterprise"
for required in plugin.yaml __init__.py dashboard/manifest.json dashboard/plugin_api.py desktop/plugin.js skills/baymax/SKILL.md; do
  if [ ! -s "$PLUGIN_PAYLOAD/$required" ]; then
    echo "[plankton-pack] ERROR: enterprise plugin payload incomplete under $PLUGIN_PAYLOAD (missing/empty: $required)" >&2
    exit 1
  fi
done

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
