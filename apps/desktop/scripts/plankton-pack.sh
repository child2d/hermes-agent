#!/usr/bin/env bash
# One-command Plankton (enterprise) build.
#
# Pins every build-time variable the enterprise pack needs, guarantees the
# first-launch model-seed resource exists, refreshes the bundled engine payload
# from HEAD, then runs the normal `npm run pack` (frontend + electron bundle,
# then electron-builder --dir). No arguments.
#
#   cd apps/desktop && npm run pack:plankton          # unpacked .app (local install)
#   cd apps/desktop && npm run pack:plankton -- --dmg # distributable .dmg (hand-off)
#
#   PLANKTON_ENV=dev|test|prod picks the environment (default prod). A non-prod
#   build is a SEPARATE app (own id/name/userData/engine home) and lands in
#   release/<env>/ so it can never overwrite another environment's artifact.
#
# Artifact: apps/desktop/release/mac-arm64/Plankton.app (.dmg next to it with --dmg)
# See apps/desktop/ENTERPRISE.md ("Build / pack / distribution").
set -euo pipefail
cd "$(dirname "$0")/.." # apps/desktop
REPO_ROOT="$(cd ../.. && pwd)"

# --- environment selection ---------------------------------------------------
# Plankton ships one INDEPENDENT app per environment (see plankton-envs.cjs):
#
#   PLANKTON_ENV=prod → variant plankton      → ~/.plankton/engine/home
#   PLANKTON_ENV=test → variant plankton-test → ~/.plankton/test/engine/home
#   PLANKTON_ENV=dev  → variant plankton-dev  → ~/.plankton/dev/engine/home
#
# Each gets its own app id, app name, desktop userData dir and engine home, so
# the three installs coexist on one machine without sharing state. The variant
# is BAKED into the artifact (identity + install stamp): the running app derives
# its environment from itself, never from a variable in the shell it was
# launched from — which is the whole point of splitting them.
PLANKTON_ENV="${PLANKTON_ENV:-prod}"
ENV_SPEC="$(node -e '
  const spec = require(process.cwd() + "/plankton-envs.cjs").planktonEnvByName(process.argv[1])
  if (!spec) process.exit(1)
  process.stdout.write(`${spec.variant} ${spec.env}`)
' "$PLANKTON_ENV")" || {
  echo "[plankton-pack] ERROR: PLANKTON_ENV must be dev, test or prod (got '${PLANKTON_ENV}')." >&2
  exit 1
}
VARIANT="${ENV_SPEC%% *}"

# --- build-time pins (all overridable from the environment) -------------------
HERMES_PYTHON="${HERMES_PYTHON:-/opt/homebrew/bin/python3}"
ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://registry.npmmirror.com/-/binary/electron/}"
export HERMES_PYTHON
export ELECTRON_MIRROR
export HERMES_DESKTOP_VARIANT="$VARIANT"
# Signing is OFF by default: this machine has no Apple Developer identity, and
# auto-discovery would otherwise fail the pack. Both switches stay overridable,
# so a machine WITH a "Developer ID Application" cert signs by exporting
# CSC_IDENTITY_AUTO_DISCOVERY=true (or CSC_LINK/CSC_KEY_PASSWORD for CI), and
# notarization then runs if APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER
# are set (scripts/notarize.mjs runs from afterSign).
export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}"
echo "[plankton-pack] env=$PLANKTON_ENV variant=$VARIANT"

# --- per-environment manifest (non-secret) -----------------------------------
# This build's OWN environment description (SSO client id + issuer, provider
# defaults, update feed, feature switches) travels in the artifact as
# Resources/enterprise/env.json. Committed in git: a hand-off build must carry
# its environment with it instead of depending on what the build machine had
# configured. It carries NO secret — the SSO client_secret is a SEPARATE,
# explicitly staged resource (`build/enterprise/sso-config.json`, below), and
# that split is deliberate: the environment description must not become the
# place a credential hides. Refuse to pack without it — a build whose
# environment description is missing ships green and fails end to end at
# someone else's desk.
ENV_MANIFEST="enterprise/envs/${PLANKTON_ENV}.json"
if [ ! -s "$ENV_MANIFEST" ]; then
  echo "[plankton-pack] ERROR: missing per-environment manifest $ENV_MANIFEST" >&2
  exit 1
fi
node -e '
  const json = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  if (json.env !== process.argv[2]) {
    console.error(`${process.argv[1]} declares env=${json.env}, expected ${process.argv[2]}`)
    process.exit(1)
  }
' "$ENV_MANIFEST" "$PLANKTON_ENV" || {
  echo "[plankton-pack] ERROR: $ENV_MANIFEST does not declare env=$PLANKTON_ENV." >&2
  exit 1
}
echo "[plankton-pack] manifest: $ENV_MANIFEST → Resources/enterprise/env.json"

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

# --- SSO client secret (zero-config first login) ------------------------------
# The artifact carries Resources/enterprise/sso-config.json so a colleague who
# installs the dmg can log in without provisioning anything. The secret is a
# tenant credential: it lives OUTSIDE the repo (build/ is gitignored) and is
# staged here from this machine's local plankton-state file — or from
# $PLANKTON_SSO_SECRET_FILE. Shipping it means anyone who has the dmg can read
# it; that is the accepted trade for zero-config. What must NOT be in that file
# is the identity source: issuer / client id / redirect are pinned in
# electron/plankton-sso.ts and any such keys here are ignored.
SSO_DEST="build/enterprise/sso-config.json"
SSO_SRC="${PLANKTON_SSO_SECRET_FILE:-}"
if [ -z "$SSO_SRC" ]; then
  for candidate in \
    "$HOME/Library/Application Support/Plankton/plankton-state/sso-config.local.json" \
    "$HOME/.plankton/engine/home/plankton-state/sso-config.local.json"; do
    if [ -f "$candidate" ]; then
      SSO_SRC="$candidate"
      break
    fi
  done
