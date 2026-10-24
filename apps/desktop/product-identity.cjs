// The desktop product identity — THE single source for every name-shaped
// value a variant owns. HERMES_DESKTOP_VARIANT=light builds "Hermes
// Light", the remote-only client; everything else is full "Hermes".
//
// 'plankton', 'plankton-test' and 'plankton-dev' are the enterprise fork's
// family: a *branded bundled carrier*, one INDEPENDENT app per environment.
// Each ships the same in-artifact runtime as `bundled` (the install stamp still
// reads `payload: bundled`; see scripts/write-build-stamp.mjs), under its own
// name, app id, icon, desktop userData dir and first-launch engine home — so
// the three installs coexist on one machine without sharing state. The
// environment is a build-time axis only; see plankton-envs.cjs. ENTERPRISE.md.
//
// Consumed at build time by electron-builder.config.cjs (packaging
// identity). electron/product-identity.ts is the typed runtime accessor.
// @ts-check
/// <reference types="node" />
'use strict'

const { PLANKTON_ENVS } = require('./plankton-envs.cjs')

/** @typedef {{ display: string, kebab: string, pascal: string, appIdBase?: string, iconBase?: string, enterprise?: boolean, bundledCarrier?: boolean, env?: string, homeDir?: string|null }} Variant */

/** The Plankton environment variants, built from the one environment table
 *  (plankton-envs.cjs) so a new environment can never drift between the
 *  identity and the packaging scripts. `env`/`homeDir` carry the environment
 *  INTO the identity, which is what makes the data roots a property of the
 *  artifact rather than of the shell it was launched from. */
const planktonVariantEntries = Object.fromEntries(
  Object.values(PLANKTON_ENVS).map(spec => [
    spec.variant,
    {
      display: spec.display,
      kebab: spec.kebab,
      pascal: spec.pascal,
      appIdBase: spec.appIdBase,
      iconBase: spec.iconBase,
      enterprise: true,
      bundledCarrier: true,
      env: spec.env,
      homeDir: spec.homeDir
    }
  ])
)

/** @type {Record<string, Variant>} */
const variants = {
  '': { display: 'Hermes', kebab: 'hermes', pascal: 'Hermes' },
  light: {
    display: 'Hermes Light',
    kebab: 'hermes-light',
    pascal: 'HermesLight'
  },
  bundled: {
    display: 'Hermes Agent',
    kebab: 'hermes-bundled',
    pascal: 'HermesBundled'
  },
  // Plankton — the enterprise family. `enterprise: true` is the one switch the
  // desktop runtime reads to pick enterprise data roots (see
  // electron/enterprise-paths.ts) and the first-launch model seed
  // (electron/enterprise-model-seed.ts). `bundledCarrier: true` says its
  // artifact reuses the `bundled` in-artifact runtime shape; electron-builder
  // and the install stamp key on it (see electron-builder.config.cjs,
  // scripts/write-build-stamp.mjs). `appIdBase` and `iconBase` keep every
  // upstream variant on today's values.
  ...planktonVariantEntries
}

const variant = process.env.HERMES_DESKTOP_VARIANT || ''
// 'store' is a packaging identity layered on `bundled` rather than a table
// entry, so it is listed here beside the real variant keys.
const knownVariants = ['', 'light', 'bundled', 'store', ...Object.keys(planktonVariantEntries)]
if (!knownVariants.includes(variant)) {
  throw new Error(
    `Unknown HERMES_DESKTOP_VARIANT ${variant}. expected one of ${knownVariants.map(v => v || '(empty)').join(', ')}`
  )
}

// 'store' is a Store-submission packaging identity layered on the bundled
// variant: same Electron app (displayName/appId/appNamePascal -> shared
// userData + single-instance lock with the out-of-store install), different
// MSIX package identity. The Store re-signs on submission.
const store = variant === 'store'
const light = variant === 'light'
const name = variants[store ? 'bundled' : (variant || '')]
// Enterprise family marker. False for every upstream variant, including the
// store build (which inherits the `bundled` name and must keep upstream
// behavior). True for all three Plankton environments.
const enterprise = Boolean(name.enterprise)

