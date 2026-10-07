/**
 * dsh-theme-terraria — 注入层（宿主索引注入表的 `script-src` 行）。
 *
 * 它只干一件事：**在官方壳里把窗口切到真正的主题页**。
 *
 * 桌面应用窗口加载的是 `dsh-app://app/` 内置的官方前端，宿主服务的 dist 在那里
 * 永远不会被请求，所以「换个 dist」或「给官方界面套一层 CSS」都得不到网页端那套
 * 界面。但同一自定义协议下的其他路径会带宿主 cookie 转发给宿主：
 * `dsh-app://app/terraria/theme.html` 落到的就是本插件的主题页。于是窗口里跑的是
 * **同一份 web/index.html** —— 布局、交互、音效、桌宠与网页端完全一致。
 *
 * 安全性：
 *   - 先预检主题页（HTTP 200 + text/html + 含主题标记），失败则什么都不做，
 *     官方界面 + 像素皮肤（terraria.css）照常工作；
 *   - 主题页里提供退路：标题屏「切回官方界面」或 Alt+O，会写入
 *     `localStorage['terraria.takeover'] = '0'` 并回到官方界面，本文件随即不再接管。
 *
 * 关闭方式：宿主环境变量 `DSH_TERRARIA_STANDALONE=0`（注入全局 takeover=false），
 * 或页面里写入 `localStorage['terraria.takeover'] = '0'`。
 */
;(() => {
  'use strict'

  /** 页面里记录「不要再接管」的键。 */
  const TAKEOVER_KEY = 'terraria.takeover'
  /** 宿主注入的配置（global 行），缺失时用默认值。 */
  const CONFIG = globalThis.__TERRARIA_THEME__ ?? {}
  /** 主题页路由；默认与插件 index.js 里的 ASSET_ROUTE + 别名一致。 */
  const THEME_URL = typeof CONFIG.themeUrl === 'string' && CONFIG.themeUrl !== '' ? CONFIG.themeUrl : '/terraria/theme.html'

  /**
   * 宿主地址：桌面壳里由宿主经 __DSH_TRANSPORT__ 提供，浏览器里就是页面自己。
   * @returns 形如 http://127.0.0.1:19387 的地址（无尾斜杠）。
   */
  function hostBase() {
    const transport = globalThis.__DSH_TRANSPORT__
    if (transport !== undefined && transport !== null && typeof transport.streamBaseUrl === 'string' && transport.streamBaseUrl !== '') {
      return transport.streamBaseUrl.replace(/\/+$/, '')
    }
    return location.origin
  }

  /**
   * 用户是否在页面里关掉了接管。
   * @returns 关闭时为 true。
   */
  function takeoverDisabled() {
    if (CONFIG.takeover === false) return true
    try {
      return window.localStorage.getItem(TAKEOVER_KEY) === '0'
    } catch {
      return false
    }
  }

  /**
   * 预检主题页并接管窗口。
   * @returns 是否已经发起导航。
   */
  async function takeover() {
    if (takeoverDisabled()) return false
    let html
    try {
      const response = await fetch(THEME_URL, { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const type = response.headers.get('content-type') ?? ''
      if (!type.includes('text/html')) throw new Error(`content-type ${type}`)
      html = await response.text()
    } catch (error) {
      console.warn('terraria: 主题页不可用，保留官方界面 + 像素皮肤', error)
      return false
    }
    if (!html.includes('id="screen-title"')) {
      console.warn('terraria: 主题页内容不符合预期，保留官方界面 + 像素皮肤')
      return false
    }
    const separator = THEME_URL.includes('?') ? '&' : '?'
    location.replace(`${THEME_URL}${separator}host=${encodeURIComponent(hostBase())}`)
    return true
  }

  try {
    /* 只有官方壳才有 #root；独立主题页里没有它，两套东西互不干扰。 */
    if (document.getElementById('root') !== null) {
      takeover().catch((error) => {
        console.warn('terraria: 接管失败，保留官方界面 + 像素皮肤', error)
      })
    }
  } catch (error) {
    console.warn('terraria: injection layer disabled after an error', error)
  }
})()