fi
if [ -z "$SSO_SRC" ] || [ ! -f "$SSO_SRC" ]; then
  rm -f "$SSO_DEST"
  echo "[plankton-pack] ERROR: no SSO client secret to bundle." >&2
  echo "[plankton-pack]        A plankton artifact without it installs but CANNOT log in," >&2
  echo "[plankton-pack]        so this is a failed build, not a warning." >&2
  echo "[plankton-pack]        Put sso-config.local.json in the app's plankton-state dir, or set" >&2
  echo "[plankton-pack]        PLANKTON_SSO_SECRET_FILE=/path/to/sso-config.local.json." >&2
  exit 1
fi
cp -f "$SSO_SRC" "$SSO_DEST"
chmod 600 "$SSO_DEST"
echo "[plankton-pack] staged SSO secret: $SSO_SRC -> $SSO_DEST (ships inside the artifact)"

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
for required in plugin.yaml __init__.py proposals.py audit_unit.py audit_egress.py audit_wiring.py audit_transport.py dashboard/manifest.json dashboard/plugin_api.py desktop/plugin.js skills/baymax/SKILL.md; do
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
# Output land: default = electron-builder's own `directories.output` (release/);
# PLANKTON_OUTPUT_DIR redirects it (e.g. a build outside the repo) — never touch a
# running instance's `release/` by accident. The artifact path printed below is
# DERIVED from this, never hardcoded: a redirected build used to print a path that
# did not exist (it misled a reviewer).
OUTPUT_DIR="$(node -e "const c=require('./electron-builder.config.cjs');process.stdout.write(String(c.directories?.output||'release'))")"
REDIRECT_OUTPUT=0
if [ -n "${PLANKTON_OUTPUT_DIR:-}" ]; then
  OUTPUT_DIR="$PLANKTON_OUTPUT_DIR"
  REDIRECT_OUTPUT=1
elif [ "$PLANKTON_ENV" != prod ]; then
  # A non-prod build lands in its OWN directory: it must never overwrite the
  # release artifact of another environment, and the log/verification must be
  # able to name which environment's build a directory holds.
  OUTPUT_DIR="release/$PLANKTON_ENV"
  REDIRECT_OUTPUT=1
fi
if [ "$REDIRECT_OUTPUT" = 1 ]; then
  echo "[plankton-pack] output redirected to: $OUTPUT_DIR"
fi
# --- artifact kind ------------------------------------------------------------
# Default is the unpacked .app (`--dir`), which is what a local install swaps in.
# `--dmg` builds the same unsigned bundling but emits the installer volume a
# colleague can drag from; it is the only form worth hand-off (an .app copied
# around loses its quarantine story and is not a single file).
TARGET="${1:-app}"
case "$TARGET" in
  app|--app|"") PACK_KIND=app ;;
  --dmg|dmg) PACK_KIND=dmg ;;
  *)
    echo "[plankton-pack] ERROR: unknown argument '$TARGET' (expected --dmg)." >&2
    exit 1
    ;;
esac
echo "[plankton-pack] kind=$PACK_KIND"

echo "[plankton-pack] start  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ "$PACK_KIND" = dmg ]; then
  npm run build
  if [ "$REDIRECT_OUTPUT" = 1 ]; then
    npm run builder -- --mac dmg --publish never -c.directories.output="$OUTPUT_DIR"
  else
    npm run builder -- --mac dmg --publish never
  fi
elif [ "$REDIRECT_OUTPUT" = 1 ]; then
  npm run build
  npm run builder -- --dir --publish never -c.directories.output="$OUTPUT_DIR"
else
  npm run pack
fi
echo "[plankton-pack] done   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Report the artifact that ACTUALLY landed (derived from the real output dir), so
# the log can never point at a path a redirected build did not produce.
APP_PATH="$(find "$OUTPUT_DIR" -maxdepth 2 -name '*.app' -type d 2>/dev/null | head -1)"
if [ -n "$APP_PATH" ]; then
  echo "[plankton-pack] artifact (env=$PLANKTON_ENV variant=$VARIANT): $(cd "$(dirname "$APP_PATH")" && pwd)/$(basename "$APP_PATH")"
else
  echo "[plankton-pack] artifact dir: $(pwd)/$OUTPUT_DIR (no .app found)"
fi
# NEWEST, not first: `find` order is unspecified and reported a previous
# version's dmg after a bump (it named 0.1.0 when 0.1.1 had just been built).
DMG_PATH="$(ls -t "$OUTPUT_DIR"/*.dmg 2>/dev/null | head -1)"
if [ -n "$DMG_PATH" ]; then
  echo "[plankton-pack] dmg: $(cd "$(dirname "$DMG_PATH")" && pwd)/$(basename "$DMG_PATH")"
fi
# The hand-off note that travels WITH the dmg (install steps, why an unsigned
# build says "已损坏", the fix, the log command). Generated — not hand-written —
# so the sha256/version/commit in it always describe THIS artifact.
if [ "$PACK_KIND" = dmg ] && [ -n "$DMG_PATH" ]; then
  if [ -n "$APP_PATH" ]; then
    node scripts/write-handoff-readme.mjs "$DMG_PATH" --app "$APP_PATH" \
      || echo "[plankton-pack] WARN: hand-off README not written (the dmg itself is fine)" >&2
  else
    node scripts/write-handoff-readme.mjs "$DMG_PATH" \
      || echo "[plankton-pack] WARN: hand-off README not written (the dmg itself is fine)" >&2
  fi
fi
