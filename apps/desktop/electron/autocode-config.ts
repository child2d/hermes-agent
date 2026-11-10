/**
 * autocode-config.ts
 *
 * Where the client looks for the payload source and its credentials.
 *
 * Resolution order (first hit wins), highest to lowest:
 *   1. environment        — dev override, CI, or a support fix without a rebuild
 *   2. <stateRoot>/settings.json — per-machine file; the installer/IT can drop it
 *   3. build-time defaults — injected by the pack script, so a distributed build
 *      needs zero setup on the colleague's machine
 *
 * The build-time values live behind `typeof` guards so a plain Node/test run
 * without the define does not throw.
 */

import fs from 'node:fs'
import path from 'node:path'

declare const __AUTOCODE_PAYLOAD_URL__: string | undefined
declare const __AUTOCODE_OSS_AK__: string | undefined
declare const __AUTOCODE_OSS_SK__: string | undefined

export interface AutocodeRemoteConfig {
  /** Base URL of the manifest, e.g. https://bucket.endpoint/autocode. Empty = no updates. */
  payloadUrl: string
  ak: string
  sk: string
  /** Which layer supplied the URL — logged so support can tell "not configured" from "misconfigured". */
  source: 'env' | 'settings' | 'build' | 'none'
}

export interface SettingsFile {
  payloadUrl?: string
  ossAk?: string
  ossSk?: string
}

function builtin(): { payloadUrl: string; ak: string; sk: string } {
  const read = (value: string | undefined): string =>
    typeof value === 'string' ? value.trim() : ''

  return {
    // Default points at the published AutoCode payload prefix; a build without
    // the define (tests, local dev) simply has no default.
    payloadUrl:
      typeof __AUTOCODE_PAYLOAD_URL__ === 'undefined' ? '' : read(__AUTOCODE_PAYLOAD_URL__),
    ak: typeof __AUTOCODE_OSS_AK__ === 'undefined' ? '' : read(__AUTOCODE_OSS_AK__),
    sk: typeof __AUTOCODE_OSS_SK__ === 'undefined' ? '' : read(__AUTOCODE_OSS_SK__)
  }
}

export function settingsPath(stateRoot: string): string {
  return path.join(stateRoot, 'settings.json')
}

export function readSettingsFile(stateRoot: string): SettingsFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(stateRoot), 'utf8')) as SettingsFile
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function pick(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }

  return ''
}

export function resolveRemoteConfig(
  env: Record<string, string | undefined>,
  stateRoot: string
): AutocodeRemoteConfig {
  const file = readSettingsFile(stateRoot) ?? {}
  const defaults = builtin()

  const fromEnv = (env.AUTOCODE_PAYLOAD_URL || '').trim()
  const fromFile = (file.payloadUrl || '').trim()
  const payloadUrl = pick(fromEnv, fromFile, defaults.payloadUrl)
  const source: AutocodeRemoteConfig['source'] = fromEnv
    ? 'env'
    : fromFile
      ? 'settings'
      : defaults.payloadUrl
        ? 'build'
        : 'none'

  return {
    payloadUrl,
    ak: pick(env.AUTOCODE_OSS_AK, file.ossAk, defaults.ak),
    sk: pick(env.AUTOCODE_OSS_SK, file.ossSk, defaults.sk),
    source
  }
}

/** Human-readable one-liner for the page and the log. */
export function describeRemoteConfig(config: AutocodeRemoteConfig): string {
  if (!config.payloadUrl) return '未配置更新源（将使用本地 AutoCode）'
  const origin = (() => {
    try {
      return new URL(config.payloadUrl).host
    } catch {
      return config.payloadUrl
    }
  })()

  return `更新源 ${origin}（${config.source === 'build' ? '构建内置' : config.source === 'settings' ? 'settings.json' : '环境变量'}）${config.ak ? '' : '，未配置凭证'}`
}
