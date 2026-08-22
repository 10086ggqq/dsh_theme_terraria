/**
 * dsh-theme-terraria — the Terraria theme as a dsh Web-surface bundle plugin.
 *
 * Exports the Cordis plugin face (`name`, `inject`, `apply(ctx, config)`)
 * required by the DeepSeek Harness plugin spec. The theme does not reimplement
 * the Web runtime: `apply` delegates to the official `@deepseek-ai/dsh-web-app`
 * plugin with one substitution — the frontend dist resolver is pointed at this
 * package's `web/` directory instead of the official React build. Everything
 * the official web-runtime row owns (dist serving, the `webRuntime` trust
 * fence for the /api routes, the web-surface prompt section, the `DSH_WEB_URL`
 * shell variable, the URL line) keeps working unchanged.
 *
 * @module dsh-theme-terraria
 */

import { fileURLToPath } from 'node:url'
import * as WebApp from '@deepseek-ai/dsh-web-app'

/** Stable Cordis plugin name. */
export const name = 'terraria-theme'

/** The theme dist shipped inside this package: web/index.html plus its assets. */
const THEME_DIST_INDEX = fileURLToPath(new URL('./web/index.html', import.meta.url))

/**
 * Mount the Terraria theme over the Web runtime.
 *
 * Delegates to the official web-app plugin after substituting its frontend
 * dist resolver (the package's documented internals hook) so the browser gets
 * the Terraria frontend while every other Web behavior is preserved.
 *
 * @param ctx - plugin context (the row injects `webStartup`; the delegated
 *   plugin injects `webServer` itself).
 * @param config - the same shape the official web-runtime row takes:
 *   `printUrl` and `surfaceContext` booleans plus `trustedHosts` strings.
 */
export function apply(ctx, config) {
  WebApp.internals.resolveDistIndex = () => THEME_DIST_INDEX
  ctx.plugin(WebApp, config)
}
