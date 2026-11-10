/** AutoCode companion — local orchestration service embedded in Plankton's rail. */

export const AUTOCODE_ROUTE = '/autocode'
/**
 * The AutoCode backend also serves the built SPA at `/` (`app.main` mounts
 * `frontend/dist`), so one process owns both API and UI.
 * Keep in sync with `electron/autocode-service.ts` (AUTOCODE_PORT).
 */
export const AUTOCODE_DEFAULT_URL = 'http://127.0.0.1:8787'
/** Query flag AutoCode frontend uses to skip Feishu setup (Plankton SSO already done). */
export const AUTOCODE_EMBED_QUERY = 'embed=plankton'

export function autocodeEmbedUrl(base = AUTOCODE_DEFAULT_URL): string {
  const root = base.replace(/\/$/, '')
  const join = root.includes('?') ? '&' : '?'
  return `${root}${join}${AUTOCODE_EMBED_QUERY}`
}
