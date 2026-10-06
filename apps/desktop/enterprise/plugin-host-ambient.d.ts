/**
 * Host-provided ambient surface for the ENTERPRISE type-check lane only.
 *
 * The desktop-plugin loader evaluates `plankton-enterprise/desktop/plugin.js`
 * as a blob and injects three host specifiers: `@hermes/plugin-sdk`, `react`
 * and `react/jsx-runtime`. Resolving them for real drags the whole renderer
 * `src/**` graph into this lane (and its Vite-only ambient decls) — the lane
 * is meant to guard the PLUGIN's own logic, not re-check the host app.
 *
 * So this lane types those three specifiers as the host contract (`any`) and
 * spends its diagnostics budget on the plugin's own references / syntax /
 * local type misuse. See tsconfig.enterprise.json.
 */
export const Button: any
export const ConfirmDialog: any
export const GlyphSpinner: any
export const SearchField: any
export const icons: any
export const useEffect: any
export const useState: any
export function jsx(...args: any[]): any
export function jsxs(...args: any[]): any
