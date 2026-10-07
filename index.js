/**
 * dsh-theme-terraria — 泰拉瑞亚像素主题，两条路一起修。
 *
 * ## 为什么需要两条路
 *
 * 桌面版（Electron）主窗口加载的是 `dsh-app://app/`，它的协议处理器把
 * `/`、`/index.html`、`/assets/*` 直接映射到**应用内置**的官方前端
 * （`resources.dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist`），
 * 只把其余路径转发给宿主。也就是说：宿主服务出来的 dist（本包 `web/`）
 * **在桌面窗口里永远不会被请求** —— 单纯"替换被服务的 dist"只对
 * 「用浏览器打开宿主 URL」有效。
 *
 * 桌面窗口与宿主之间真正的共用扩展点是**索引注入表**
 * `webserver/index-inject`（见 @deepseek-ai/dsh-host-webserver）：
 * 桌面主进程用 `collectIndexInjections()` 取表，经 IPC 交给官方 shell，
 * shell 按行应用（global / script / script-src / script-preload / style / html
 * 全部支持，见 dsh-web-frontend 的 boot 代码）。所以：
 *
 *   - 保留原有的 dist 替换 → 浏览器路径得到完整的独立主题前端（web/）；
 *   - 追加注入式皮肤（skin/）→ 桌面窗口与浏览器都能给官方界面换皮。
 *
 * ## peer 依赖的解析
 *
 * 官方 `@deepseek-ai/dsh-web-app` 是 dsh 安装自带的 peer：pnpm 以
 * `autoInstallPeers: false` 安装，本包又常常是 link 安装（Node 从真实路径
 * 解析），静态 `import` 会 ERR_MODULE_NOT_FOUND。因此 `apply` 在运行时
 * 从宿主锚点（loader 的 baseUrl、dsh 进程入口）解析 peer 的绝对路径。
 *
 * @module dsh-theme-terraria
 */

import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Stable Cordis plugin name. */
export const name = 'terraria-theme'

/** 独立主题前端（浏览器路径下替换官方 dist）：web/index.html 及其资源。 */
const THEME_DIST_INDEX = fileURLToPath(new URL('./web/index.html', import.meta.url))

/** 注入式皮肤：样式表（内联注入 <style>）。 */
const SKIN_STYLESHEET = fileURLToPath(new URL('./skin/terraria.css', import.meta.url))

/** 注入式皮肤：行为脚本（以 script-src 行注入，走 /terraria/ 路由）。 */
const SKIN_SCRIPT = 'terraria.js'

/**
 * 主题页别名：注入层通过它把桌面窗口切到完整主题页。
 *
 * 桌面壳里 `/` 被应用内置前端占用，只有非内置路径才会转发给宿主，所以主题页需要
 * 一个自己的路由。它服务的就是 `web/index.html`——浏览器路径下被服务的那份文档，
 * 于是「桌面窗口」与「网页端」跑的是同一份 UI。
 */
const THEME_ALIAS = 'theme.html'

/**
 * 登录状态别名：`GET /terraria/account` 返回宿主侧的账号快照 JSON。
 *
 * 页面用它而不是索引注入：注入值在启动时收集一次就固定了，而登录 / 退登随时
 * 会变。这条路由与主题页同源，页面不需要额外的鉴权头，也不经过 `/api`。
 */
const ACCOUNT_ALIAS = 'account'

/** 皮肤资源路由前缀：桌面窗口里会转发给宿主，浏览器里直接命中宿主路由。 */
const ASSET_ROUTE = '/terraria'

/**
 * 皮肤资源的查找根目录。`skin/` 放皮肤自己的文件，`web/` 复用主题前端
 * 已有的字体与壁纸（避免把 600KB 字体复制两份）。
 */
const ASSET_ROOTS = [
  fileURLToPath(new URL('./skin/', import.meta.url)),
  fileURLToPath(new URL('./web/', import.meta.url)),
]

/** 扩展名到 MIME 的映射；未知扩展名按 application/octet-stream 处理。 */
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.html': 'text/html; charset=utf-8',
}

/** 已在本次进程里警告过的皮肤故障，避免每个页面请求都刷日志。 */
const warned = new Set()

/**
 * 给页面的账号状态快照（纯 JSON，`GET /terraria/account` 直接回它）。
 *
 * 路由处理是同步的，所以这里不阻塞：`refreshAccountStatus` 在后台问账号
 * 服务，路由只回最近一次结果。初值 `unknown` 让页面不去猜——
 * 猜错的代价正是「明明用账号登录，却被催着填 API 密钥」。
 */
