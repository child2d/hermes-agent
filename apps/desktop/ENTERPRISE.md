# Enterprise fork (Plankton) — identity + embedded engine

This branch (`shaoke/enterprise`) is the enterprise edition of the Hermes
desktop app, shipped as **Plankton**. It reuses upstream's in-artifact runtime
mechanism instead of inventing a second packer, and keeps upstream business
logic and the other four variants untouched.

Everything is driven by **one build selector**: `HERMES_DESKTOP_VARIANT=plankton`.

| Item | Value |
|------|-------|
| Variant key | `plankton` |
| Display name | `Plankton` (product name is **not** localized) |
| kebab / pascal | `plankton` / `Plankton` |
| appId | `com.shaoke.plankton` |
| Icon base | `assets/plankton/icon` (`.icns` / `.ico` / `.png`) |
| Deep-link scheme | `hermes` (unchanged — see below) |
| Artifact shape | **branded bundled carrier** — the `bundled` in-artifact runtime, under Plankton's own identity |
| Engine home (default) | `~/.plankton/engine/home` |
| Desktop userData | `~/Library/Application Support/Plankton` (macOS) |

## 1. Artifact shape — a branded `bundled` carrier

Upstream already has a "runtime ships inside the artifact" shape: the `bundled`
variant. `store` is a *layer on top of it* (same payload, different MSIX
identity). Plankton is the same idea with different branding: it carries the
**same** in-artifact runtime as `bundled` but its own name, app id, icon and
first-launch data roots.

Concretely, Plankton introduces **no new artifact kind**. Its install stamp
still says **`payload: "bundled"`** — the single value every runtime gate keys
on (`installShape()`, `payload-backend.bundledPayload()`,
`hermes_cli/steward.is_bundled_payload`). So the whole bundled lifecycle —
payload relocation in `after-pack`, embedded-runtime selection, "no venv
machinery / no bootstrap" — applies unchanged.

Because the payload kind is `bundled`, the payload→identity mapping in
`bundle-electron-main.mjs` would otherwise bake the *upstream* `bundled`
identity. Plankton therefore records its own branding variant in the stamp as
**`identityVariant: "plankton"`** (written by `scripts/write-build-stamp.mjs`),
and `bundle-electron-main.mjs` bakes that identity. The stamp stays the single
source of an artifact's identity — no build-env leak, no new payload enum.

Two switches live in `apps/desktop/product-identity.cjs`:
`enterprise: true` (data roots + model seed) and `bundledCarrier: true`
(artifact shape). The payload itself is staged by the upstream builder
(`scripts/bundles/stage.py` → PM), never by a fork-specific packer.

### Update owner

Like `bundled`, a Plankton artifact's native update owner is `electron-updater`
(macOS) / `app-installer` (Windows). To point it at the enterprise feed instead
of upstream, set `CLOUDFLARE_R2_PUBLIC_URL` (the existing feed override) at
build time; with no override it falls back to the GitHub provider exactly as
upstream `bundled` does.

## 2. Data roots (never touch personal `~/.hermes`)

| Root | Default | Why |
|------|---------|-----|
| Desktop userData | `~/Library/Application Support/Plankton` (macOS) | Electron derives it from the baked `appNamePascal`; `applyDesktopIdentity` pins it for enterprise builds |
| Engine home (`HERMES_HOME`) | `~/.plankton/engine/home` (POSIX), `%LOCALAPPDATA%\plankton\engine\home` (Windows) | the engine's whole world (config, sessions, skills, logs, tool store) lives here, isolated from a personal `~/.hermes`. `~/.plankton` is the existing Plankton product root; `engine/home` is where its engine home already lives, so an existing install keeps its sessions |

Implementation: `electron/enterprise-paths.ts` computes the default;
`electron/main.ts` passes it to `resolveDesktopHermesHome({ defaultHome })`
and, when no ambient `HERMES_HOME` exists, exports it to `process.env` so the
spawned backend and the pure PATH helpers agree. `electron/entry.ts` does the
same for the Linux pre-launch config read.

**Override preserved:** an explicit `HERMES_HOME` or
`HERMES_DESKTOP_USER_DATA_DIR` always wins (multi-instance, sandbox tests,
fresh-install rehearsals). `resolveDesktopHermesHome`'s upstream platform
default (`~/.hermes`) is unchanged whenever `defaultHome` is absent, so every
upstream variant resolves bit-for-bit as before.

### Two ambient personal-path leaks, closed

1. **User-bin launcher discovery** (`resolveHermesBackend`, rung 5). The
   ambient `~/.local/bin/hermes` on a machine with a personal CLI install
   points into `~/.hermes/hermes-agent`, so the enterprise app would boot the
   *personal* checkout. Enterprise builds pass `scopeHome = HERMES_HOME` to
   `userLauncherInstallRoot`, which searches only `<HERMES_HOME>/bin` and
   rejects any root outside it. Upstream variants pass no scope.
2. **SSH control socket.** `defaultControlDir()` defaulted to
   `~/.hermes/desktop-ssh`. Enterprise builds pin
   `HERMES_DESKTOP_SSH_CONTROL_DIR=<HERMES_HOME>/desktop-ssh`, which
   `defaultControlDir()` now honours as an explicit override; unset, the
   historical default (suffix handling included) is unchanged.

