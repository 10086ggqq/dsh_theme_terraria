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
 * 回退是双向的：
 *   - 主题页里「切回官方界面」/ Alt+O 写入 `localStorage['terraria.takeover'] = '0'`，
 *     本文件随即不再接管，官方界面 + 像素皮肤照常工作；
 *   - 回到官方界面后，本文件会在右下角挂一颗「泰拉瑞亚主题」像素按钮（以及 Alt+T），
 *     点它就清掉那个标记并重新进入主题页 —— 以前这个退路是单向的，切回去就只能靠
 *     开发者工具手动清 localStorage，看起来就像"主题坏了，只剩一张黄黄的皮"。
 *
 * 其他安全性：
 *   - 先预检主题页（HTTP 200 + text/html + 含主题标记），失败则什么都不做，
 *     只留那颗按钮，官方界面 + 像素皮肤照常工作；
 *   - 每次决策都会把结论写进 `localStorage['terraria.inject']`，界面出问题时不需
 *     开控制台也能看出是哪一步放弃的。
 *
 * 关闭方式：宿主环境变量 `DSH_TERRARIA_STANDALONE=0`（注入全局 takeover=false）。
 */

;(() => {
  'use strict'

  /** 页面里记录「不要再接管」的键。 */
  const TAKEOVER_KEY = 'terraria.takeover'
  /** 注入层自己的诊断快照（最近一次决策）。 */
  const DIAG_KEY = 'terraria.inject'
  /** 右下角那颗「进入主题」按钮的 id。 */
  const CHIP_ID = 'terraria-enter-chip'
  /** 重复注入防护：脚本被加载两次时只装一套按钮与监听。 */
  const GUARD = '__TERRARIA_INJECTION_INSTALLED__'
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
   * 主题页的完整地址（带宿主 origin，桌面壳里 WS 必须连宿主而不是 dsh-app://）。
   * @returns 可直接导航的 URL。
   */
  function themeHref() {
    const separator = THEME_URL.includes('?') ? '&' : '?'
    return `${THEME_URL}${separator}host=${encodeURIComponent(hostBase())}`
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
   * 记一条决策快照（失败不影响主流程）。
   * @param {object} record - 要记录的事实。
   */
  function note(record) {
    try {
      window.localStorage.setItem(DIAG_KEY, JSON.stringify({ at: new Date().toISOString(), ...record }))
    } catch {
      /* 存不进去就算了，不能因为诊断把接管搞挂 */
    }
  }

  /**
   * 清掉「不要再接管」标记并进入主题页。
   */
  function enterTheme() {
    try {
      window.localStorage.removeItem(TAKEOVER_KEY)
    } catch {
      /* 清不掉也照样导航：主题页自身不读这个键 */
    }
    location.replace(themeHref())
  }

  /**
   * 在官方界面右下角挂一颗像素按钮：官方界面是「切回」之后的状态，得能切回去。
   * @param {string} reason - 悬停提示，说明为什么现在停在官方界面。
   */
  function showChip(reason) {
    const mount = () => {
      if (document.getElementById(CHIP_ID) !== null) return
      const button = document.createElement('button')
      button.id = CHIP_ID
      button.type = 'button'
      button.textContent = '🌳 泰拉瑞亚主题'
      button.title = reason
      /* 内联样式：官方前端的模块 CSS 与本皮肤都不该管这颗按钮。 */
      const style = {
        position: 'fixed',
        right: '14px',
        bottom: '14px',
        zIndex: '2147483000',
        padding: '7px 12px',
        border: '2px solid #3a3a55',
        borderRadius: '0px',
        background: '#16182a',
        color: '#f5d76e',
        font: "12px/1.2 'FusionPixel', 'Microsoft YaHei', ui-monospace, monospace",
        letterSpacing: '.04em',
        cursor: 'pointer',
        boxShadow: '0 3px 0 #0000008c',
        opacity: '0.92',
      }
      for (const [key, value] of Object.entries(style)) button.style[key] = value
      /* 桌面壳里整页可能是 app-region: drag，按钮必须显式 no-drag 才点得动。 */
      button.style.setProperty('-webkit-app-region', 'no-drag')
      button.addEventListener('mouseenter', () => { button.style.opacity = '1' })
      button.addEventListener('mouseleave', () => { button.style.opacity = '0.92' })
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        enterTheme()
      })
      document.body.append(button)
    }
    if (document.body === null) document.addEventListener('DOMContentLoaded', mount, { once: true })
    else mount()
  }

  /**
   * 预检主题页并接管窗口。
   * @returns 是否已经发起导航。
   */
  async function takeover() {
    if (takeoverDisabled()) {
      note({ step: 'disabled', reason: CONFIG.takeover === false ? 'host-env' : 'localStorage' })
      showChip('已切回官方界面 · 点击重新进入泰拉瑞亚主题（Alt+T）')
      return false
    }
    let html
    try {
      const response = await fetch(THEME_URL, { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const type = response.headers.get('content-type') ?? ''
      if (!type.includes('text/html')) throw new Error(`content-type ${type}`)
      html = await response.text()
    } catch (error) {
      note({ step: 'precheck', ok: false, error: String(error) })
      console.warn('terraria: 主题页不可用，保留官方界面 + 像素皮肤', error)
      showChip('主题页不可用（详见 localStorage["terraria.inject"]）· 点击重试')
      return false
    }
    if (!html.includes('id="screen-title"')) {
      note({ step: 'precheck', ok: false, error: 'marker-missing', bytes: html.length })
      console.warn('terraria: 主题页内容不符合预期，保留官方界面 + 像素皮肤')
      showChip('主题页内容不符合预期 · 点击重试')
      return false
    }
    note({ step: 'navigate', ok: true, bytes: html.length })
    location.replace(themeHref())
    return true
  }

  try {
    /* 只有官方壳才有 #root；独立主题页里没有它，两套东西互不干扰。 */
    if (document.getElementById('root') !== null) {
      if (globalThis[GUARD] !== true) {
        globalThis[GUARD] = true
        /* Alt+T：任何时候都能进主题页（切回官方界面之后仍然有效）。 */
        window.addEventListener('keydown', (event) => {
          if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          if (event.key !== 't' && event.key !== 'T') return
          event.preventDefault()
          enterTheme()
        }, true)
      }
      takeover().catch((error) => {
        note({ step: 'takeover', ok: false, error: String(error) })
        console.warn('terraria: 接管失败，保留官方界面 + 像素皮肤', error)
      })
    } else {
      note({ step: 'skip', reason: 'no-root' })
    }
  } catch (error) {
    console.warn('terraria: injection layer disabled after an error', error)
  }
})()
