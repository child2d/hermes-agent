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

## 3. First-launch model seed — provider config and key

On first enterprise launch, if `<HERMES_HOME>/config.yaml` does **not** exist,
the app writes a minimal model config. When the seed also carries an
`api_key`, the key is written to `<HERMES_HOME>/.env` (0600) — the provider's
env var, which is where a built-in provider resolves its key from. It is
**never** written into `config.yaml`.

- Code: `electron/enterprise-model-seed.ts` (behavior tests in
  `enterprise-model-seed.test.ts`).
- Guarantees: enterprise-only; never overwrites an existing `config.yaml` or
  `.env`; writes both at mode **0600**; `config.yaml` never carries a secret.
- Value sources, in precedence order:
  1. `$HERMES_ENTERPRISE_MODEL_SEED` → absolute path to a JSON file, or
  2. `<HERMES_HOME>/enterprise/model-seed.json`, or
  3. `<Resources>/enterprise/model-seed.json` — **baked at pack time** by
     `scripts/plankton-pack.sh` (plankton only; see below).
  If none exists the seed is a logged no-op (`no-source`) — the app still
  boots and the operator can drop the file and relaunch.

Seed JSON shape (the file the operator/installer supplies):

```json
{
  "provider": "deepseek",
  "model": "deepseek-v4-flash",
  "base_url": "https://api.deepseek.com",
  "api_key_env": "DEEPSEEK_API_KEY",
  "api_key": "…"
}
```

`provider` and `model` are required; `base_url`, `api_key_env` and `api_key`
are optional. `api_key_env` names the env var the key is written under
(default `DEEPSEEK_API_KEY`).

### Where the seed file lives (it can carry a secret)

The build-machine seed file is `apps/desktop/build/enterprise/model-seed.json`.
`build/` is **gitignored**, so a key-bearing seed never enters git; at pack time
`scripts/plankton-pack.sh` copies it into the app as
`Contents/Resources/enterprise/model-seed.json`. When the file is absent the
script writes a **keyless** placeholder (`provider`/`model`/`base_url` only), so
the pack-time Resources copy never dangles.

**Key provenance (why the placeholder may carry a real key).** To prove the
end-to-end path before an enterprise key endpoint exists, the seed shipped in
this build was generated on the build machine from the operator's own provider
key. The rule that follows from that:

- **The key value exists only in the build-machine seed file above — never in
  the repo, a report, a commit message, the shell environment, or `config.yaml`.**
- Swapping it for a company-issued key means replacing that one file and
  re-packing; no code change.

### ⚠️ 待接值 (values still to be wired)

1. **Who provides the production seed file?** Today the pack script bakes
   `build/enterprise/model-seed.json` (a personal key). The production shape is
   an IT drop or an installer that writes the seed with a company-issued key.
2. **API key delivery.** The key is written to
   `<HERMES_HOME>/.env` (`DEEPSEEK_API_KEY=…`, 0600) on first launch, from the
   seed. If the backend instead mints a token via an enterprise auth endpoint,
   that endpoint + token exchange is a follow-up.
3. **Key rotation / revocation.** The baked key cannot be revoked per person and
   its usage is billed to the original account; rotate to a dedicated key (or an
   enterprise issuance endpoint) before broadening distribution (see
   `spec-library` KI-PLANKTON-0069).

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

## 5. Shared metrics — local-only, transmission sealed, the send switch not shown

Upstream's first run asks *"Help improve Hermes?"* with three equal answers —
**Send to Nous** / **Local only** / **No thanks** — and `AGENTS.md` requires outbound
telemetry to stay behind a user-facing opt-in. The enterprise edition inverts the
default: **collection stays local, transmission is sealed at the build, the "send to
Nous" choice is never presented, and the "Send" row is not rendered at all.**

This reuses upstream's own mechanism and keys. There is **no second consent system**:

- The two config keys are the same ones the offer and `hermes setup telemetry` write:
  `telemetry.shared_metrics.enabled` (collect locally) and `.send` (upload daily).
- A profile counts as *decided* once either key is written, and **only a decided answer
  suppresses the offer** — on every surface (the desktop composer strip, the CLI offer,
  the dashboard banner). So the enterprise build settles those keys to **`enabled: true`,
  `send: false`** before the UI can ask; the strip/dialog never render.

