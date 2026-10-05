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

**Override preserved:** a *legitimate* explicit `HERMES_HOME` (one outside the
personal root) or `HERMES_DESKTOP_USER_DATA_DIR` always wins (multi-instance,
sandbox tests, fresh-install rehearsals). `resolveDesktopHermesHome`'s upstream
platform default (`~/.hermes`) is unchanged whenever `defaultHome` is absent, so
every upstream variant resolves bit-for-bit as before.

### The inherited-`HERMES_HOME` hole (fixed)

An `HERMES_HOME` in the environment beats the enterprise default in
`resolveDesktopHermesHome`'s first branch. Every process descended from a
Hermes CLI shell — and the Hermes desktop app itself, which exports
`HERMES_HOME=<personal root>` to its children — carries exactly
`HERMES_HOME=~/.hermes`. A double-clicked artifact launched from such a context
(`open`, a terminal, an installer that inherits the user's shell env) therefore
inherits it, and the app starts on the **personal** root with no variable the
user consciously passed.

`enterpriseHomeSelection()` (`electron/enterprise-paths.ts`, behavior-tested in
`enterprise-paths.test.ts`) closes it: for an enterprise build, a requested home
that **is** the personal root (`~/.hermes`, or `~/.hermes<suffix>` under a
`HERMES_DATA_DIR_SUFFIX` run) is discarded and the enterprise default is used,
and `main.ts` overwrites the inherited value in `process.env` so spawned
children cannot re-inherit it. A home *strictly inside* the personal root is a
deliberate override into personal state and is left alone for the check below.

### ⚠️ The isolation trap: `HERMES_HOME` must live OUTSIDE `~/.hermes`

**Rule: an enterprise `HERMES_HOME` that sits inside the personal Hermes root
does not isolate anything — it silently becomes the personal home.**

The engine resolves its real root through
`hermes_constants.get_default_hermes_root()` (`hermes_constants.py:216-233`).
That function does not use `HERMES_HOME` verbatim: if the value resolves to a
path **under the platform default** (`~/.hermes`, or `~/.hermes<suffix>` when
`HERMES_DATA_DIR_SUFFIX` is set), it is read as *a profile of the personal
home* and the function returns the **personal root** instead:

```python
env_path = _expand_hermes_home(env_home) if env_home else None
result = native_home                       # ~/.hermes
if env_path is not None:
    try:
        env_path.resolve().relative_to(native_home.resolve())   # under ~/.hermes
    except ValueError:
        result = env_path.parent.parent if env_path.parent.name == "profiles" else env_path
return result                              # ← still ~/.hermes for the "under" case
```

Consequences of getting this wrong — all silent, none of them an error:

- `~/.hermes/enterprise` (or `~/.hermes/profiles/enterprise`, or `~/.hermes`
  itself) makes the "isolated" engine open the **personal** `state.db`, read the
  personal `config.yaml` / sessions / skills, and write back to them.
- The app looks configured and boots normally; nothing in the UI says the home
  was swapped. A rehearsal that "worked" against a copy under `~/.hermes` was
  actually driving the real personal state.
- This bit us once in this branch's own verification runs. Treat any copy of
  personal state made for a test — and every override passed to `npm run dev` /
  a packaging rehearsal — as a **possible contamination** until its path is
  confirmed to be outside `~/.hermes`.

Safe shapes (all outside the personal root):

| Shape | Example |
|-------|---------|
| Product root (the default) | `~/.plankton/engine/home` |
| Scratch rehearsal dir | `~/plankton-verify/home` |
| Sibling dot-dir | `~/.hermes-enterprise` (note: *not* a child of `~/.hermes`) |

Unsafe (silently falls back to personal state): `~/.hermes`,
`~/.hermes/anything`, `~/.hermes/profiles/<name>`, and the same under a
`HERMES_DATA_DIR_SUFFIX` root such as `~/.hermes-canary/...`.

**Startup self-check (implemented, fail-closed).** Home isolation is verified at
launch, not left to discipline: `enterpriseHomeIsolationIssue()`
(`electron/enterprise-paths.ts`, behavior-tested in
`enterprise-paths.test.ts`) compares the *effective* home against the
personal root and, on an enterprise build, main.ts logs a loud
`ENTERPRISE HOME ISOLATION FAILURE` and — for a packaged artifact — shows a
blocking `dialog.showErrorBox`.

**Decision: the app then REFUSES TO START.** On a hit, main.ts calls
`app.exit(1)` (plus a hard `throw` as belt-and-braces) *before* the model seed,
the desktop log, the SSH control dir and the backend spawn — so a
misconfigured launch reads and writes **no** home at all. Booting anyway would
mean running against personal `state.db`/`config.yaml`/sessions, which is the
one thing this fork exists to prevent; a path preference never outranks that
red line. The error box is the operator's only signal, which is why it is shown
before the exit.

The fail-closed path is reachable only by an home **strictly inside** the
personal root: a home that *is* the personal root is the ambient
CLI/desktop value and is discarded up front (see above), so the ordinary
double-click from a Hermes-configured shell boots on
`~/.plankton/engine/home` instead of exiting.

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

## 4. Payload size — the `HERMES_PAYLOAD_UV_CACHE` build switch

The staged payload ships a lock-scoped copy of uv's package cache under
`agent-payload/uv-cache/` (~1.9 GB: `archive-v0` ≈ 951 MB extracted wheels +
`wheels-v6` ≈ 952 MB wheel ZIPs). It exists for exactly one reason: on the
first `uv_cache_dir()` call on a sealed install it is copied out to
`<HERMES_HOME>/cache/uv` (`pm/packages.py`), so a **per-install venv rebuild** —
enabling a plugin extra, changing features — runs `uv sync --offline` with zero
network. First launch never needs it: the payload already ships a ready venv,
and there is no engine bootstrap to feed.

There is **no upstream opt-out**. `website/docs/developer-guide/shared-bundle-builds.md`
("Native staging retains `uv-cache/` for offline mutable-environment rebuilds")
and `scripts/build/README.md` document retaining it as deliberate, and
`pm/uv_cache_prune.py` only prunes *to lock* — it never drops the cache. So this
fork adds one switch, read by `scripts/bundles/native.py:stage_uv_cache()`:

| `HERMES_PAYLOAD_UV_CACHE` | Effect at **payload staging** (step 1 — not the pack step) |
|---------------------------|------------------------------------------------------------|
| unset / `1` | ship `uv-cache/` — upstream behaviour, the **default** |
| `0` / `false` / `no` / `off` | omit `uv-cache/` entirely; payload is ~1.9 GB smaller |

`stage_uv_cache` returns whether it staged anything; the caller skips the
now-pointless lock prune when the switch is off. This is a **build** switch, not
a runtime one: the pack step never restages the cache, so it must be set on the
payload-staging command (step 1 below).

**Cost of `=0`, stated plainly:** a per-install venv rebuild (new plugin extras /
feature changes) can no longer resolve offline — it needs network to fetch the
wheels. Nothing else changes: first launch, sessions, skills, the engine and the
already-installed feature set are unaffected, because they run from the venv the
payload already ships. Rollback is just unsetting the variable (or `=1`) and
re-staging — the default path is untouched and no repo file is deleted in place.

Measured on this host (Plankton `--dir`, unsigned; both artifacts verified to
boot and list the same existing sessions on the UI):

| Build | `agent-payload` | `Plankton.app` |
|-------|-----------------|----------------|
| `uv-cache/` shipped (default) | 4.3 GB | 4.9 GB |
| `HERMES_PAYLOAD_UV_CACHE=0` | 2.5 GB | 3.0 GB |

The switch only removes the cache directory: the payload is otherwise
byte-for-identical (`bin`, `enabled-features.json`, `hermes-agent`, `manifest.json`,
`pm-runtime`, `tools`, `venv`), so the app boots with no external Python exactly
as before.

## 5. Shared metrics — local-only, and the send-to-Nous offer is never shown

Upstream's first run asks *"Help improve Hermes?"* with three equal answers —
**Send to Nous** / **Local only** / **No thanks** — and `AGENTS.md` requires outbound
telemetry to stay behind a user-facing opt-in. The enterprise edition inverts the
default: **collection stays local, transmission is off, and the "send to Nous" choice
is never presented.**

This reuses upstream's own mechanism and keys. There is **no second consent system**:

- The two config keys are the same ones the offer and `hermes setup telemetry` write:
  `telemetry.shared_metrics.enabled` (collect locally) and `.send` (upload daily).
- A profile counts as *decided* once either key is written, and **only a decided answer
  suppresses the offer** — on every surface (the desktop composer strip, the CLI offer,
  the dashboard banner). So the enterprise build settles those keys to **`enabled: true`,
  `send: false`** before the UI can ask; the strip/dialog never render and no transmission
  is possible (`resolve_send_config` resolves `send=False`).

Where it lives (variant-driven — the other four variants are bit-for-bit unchanged):

| Piece | File | Role |
|-------|------|------|
| Identity stamp into the backend env | `electron/guest-onboarding.ts` → `desktopBackendSpawnEnv(base, guestOnboarding, enterprise)` | writes `HERMES_ENTERPRISE=1` for `plankton`, `=0` for every other variant (stamped for both states so an inherited value cannot leak) |
| Passing the identity | `electron/main.ts` (both `hermes serve` spawn sites) | passes `PRODUCT_IDENTITY.enterprise` as the third argument |
| Materializing the default | `hermes_cli/observability/shared_metrics_consent.py` → `apply_enterprise_consent_default()` | enterprise-only; no-op on any upstream build. If the profile already carries an explicit answer it is **respected verbatim** (even `send: true`) and logged; otherwise writes `enabled: true`, `send: false` through the existing `save_consent()` writer |
| Calling it at startup | `hermes_cli/web_server.py` (`_lifespan`) | runs once on backend start, before the UI's first `shared_metrics.status` read; best-effort (a failure is logged, never fatal) |

`HERMES_ENTERPRISE` is an **identity marker set by the launcher** (the same family as
`HERMES_DESKTOP`, `HERMES_MANAGED`), not user-facing behavioural config — the behavioural
setting stays in `config.yaml`, exactly as `AGENTS.md` requires. The engine has no build
selector of its own (the variant is baked into the Electron main), so this is the one
signal it can trust.

Return values of `apply_enterprise_consent_default()`: `not-enterprise` (upstream — nothing
read or written), `decided` (explicit existing answer kept), `seeded` (local-only default
written). Behaviour tests: `tests/hermes_cli/test_shared_metrics_consent_enterprise.py`;
the identity stamp is covered by `electron/backend-spawn-env.test.ts`.

## 6. License and third-party notice in the artifact

A modified distribution must carry the upstream license and a notice of what was
changed. Both are emitted **by the build**, not copied into a `.app` by hand:

- `electron-builder.config.cjs` (`extraResources`) adds, for the `plankton` variant only:
  - `../../LICENSE` (the repo-root, unmodified upstream MIT license) → `Contents/Resources/LICENSE`
  - `THIRD-PARTY-NOTICES.md` (this directory) → `Contents/Resources/THIRD-PARTY-NOTICES.md`
- Gated on `HERMES_DESKTOP_VARIANT === 'plankton'`, so the other four variants' Resources
  stay bit-for-bit unchanged.
- `THIRD-PARTY-NOTICES.md` states the upstream project (hermes-agent, MIT,
  Copyright (c) 2025 Nous Research), points at the bundled verbatim `LICENSE`, and lists the
  material changes in this distribution (variant identity, enterprise data roots + isolation,
  embedded engine, packaging slimming, sidebar fix, telemetry localization).

To change what ships, edit the two extraResources entries or the notice file — no manual
copy step exists, and every `npm run pack` reproduces them.

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

#    Smaller installer? Drop the offline venv-rebuild cache at staging with
#    HERMES_PAYLOAD_UV_CACHE=0 (~1.9 GB off, at the cost of offline venv
#    rebuilds — see §4). The pack step below is unaffected either way:
HERMES_PAYLOAD_UV_CACHE=0 HERMES_PYTHON=<prepared-python> \
  node ../../scripts/build/python.mjs \
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
(offline venv-rebuild wheels, ~1.9 GB) is the largest chunk the staging step can
omit — via the `HERMES_PAYLOAD_UV_CACHE` build switch (§4).

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