Covered by `electron/user-launcher-install.test.ts`,
`electron/ssh-connection.test.ts`, `electron/data-paths.test.ts`,
`electron/enterprise-paths.test.ts`.

## 3. First-launch model seed — values pending

On first enterprise launch, if `<HERMES_HOME>/config.yaml` does **not** exist,
the app writes a minimal model config. It is a **framework**: no provider
value, no base URL, and above all no API key is committed to the repo or baked
into the installer.

- Code: `electron/enterprise-model-seed.ts` (behavior tests in
  `enterprise-model-seed.test.ts`).
- Guarantees: enterprise-only; never overwrites an existing `config.yaml`;
  writes `config.yaml` mode **0600**; writes no secret field.
- Value sources, in precedence order:
  1. `$HERMES_ENTERPRISE_MODEL_SEED` → absolute path to a JSON file, or
  2. `<HERMES_HOME>/enterprise/model-seed.json`.
  If neither exists the seed is a logged no-op (`no-source`) — the app still
  boots and the operator can drop the file and relaunch.

Seed JSON shape (the file the operator/installer supplies — **not** in git):

```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "base_url": "https://api.deepseek.example/v1",
  "api_key_env": "DEEPSEEK_API_KEY"
}
```

`provider` and `model` are required; `base_url`/`api_key_env` optional.
`api_key_env` is documentation only — the **name** of the env var, never a
value, and it is never written into `config.yaml`.

### ⚠️ 待接值 (values still to be wired)

1. **Who provides the seed file?** No production seed file exists yet. The
   installer (or an IT drop to `<HERMES_HOME>/enterprise/model-seed.json`) must
   ship one. This batch only proves the mechanism.
2. **API key delivery.** The key is intentionally absent. It must arrive at
   install time as `~/.plankton/engine/home/.env` (`DEEPSEEK_API_KEY=…`, 0600)
   or via `hermes auth`/`hermes model`. If the backend instead mints a token
   via an enterprise auth endpoint, that endpoint + token exchange is a
   follow-up.
3. **Exact provider/model.** Replace the example values with the real
   enterprise endpoint once known.

## Build / pack / rollback

Two steps, mirroring upstream `dist:bundled`. Step 1 stages the in-artifact
runtime with the upstream PM builder; step 2 packages the branded bundled app.

```bash
# install once (root workspace; the default registry here is a private mirror)
npm ci --registry https://registry.npmjs.org/

cd apps/desktop

# 1) stage the in-artifact runtime (needs a prepared Python 3.11+ interpreter)
HERMES_PYTHON=<prepared-python> node ../../scripts/build/python.mjs \
  ../../scripts/bundles/stage.py --out build/agent-payload

# 2) package the branded bundled app (unsigned).
#    Pack-time note: for a bundled artifact, after-pack runs
#    scripts/bundles/payload.py relocate (stdlib-only), which executes through
#    scripts/build/python.mjs and therefore ALSO needs HERMES_PYTHON — the
#    pack step must pass it explicitly. On this host /opt/homebrew/bin/python3
#    (Homebrew Python 3.14.3) works; the staged payload's own
#    <payload>/venv/bin/python also works.
CSC_IDENTITY_AUTO_DISCOVERY=false HERMES_DESKTOP_VARIANT=plankton \
  HERMES_PYTHON=/opt/homebrew/bin/python3 npm run pack
# artifact: apps/desktop/release/mac-arm64/Plankton.app

# On a network where github.com is blocked/slow, electron-builder cannot fetch
# its Electron dist. Point it at a reachable mirror (npmmirror verified):
ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/" \
  CSC_IDENTITY_AUTO_DISCOVERY=false HERMES_DESKTOP_VARIANT=plankton \
  HERMES_PYTHON=/opt/homebrew/bin/python3 npm run pack
```

`build/agent-payload` is populated by `stage.py` (PM); electron-builder copies
it to `<Plankton.app>/Contents/Resources/agent-payload` and the stamp is baked
with `payload: "bundled"` + `identityVariant: "plankton"`. The staged payload
ships its own CPython + uv + Node + the ready dependency tree, so a first
launch needs **no** external Python and **no** engine bootstrap. `uv-cache/`
(offline venv-rebuild wheels) is the largest prunable chunk if a smaller
installer is needed.

### Rollback

```bash
# revert this batch's tracked edits
git checkout -- .

# drop the new (untracked) files
git clean -fd apps/desktop/assets/plankton apps/desktop/electron/enterprise-*.ts \
  apps/desktop/ENTERPRISE.md apps/desktop/build/agent-payload

# if a local build tag was created for the release chain, delete it (never pushed)
git tag -d v0.0.0-plankton.1
```

Enterprise behavior tests:

```bash
cd apps/desktop
npx vitest run --project electron \
  electron/enterprise-paths.test.ts \
  electron/enterprise-model-seed.test.ts \
  electron/data-paths.test.ts \
  electron/product-identity.test.ts \
  electron/user-launcher-install.test.ts \
  electron/ssh-connection.test.ts
```