const accountStatus = {
  value: { status: 'unknown', role: 'unknown' },
  inflight: null,
  timer: null,
  lastAskAt: 0,
}

/** 两次账号查询之间的最小间隔（毫秒），避免页面反复刷新时打爆凭证库。 */
const ACCOUNT_MIN_INTERVAL_MS = 800

/** 询问账号服务的超时（毫秒）：账号侧卡住不能把状态永远留在 unknown。 */
const ACCOUNT_ASK_TIMEOUT_MS = 3000

/**
 * 给账号查询套一层超时。
 * @param {unknown} promise - 账号服务的 promise。
 * @param {number} ms - 超时毫秒。
 * @returns {Promise<unknown>} 原 promise，超时则以 `undefined` 兑现。
 */
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value) },
      () => { clearTimeout(timer); resolve(undefined) },
    )
  })
}

/**
 * 账号服务实例（未挂载该服务时为 undefined）。
 * @param {object} ctx - 插件上下文。
 * @returns {object|undefined} deepseekAccount 服务。
 */
function accountService(ctx) {
  for (const scope of [ctx, ctx?.root]) {
    try {
      if (scope !== undefined && typeof scope.get === 'function') {
        const service = scope.get('deepseekAccount')
        if (service !== undefined) return service
      }
    } catch {
      /* 这个作用域拿不到就试下一个 */
    }
  }
  return undefined
}

/**
 * 真去问一次账号服务，并更新快照。
 * @param {object} ctx - 插件上下文。
 * @returns {Promise<void>} 查询结束（失败也算结束）。
 */
async function askAccount(ctx) {
  accountStatus.lastAskAt = Date.now()
  try {
    const service = accountService(ctx)
    if (typeof service?.getState !== 'function') return
    const view = await withTimeout(service.getState(), ACCOUNT_ASK_TIMEOUT_MS)
    if (view?.status !== 'credential-stored') {
      accountStatus.value = { status: 'signed-out', role: 'api-key' }
      return
    }
    let profile = null
    try {
      if (typeof service.getProfile === 'function') profile = await withTimeout(service.getProfile(), ACCOUNT_ASK_TIMEOUT_MS)
    } catch {
      /* 资料读不到不影响「已登录」这个结论 */
    }
    accountStatus.value = {
      status: 'signed-in',
      role: 'account',
      name: typeof profile?.name === 'string' && profile.name !== '' ? profile.name : null,
      contact: typeof profile?.contact === 'string' && profile.contact !== '' ? profile.contact : null,
      avatarUrl: typeof profile?.avatarUrl === 'string' && profile.avatarUrl !== '' ? profile.avatarUrl : null,
    }
  } catch {
    /* 读不到就保持上一次的结论，等下一次路由请求或定时刷新再试 */
  }
}

/**
 * 触发一次后台刷新（同一时间只跑一个）。
 *
 * @param {object} ctx - 插件上下文。
 * @param {boolean} [force] - 忽略最小间隔（登录 / 退登事件用）。
 * @returns {Promise<void>} 本轮查询结束。
 */
function refreshAccountStatus(ctx, force = false) {
  if (accountStatus.inflight !== null) return accountStatus.inflight
  const wait = force ? 0 : ACCOUNT_MIN_INTERVAL_MS - (Date.now() - accountStatus.lastAskAt)
  if (wait > 0) return Promise.resolve()
  accountStatus.inflight = askAccount(ctx).finally(() => {
    accountStatus.inflight = null
  })
  return accountStatus.inflight
}

/**
 * 定时刷新账号状态，让登录 / 退登在页面重新载入前也能被看到。
 * @param {object} ctx - 插件上下文。
 */
function watchAccountStatus(ctx) {
  if (accountStatus.timer !== null) return
  accountStatus.timer = setInterval(() => { refreshAccountStatus(ctx) }, 15000)
  accountStatus.timer.unref?.()
  /* 退登是账号侧主动广播的事件，收到就地重算，不等下一次 tick。 */
  for (const event of ['deepseek-account/signed-out', 'deepseek-account/session-expired']) {
    try {
      ctx.on?.(event, () => { refreshAccountStatus(ctx, true) })
    } catch {
      /* 事件总线不可用时只靠定时刷新 */
    }
  }
  refreshAccountStatus(ctx, true)
}

/**
 * 打印一次即可的警告。
 * @param ctx - 插件上下文（取 logger）。
 * @param key - 去重键。
 * @param message - 日志正文。
 */