// The electron-updater feed channel this build PUBLISHES to. A canary
// tag (vX.Y.Z+canary.YYYYMMDDTHHMMSSZ) writes canary.yml / light-canary.yml;
// stable tags write latest.yml / light.yml. Keyed on the payload tag so
// the one release workflow serves both channels — a canary build can
// never overwrite the stable feed file, and vice versa.
const canary = /\+canary\.20\d{6}T\d{6}Z$/.test(process.env.HERMES_PAYLOAD_TAG || '')

// Nonstable installs own their package family and local desktop state. The
// seven-character commit suffix also names the CLI and fits MSIX's name cap.
const buildCommitEnv = process.env.HERMES_BUILD_COMMIT || ''
const buildCommit = /^[a-f0-9]{40}$/.test(buildCommitEnv) ? buildCommitEnv.slice(0, 7) : null
const displayName = buildCommit
  ? `${name.display} ${buildCommit}`
  : canary
    ? `${name.display} Canary`
    : name.display

const kebabSuffix = buildCommit ? `-${buildCommit}` : canary ? '-canary' : ''
const pascalSuffix = buildCommit ? `Commit${buildCommit}` : canary ? 'Canary' : ''
const cliName = `${light ? 'hermes-light' : 'hermes'}${kebabSuffix}`
if (store && (canary || buildCommit)) {
  throw new Error('Store packaging is only eligible for stable releases')
}

/** @typedef {import("./product-identity.d.cts")} ProductIdentity */

/** @type {ProductIdentity} */
const identity = {
  store,
  light,
  enterprise,
  // True only for a branded variant that ships the `bundled` runtime shape.
  bundledCarrier: Boolean(name.bundledCarrier),
  // The environment this artifact IS (`dev` / `test` / `prod`) and the single
  // segment its engine home inserts under the product root (`null` = the
  // historical `~/.plankton/engine/home`). Present only on the enterprise
  // family: the data roots derive from the ARTIFACT's baked identity, never
  // from a variable in the environment it happens to be launched in.
  ...(name.env ? { env: name.env, homeDir: name.homeDir ?? null } : {}),
  displayName,
  appId: `${name.appIdBase || `com.nousresearch.${name.kebab}`}${kebabSuffix}`,
  // Store and commit builds do not publish a release feed.
  channel: store || buildCommit ? null : light ? (canary ? 'light-canary' : 'light') : (canary ? 'canary' : 'latest'),
  appNamePascal: `${name.pascal}${pascalSuffix}`,
  artifactNamePascal: name.pascal,
  windowsExecutableName: kebabSuffix ? cliName : displayName,
  cliName,
  // Packaging artwork base (no extension), resolved by electron-builder,
  // scripts/mac-icon.cjs and scripts/after-pack.mjs. Upstream variants keep
  // 'assets/icon'.
  iconBase: name.iconBase || 'assets/icon',
  msixAppIdWithOrg: `NousResearch.${name.pascal}${pascalSuffix}`,
  ...(store
    ? {
        storeMsix: {
          // Partner Center publisher identity (the account's publisher ID) —
          // validated + re-signed by the Store on submission.
          identityName: 'NousResearchInc.HermesAgent',
          publisher: 'CN=EE6D86E4-606F-4E38-B940-AD7248C9D519',
          publisherDisplayName: 'Nous Research Inc.'
        }
      }
    : {})
}

const { channelBuildRequest } = require('../../scripts/msix-shared.mjs')
const request = channelBuildRequest()

// A channel created with --branding stable copies stable's identity, so it IS
// the regular app. It must also run like one: a token would make the runtime
// pin a userData dir and single-instance lock that installed stable doesn't use.
// The updater reads the token from the stamped request, not from this export.
const officialChannel =
  request !== null &&
  ['appId', 'displayName', 'appNamePascal', 'artifactNamePascal', 'windowsExecutableName', 'cliName', 'msixAppIdWithOrg'].every(
    key => request.identity[key] === identity[key]
  )

module.exports = !request
  ? identity
  : Object.freeze(
      officialChannel
        ? { ...identity, channel: request.channel }
        : { ...request.identity, store: false, light: false, channel: request.channel }
    )
