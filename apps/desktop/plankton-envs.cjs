// plankton-envs.cjs — the Plankton environment table: ONE entry per
// environment, and the single source every other enumeration keys on.
//
// WHY A TABLE AND NOT A RUNTIME SWITCH
// ------------------------------------
// Plankton ships as three INDEPENDENT apps (dev / test / prod), not as one
// artifact that reads an environment variable. The environment decides the app
// id, the OS-visible app name, the desktop userData dir and the engine home,
// and it is baked into the artifact at build time: an artifact's identity comes
// from its own install stamp (scripts/bundle-electron-main.mjs — "The stamp is
// the whole source: no build env"). A build handed to a colleague therefore
// cannot be redirected by whatever variables happen to be in their shell,
// which is the failure this split exists to prevent.
//
// PROD KEEPS ITS HISTORICAL VALUES VERBATIM (`plankton`, `com.shaoke.plankton`,
// `~/.plankton/engine/home`): an existing install must not move, and its
// sessions/config stay where they are. `homeDir: null` means "the historical
// product root itself"; any other value inserts ONE segment under it
// (`~/.plankton/<homeDir>/engine/home`), so the engine's own `engine/home`
// leaf stays intact in every environment.
//
// Adding an environment = adding one entry here. Nothing else in JS re-lists
// the family. `scripts/write_install_stamp.py` keeps its own tuple because
// Python cannot require a .cjs; `plankton-envs.test.mjs` asserts the two agree.
// @ts-check
'use strict'

/** @typedef {{ variant: string, env: string, display: string, kebab: string, pascal: string, appIdBase: string, homeDir: string|null }} PlanktonEnv */

/** @type {Record<string, PlanktonEnv>} */
const PLANKTON_ENVS = Object.freeze({
  prod: Object.freeze({
    variant: 'plankton',
    env: 'prod',
    display: 'Plankton',
    kebab: 'plankton',
    pascal: 'Plankton',
    appIdBase: 'com.shaoke.plankton',
    homeDir: null
  }),
  test: Object.freeze({
    variant: 'plankton-test',
    env: 'test',
    display: 'Plankton Test',
    kebab: 'plankton-test',
    pascal: 'PlanktonTest',
    appIdBase: 'com.shaoke.plankton.test',
    homeDir: 'test'
  }),
  dev: Object.freeze({
    variant: 'plankton-dev',
    env: 'dev',
    display: 'Plankton Dev',
    kebab: 'plankton-dev',
    pascal: 'PlanktonDev',
    appIdBase: 'com.shaoke.plankton.dev',
    homeDir: 'dev'
  })
})

/** Every environment variant name — what the stamp, the bundler and the
 *  packager recognise the family by. */
const PLANKTON_VARIANTS = Object.freeze(Object.values(PLANKTON_ENVS).map(spec => spec.variant))

/** True for any Plankton environment variant. The one predicate the family
 *  checks share, so a new environment cannot be half-recognised.
 *  @param {unknown} variant
 *  @returns {boolean} */
function isPlanktonVariant(variant) {
  return PLANKTON_VARIANTS.includes(String(variant || '').trim())
}

/** The environment a VARIANT name selects (`plankton-test`), or null.
 *  @param {unknown} variant
 *  @returns {PlanktonEnv | null} */
function planktonEnvFor(variant) {
  const key = String(variant || '').trim()
  return Object.values(PLANKTON_ENVS).find(spec => spec.variant === key) || null
}

/** The environment an ENV name selects (`test`) — what PLANKTON_ENV=… and the
 *  per-environment manifest file are keyed on.
 *  @param {unknown} name
 *  @returns {PlanktonEnv | null} */
function planktonEnvByName(name) {
  const key = String(name || '').trim()
  return Object.prototype.hasOwnProperty.call(PLANKTON_ENVS, key) ? PLANKTON_ENVS[/** @type {keyof typeof PLANKTON_ENVS} */ (key)] : null
}

module.exports = { PLANKTON_ENVS, PLANKTON_VARIANTS, isPlanktonVariant, planktonEnvFor, planktonEnvByName }