function warnOnce(ctx, key, message) {
  if (warned.has(key)) return
  warned.add(key)
  try {
    ctx.logger?.warn?.(message)
  } catch {
    console.warn(message)
  }
}

/** 皮肤是否启用：`DSH_TERRARIA_SKIN=0|off|false|no` 可临时关掉。 */
function skinEnabled() {
  const flag = process.env.DSH_TERRARIA_SKIN
  if (flag === undefined || flag === '') return true
  return !['0', 'off', 'false', 'no'].includes(flag.trim().toLowerCase())
}

/** 是否允许注入层把桌面窗口切到完整主题页：`DSH_TERRARIA_STANDALONE=0|off|false|no` 关闭。 */
function standaloneEnabled() {
  const flag = process.env.DSH_TERRARIA_STANDALONE
  if (flag === undefined || flag === '') return true
  return !['0', 'off', 'false', 'no'].includes(flag.trim().toLowerCase())
}

/**
 * 收集宿主解析锚点，最权威的在前。
 *
 * 每个锚点都是文件系统路径（或 `file:` URL），其目录链能到达 dsh 安装内
 * 的 peer 副本：loader 的 profile `baseUrl` 上溯到 profiles/node_modules
 * 回退链接，进程入口则落在 dsh 安装树里。
 * @param ctx - 携带 loader 注入的 `baseUrl` 的插件上下文。
 * @returns 候选锚点路径，可能为空。
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
 * 从宿主锚点解析官方 web-app 入口文件。
 * @param ctx - 携带 loader 注入的 `baseUrl` 的插件上下文。
 * @returns peer 包入口 JS 的绝对路径。
 * @throws 当所有锚点都无法解析出 peer（dsh 安装不可达）时。
 */
function resolveWebAppEntry(ctx) {
  const anchors = hostAnchors(ctx)
  for (const anchor of anchors) {
    try {
      // A fictitious filename inside the anchor directory: createRequire only
      // uses its dirname as the Node resolution starting point.
      return createRequire(join(anchor, 'index.js')).resolve('@deepseek-ai/dsh-web-app')
    } catch { /* try the next anchor */ }
  }
  throw new Error(
    'dsh-theme-terraria: cannot resolve @deepseek-ai/dsh-web-app from the dsh installation '
    + `(it is a peer dependency provided by dsh). Tried anchors: ${anchors.join(', ') || 'none'}. `
    + 'Ensure dsh itself is installed and launching this plugin.',
  )
}

/**
 * 在允许的根目录里定位一个皮肤资源：`skin/` 找不到时继续找 `web/`。
 * @param name - 路由解码后的文件名（不含前导斜杠）。
 * @returns 绝对路径；越界或不存在时返回 undefined。
 */
function resolveAsset(name) {
  if (name === '' || name.includes('\0')) return undefined
  const normalized = name.replaceAll('\\', '/')
  if (normalized.split('/').includes('..')) return undefined
  for (const root of ASSET_ROOTS) {
    const target = resolve(root, normalized)
    // 根目录来自 new URL('./x/', import.meta.url)，一律带尾部分隔符。
    if (!target.startsWith(root)) continue
    try {
      if (statSync(target).isFile()) return target
    } catch {
      /* 这个根目录里没有：继续下一个 */
    }
  }
  return undefined
}

/**
 * 判定资源响应的 MIME：先按扩展名，再按魔数兜底。
 *
 * 主题里的 `forest.png` 等文件实际是 WebP（只是沿用了 .png 名字），
 * 用真实类型发送可以让浏览器少一次嗅探。
 * @param file - 资源绝对路径。
 * @param body - 资源内容（用于魔数判断）。
 * @returns content-type 值。
 */