**The transmission port is sealed regardless of config.** Every send path resolves
through `resolve_send_config()`; on an enterprise build that resolver returns
`send=False` for *any* config — a hand-edited `send: true`, a migrated profile, a synced
one — and logs the override once. So the two guarantees are independent: the seeded
answer keeps the question from being asked, and the resolver keeps the wire dark even if
the answer is later changed.

Where it lives (variant-driven — the other four variants are bit-for-bit unchanged):

| Piece | File | Role |
|-------|------|------|
| Identity stamp into the backend env | `electron/guest-onboarding.ts` → `desktopBackendSpawnEnv(base, guestOnboarding, enterprise)` | writes `HERMES_ENTERPRISE=1` for `plankton`, `=0` for every other variant (stamped for both states so an inherited value cannot leak) |
| Passing the identity | `electron/main.ts` (both `hermes serve` spawn sites) | passes `PRODUCT_IDENTITY.enterprise` as the third argument |
| Materializing the default | `hermes_cli/observability/shared_metrics_consent.py` → `apply_enterprise_consent_default()` | enterprise-only; no-op on any upstream build. If the profile already carries an explicit answer it is **respected verbatim** (even `send: true`) and logged — the resolver below still refuses to send; otherwise writes `enabled: true`, `send: false` through the existing `save_consent()` writer |
| **Sealing the send port** | `hermes_cli/observability/shared_metrics_send_config.py` → `resolve_send_config()` | enterprise-only: returns `send=False` for every config, logs the override once. Upstream (marker absent) is untouched |
| Calling it at startup | `hermes_cli/web_server.py` (`_lifespan`) | runs once on backend start, before the UI's first `shared_metrics.status` read; best-effort (a failure is logged, never fatal) |
| Renderer identity signal | `electron/main.ts` (`hermes:feature-flags`) → `electron/preload.ts` (`enterpriseEnabled`) | an additive boolean, `false` on every upstream variant |
| **Hiding the "Send" row** | `src/app/settings/shared-metrics-settings.tsx` (via `src/store/enterprise-flag.ts`) | enterprise drops the send `ToggleRow`; upstream renders it unchanged |

`HERMES_ENTERPRISE` is an **identity marker set by the launcher** (the same family as
`HERMES_DESKTOP`, `HERMES_MANAGED`), not user-facing behavioural config — the behavioural
setting stays in `config.yaml`, exactly as `AGENTS.md` requires. The engine has no build
selector of its own (the variant is baked into the Electron main), so this is the one
signal it can trust.

Return values of `apply_enterprise_consent_default()`: `not-enterprise` (upstream — nothing
read or written), `decided` (explicit existing answer kept), `seeded` (local-only default
written). Behaviour tests: `tests/hermes_cli/test_shared_metrics_consent_enterprise.py`
(includes the "config says `send: true`, the resolver still refuses" case);
`tests/hermes_cli/test_shared_metrics_send_config.py`; the identity stamp is covered by
`electron/backend-spawn-env.test.ts`.

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

To change what ships, edit the extraResources entries or the notice file — no manual
copy step exists, and every `npm run pack` reproduces them.

## Build / pack / rollback

### One command (the supported entry point)

```bash
cd apps/desktop
npm run pack:plankton
# artifact: apps/desktop/release/mac-arm64/Plankton.app
```

`scripts/plankton-pack.sh` pins every build-time variable the enterprise pack
needs — `HERMES_PYTHON=/opt/homebrew/bin/python3`,
`ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/`,
`HERMES_DESKTOP_VARIANT=plankton`, `CSC_IDENTITY_AUTO_DISCOVERY=false` — makes
sure `build/enterprise/model-seed.json` exists (keyless placeholder when no
secret seed is present), then runs `npm run pack`. It assumes
`build/agent-payload` is already staged (step 1 below); re-staging is only
needed when the runtime payload itself changes.

### The two underlying steps

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

## Distribution (分发说明)

**产物在哪**：`apps/desktop/release/mac-arm64/Plankton.app`（未签名、未公证；~2.8G，内置引擎）。

**怎么给别人**：整包拷贝 `Plankton.app` 即可（它自带运行时，不需要对方另装引擎或 Python）。

- **⚠️ 同一台机器不要同时打开两个 Plankton**：两个实例共用同一个企业数据目录（桌面 `~/Library/Application Support/Plankton`，引擎 `~/.plankton/engine/home`），同时打开会争用同一份 `state.db` 与会话。用完一个再开另一个。
- **未签名会遇到的拦阻**：macOS Gatekeeper 会提示「无法验证开发者 / 已损坏，无法打开」。
  - 临时处置一：右键（或 Control-点击）应用 → 打开 → 在弹窗里再点「打开」。
  - 临时处置二：`xattr -dr com.apple.quarantine /path/to/Plankton.app` 去掉隔离属性后再打开。
  - 这两招只适合**本人机器**排障。发给同事前必须先做 Developer ID 签名 + 公证（需 Apple 开发者账号）——见 `spec-library` KI-PLANKTON-0068。
