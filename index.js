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
 * The official web-app package is a peer dependency provided by the dsh
 * installation, never installed into the profile: pnpm runs with
 * `autoInstallPeers: false`, and this package may even live outside the
 * profile tree (local/link installs make Node resolve imports from the real
 * package path), so a static top-level `import` of the peer dies with
 * ERR_MODULE_NOT_FOUND. `apply` therefore resolves the peer at runtime from
 * host-owned anchors: the loader's `baseUrl` (the profile directory — its
 * parent `profiles/node_modules` holds dsh's healed module fallback that
 * symlinks every app dependency) and the dsh process entry.
 *
 * @module dsh-theme-terraria
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Stable Cordis plugin name. */
export const name = 'terraria-theme'

/** The theme dist shipped inside this package: web/index.html plus its assets. */
const THEME_DIST_INDEX = fileURLToPath(new URL('./web/index.html', import.meta.url))

/** The peer package this theme delegates the Web runtime to. */
const WEB_APP_PACKAGE = '@deepseek-ai/dsh-web-app'

/**
 * Collect host-owned resolution anchors, most authoritative first.
 *
 * Each entry is a filesystem path (or `file:` URL) whose directory chain
 * reaches the dsh installation's copy of the peer: the loader's profile
 * `baseUrl` walks up to the healed `profiles/node_modules` fallback, and the
 * process entry sits inside the dsh install tree itself.
 * @param ctx - plugin context carrying the loader-injected `baseUrl`.
 * @returns candidate anchor paths, possibly empty.
 */
function hostAnchors(ctx) {
  const anchors = []
  const push = (value) => {
    if (typeof value !== 'string' || value === '') return
    if (value.startsWith('file:')) {
      try { anchors.push(fileURLToPath(value)) } catch { /* malformed URL: skip */ }
    } else {
      anchors.push(value)
    }
  }
  // Loader writes the profile directory onto the root context; forked plugin
  // contexts read it through the prototype chain.
  push(ctx.baseUrl)
  const loader = typeof ctx.get === 'function' ? ctx.get('loader') : undefined
  push(loader?.config?.baseUrl)
  // The dsh CLI entry file: inside the dsh installation tree on npm installs.
  push(process.argv[1])
  return anchors
}

/**
 * Resolve the official web-app entry file from a host anchor.
 * @param ctx - plugin context carrying the loader-injected `baseUrl`.
 * @returns absolute path of the peer package's entry JS file.
 * @throws when no anchor resolves the peer (dsh installation not reachable).
 */
function resolveWebAppEntry(ctx) {
  const anchors = hostAnchors(ctx)
  for (const anchor of anchors) {
    try {
      // A fictitious filename inside the anchor directory: createRequire only
      // uses its dirname as the Node resolution starting point.
      return createRequire(join(anchor, 'index.js')).resolve(WEB_APP_PACKAGE)
    } catch { /* try the next anchor */ }
  }
  throw new Error(
    `dsh-theme-terraria: cannot resolve ${WEB_APP_PACKAGE} from the dsh installation `
    + `(it is a peer dependency provided by dsh). Tried anchors: ${anchors.join(', ') || 'none'}. `
    + 'Ensure dsh itself is installed and launching this plugin.',
  )
}

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
 * @returns a promise resolving once the delegated plugin is mounted.
 */
export async function apply(ctx, config) {
  const entry = resolveWebAppEntry(ctx)
  // Import through an absolute file URL so the peer loads regardless of where
  // this theme package physically sits.
  const WebApp = await import(pathToFileURL(entry).href)
  if (typeof WebApp.internals?.resolveDistIndex !== 'function') {
    throw new Error(`dsh-theme-terraria: ${WEB_APP_PACKAGE} does not expose internals.resolveDistIndex; the theme needs a dsh version providing it`)
  }
  WebApp.internals.resolveDistIndex = () => THEME_DIST_INDEX
  ctx.plugin(WebApp, config)
}