function contentTypeOf(file, body) {
  const head = body.subarray(0, 12)
  if (head.length >= 12 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png'
  if (head.length >= 4 && head.toString('latin1', 0, 4) === 'wOF2') return 'font/woff2'
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 处理一个皮肤资源请求：只服务允许目录里的只读文件。
 * @param req - node:http 请求。
 * @param res - node:http 响应。
 */
function serveAsset(req, res, ctx = undefined) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  let name
  try {
    /* v8 ignore next -- node:http always sets url on server requests */
    name = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.slice(ASSET_ROUTE.length + 1))
  } catch {
    res.writeHead(400)
    res.end()
    return
  }
  if (name === ACCOUNT_ALIAS) {
    /* 顺手催一次刷新：缓存过期时下一次请求就能拿到新值，本次也先回已有的。 */
    if (ctx !== undefined) refreshAccountStatus(ctx)
    const body = Buffer.from(JSON.stringify(accountStatus.value), 'utf8')
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
      'content-length': String(body.byteLength),
    })
    res.end(req.method === 'HEAD' ? undefined : body)
    return
  }
  const file = name === THEME_ALIAS ? THEME_DIST_INDEX : resolveAsset(name)
  if (file === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  let body
  try {
    body = readFileSync(file)
  } catch {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': contentTypeOf(file, body),
    // no-cache：皮肤文件很小，改完刷新即可看到效果，省掉一整轮重启。
    'cache-control': 'no-cache',
    'content-length': String(body.byteLength),
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

/**
 * 组装本插件要注入索引的注入行。
 *
 * 顺序即应用顺序：先样式（官方界面的兜底皮肤），再全局配置（主题页地址 + 接管开关），
 * 最后是注入层脚本本身。样式表在每次取表时重新读盘（索引渲染很少发生），这样改完
 * CSS 只要刷新页面就能看到效果；脚本走 `script-src`，避免把代码内联进 HTML 文本。
 * @param ctx - 插件上下文（用于一次性告警）。
 * @returns 注入行数组；样式表读不到时跳过样式行。
 */
function injectionRows(ctx) {
  const rows = []
  if (skinEnabled()) {
    try {
      rows.push({ kind: 'style', text: readFileSync(SKIN_STYLESHEET, 'utf8') })
    } catch (error) {
      warnOnce(ctx, 'css', `dsh-theme-terraria: cannot read ${SKIN_STYLESHEET}: ${String(error)}`)
    }
  }
  rows.push({
    kind: 'global',
    name: '__TERRARIA_THEME__',
    value: { themeUrl: `${ASSET_ROUTE}/${THEME_ALIAS}`, takeover: standaloneEnabled() },
  })
  /* 登录角色不再走索引注入：注入值在应用启动时就固定了，而账号状态是随时会
     变的。页面改为按需 GET `/terraria/account`（见 ACCOUNT_ALIAS）。 */
  rows.push({ kind: 'script-src', placement: 'body', src: `${ASSET_ROUTE}/${SKIN_SCRIPT}` })
  return rows
}

/**
 * 挂载泰拉瑞亚主题。
 *
 * 1. 注册 `/terraria/*` 路由（`/terraria/theme.html` 即 `web/index.html`，
 *    `/terraria/account` 回登录角色 JSON），并向宿主的
 *    索引注入表推入：兜底皮肤样式行、`__TERRARIA_THEME__` 配置全局、注入层脚本行。
 *    桌面应用窗口靠这一路把窗口接管到主题页，跑的是与网页端同一份 UI；
 * 2. 委托官方 `@deepseek-ai/dsh-web-app` 插件挂载整个 Web 运行时，只替换它的前端
 *    dist 解析器，让浏览器打开宿主 URL 时直接得到完整主题前端。
 *
 * @param ctx - 插件上下文（行注入 `webStartup`；被委托的插件自己注入 `webServer`）。
 * @param config - 与官方 web-runtime 行同形：`printUrl` / `surfaceContext`
 *   两个布尔值与 `trustedHosts` 字符串数组。
 * @returns 被委托插件挂载完成时兑现的 promise。
 */
export async function apply(ctx, config) {
  // 账号状态：后台刷新 + 定时重算，注入行只读快照（同步渲染不能等待）。
  refreshAccountStatus(ctx, true)
  watchAccountStatus(ctx)
  // 注入层：资源路由（含主题页别名）+ 索引注入行。放在委托之前，任何一侧失败都不影响另一侧。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: ASSET_ROUTE, handler: (req, res) => serveAsset(req, res, webCtx) }),
      'terraria-theme: theme assets',
    )
    webCtx.effect(
      () => webCtx.on('webserver/index-inject', (table) => {
        // 每次渲染都顺手催一次刷新：两次页面载入之间换了登录状态，也能在本次注入里反映。
        refreshAccountStatus(ctx)
        table.push(...injectionRows(webCtx))
      }),
      'terraria-theme: index injection',
    )
  })

  const entry = resolveWebAppEntry(ctx)
  // Import through an absolute file URL so the peer loads regardless of where
  // this theme package physically sits.
  const WebApp = await import(pathToFileURL(entry).href)
  if (typeof WebApp.internals?.resolveDistIndex !== 'function') {
    throw new Error('dsh-theme-terraria: @deepseek-ai/dsh-web-app does not expose internals.resolveDistIndex; the theme needs a dsh version providing it')
  }
  WebApp.internals.resolveDistIndex = () => THEME_DIST_INDEX
  ctx.plugin(WebApp, config)
}
