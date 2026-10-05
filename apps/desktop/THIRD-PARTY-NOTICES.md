# Third-party notices

Plankton is a modified distribution of the open-source **hermes-agent** project.

## Upstream project

- **hermes-agent** — <https://github.com/NousResearch/hermes-agent>
- License: **MIT**
- Copyright (c) 2025 Nous Research

The complete, unmodified upstream MIT license text ships alongside this file as
`LICENSE` (same directory). It is reproduced there verbatim; this notice does not
replace or alter it.

## What this distribution changes

This build ("Plankton", the enterprise edition of the Hermes desktop app) is derived
from hermes-agent under the terms of the MIT license. The material modifications are:

1. **Variant identity.** A fifth product variant, `plankton`, is added alongside the
   upstream `light` / `bundled` / `store` variants. It carries its own display name,
   application id (`com.shaoke.plankton`) and icon, and reuses upstream's in-artifact
   (`bundled`) runtime shape rather than introducing a new artifact kind. The other
   four variants are unchanged.
2. **Enterprise data roots and isolation.** On first launch the engine home defaults to
   `~/.plankton/engine/home` (POSIX) / `%LOCALAPPDATA%\plankton\engine\home` (Windows)
   instead of the personal `~/.hermes`, and a fail-closed startup self-check refuses to
   start if the resolved home would fall back onto personal state.
3. **Embedded engine.** The desktop app ships the runtime (interpreter, dependency tree
   and launchers) inside the artifact, so a first launch needs no external Python and no
   engine bootstrap.
4. **Packaging slimming.** A build switch (`HERMES_PAYLOAD_UV_CACHE=0`) lets packaging
   omit the offline venv-rebuild wheel cache (~1.9 GB) when it is not needed.
5. **Sidebar defect fix.** A sidebar rendering/behaviour defect in the desktop client is
   repaired.
6. **Telemetry localization.** Upstream's first-run "help improve Hermes / send to Nous"
   question is not offered on this build: shared-metrics collection is local-only and
   transmission to upstream is off by default. If a profile already carries an explicit
   answer it is respected; none is written or changed.

No upstream copyright notices have been removed.

## Bundled third-party components

The artifact also embeds third-party runtime components (including the CPython
interpreter, `uv`, Node.js and their dependency trees) under their own licenses,
staged under `Contents/Resources/agent-payload/`. Their license texts are provided
with those components in the same payload tree and are not restated here.