- **许可与第三方声明在包内哪里**：`Plankton.app/Contents/Resources/LICENSE`（上游 MIT 原文）与 `Contents/Resources/THIRD-PARTY-NOTICES.md`（本分发改了什么的声明）。两者都由构建自动写入，无需手工拷贝。

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


---

## Status in Simplified Technical English (ASD-STE100)

Use this section for handover and for reviews. Write new status text in the same style.

### What works now

1. The app is Plankton. Plankton is a modified copy of the open-source Hermes desktop.
2. The license is MIT. The app contains the license text and a third-party notice.
3. The app contains its own engine. You do not install the engine on the computer.
4. The app keeps its data in the enterprise folder. The app does not touch the personal folder.
5. The app shows the 8 sessions that are already in the enterprise folder.
6. The app does not send usage data to Nous. All network connections stay on the local computer.
7. The size of the app is 3.0 GB. Before, the size was 4.9 GB.
8. The app does not show the "Send" switch. The engine blocks all transmission.
9. The app does not look for updates. The team sends each new version by hand.
10. The build is one command. A person runs `npm run pack:plankton`.
11. The app writes the model key at the first start. The key comes from the seed file.

### What does not work now

12. **Signature.** The app has no code signature. The app has no notarization. macOS stops the app on a colleague's computer. Sign and notarize the app before you give it to a colleague. You must have an Apple Developer account for this step.
13. **Model key is one person's key.** The seed carries one person's key. The usage is charged to that person. You cannot cancel the key for one user. Replace the key before you give the app to many people.
14. **Network for plugins.** The app does not contain the uv cache. The cache had a size of 1.9 GB. Without the cache, the app needs the network to add a plugin.
15. **Two apps.** The /Applications folder contains the old Plankton build. The new build stays in the build folder. Do not mix the two apps.
16. **Chat area.** The chat area shows "Waking up". The session list is complete. The message is a readiness note for the model.

### Rules for this section

- Put one topic in one sentence. Use a maximum of 20 words in a sentence.
- Use the active voice. Use the simple present tense.
- Use one word for one meaning. Use these words: app, folder, switch, key.
- Use "must" for a requirement. Use "can" for a capability.
- Do not write "and/or". Give one action.
- Keep technical names as they are: Plankton, Hermes, MIT, macOS, HERMES_PYTHON, uv cache.
- Add each new technical name to the project glossary.

### 中文对照

**现在能做到的**：它就是我们自己改的 Plankton（基于 MIT 许可的开源 Hermes 桌面端，包内附许可原文与第三方声明）；引擎内置于包内，不需要额外安装；数据只落在企业目录、不碰个人目录；界面上能看到已有的 8 条会话；不向 Nous 发送使用数据、网络只在本机内；包体积 3.0G（原 4.9G）。

本轮新做好的四项：⑧ 设置里不再显示「发送」开关，而且引擎把发送口彻底封死（配置里就算手改成 `send: true` 也不发）；⑨ 不再检查自动更新（内部分发靠人工推新版本）；⑩ 构建已固化成一条命令 `npm run pack:plankton`；⑪ 首启会把模型密钥写进企业目录的 `.env`（0600），界面与流程可端到端对话。

**还没做到的（五项）**：① 没有代码签名与公证，发给同事会被 macOS 拦下，需要 Apple 开发者账号（签名/公证本轮**挂起**，见 KI-PLANKTON-0068）；② 当前密钥是**个人 key 临时内置**，用度记在该个人账号、无法按人吊销，扩大分发前必须换成专供密钥（见 KI-PLANKTON-0069）；③ 为了瘦身删掉了 1.9G 缓存，代价是加装插件要联网；④ `/Applications` 里还是旧版本，新版在构建目录，别混用；⑤ 聊天区显示的「Waking up」是模型就绪提示（不影响会话列表）。

**本节写法规则**：一句一个主题、不超过 20 词；主动语态、一般现在时；一个词一个意思（app/folder/switch/key）；要求用 must、能力用 can；不写「和/或」，只给一个动作；产品名与技术名保持原样，并登记进术语表。
