/**
 * SiYuan Bridge — browser half.
 *
 * Contributes one global main panel (`siyuan-bridge`) and its sidebar entry.
 * The panel frames the local bridge service at 127.0.0.1:5599; that service
 * holds the SiYuan kernel token and does all reading/writing, so this plugin
 * never touches the kernel and needs no credentials.
 */
window.__ModuleLoader__.load({
  id: 'dsh-siyuan-bridge',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useRef, useCallback } = React

    const NS = 'siyuanBridge'
    const PANEL_ID = 'siyuan-bridge'
    const STORAGE_KEY = 'siyuan-bridge.url'
    const DEFAULT_URL = 'http://127.0.0.1:5599/'
    const inject = ['slots', 'locale']

    const DICT = {
      zh: {
        panel: '思源桥',
        refresh: '刷新',
        open: '在浏览器打开',
        settings: '桥接设置',
        bridgeUrl: '桥接服务地址',
        save: '保存',
        down: '桥接服务没有响应',
        downTip: '在 siyuan-bridge 目录运行 start.cmd（或 node server.mjs）启动服务，然后点重试。',
        retry: '重试',
        close: '关闭',
        import: '存入整理稿',
      },
      en: {
        panel: 'SiYuan Bridge',
        refresh: 'Reload',
        open: 'Open in browser',
        settings: 'Bridge settings',
        bridgeUrl: 'Bridge service URL',
        save: 'Save',
        down: 'The bridge service is not responding',
        downTip: 'Start it with start.cmd (or node server.mjs) inside the siyuan-bridge folder, then retry.',
        retry: 'Retry',
        close: 'Close',
        import: 'Save write-up',
      },
    }

    const normalizeUrl = (value) => {
      let url = String(value || '').trim() || DEFAULT_URL
      if (!/^https?:\/\//i.test(url)) url = 'http://' + url
      if (!url.endsWith('/')) url += '/'
      return url
    }

    const readUrl = () => {
      try { return normalizeUrl(window.localStorage.getItem(STORAGE_KEY) || DEFAULT_URL) } catch { return DEFAULT_URL }
    }

    // ---------------------------------------------------------------- health
    // The sidebar icon shows whether the bridge (and through it the kernel) is
    // reachable. Three sources, in order of precision:
    //   1. the panel's iframe posts its own /api/status result to us;
    //   2. a CORS read of /api/status while the service allows it;
    //   3. a no-cors probe, which only proves the port answers.
    const health = { state: 'unknown', listeners: new Set() }
    const setHealth = (state) => {
      if (health.state === state) return
      health.state = state
      health.listeners.forEach((listener) => listener(state))
    }
    const subscribeHealth = (listener) => {
      health.listeners.add(listener)
      listener(health.state)
      return () => { health.listeners.delete(listener) }
    }

    async function probe() {
      const url = readUrl()
      try {
        const res = await fetch(url + 'api/status', { cache: 'no-store', signal: AbortSignal.timeout(3000) })
        if (!res.ok) { setHealth('down'); return }
        const data = await res.json().catch(() => null)
        setHealth(data && data.kernel ? 'ok' : 'service')
      } catch {
        try {
          await fetch(url + 'api/status', { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(3000) })
          setHealth('service')
        } catch {
          setHealth('down')
        }
      }
    }

    let probeTimer = 0
    function startProbe() {
      if (probeTimer) return
      void probe()
      probeTimer = window.setInterval(probe, 20000)
    }

    function useHealth() {
      const [state, setState] = useState(health.state)
      useEffect(() => subscribeHealth(setState), [])
      return state
    }

    const writeUrl = (url) => {
      try { window.localStorage.setItem(STORAGE_KEY, normalizeUrl(url)) } catch { /* storage unavailable */ }
    }

    const CSS = `
.syb-root { position: relative; display: flex; flex-direction: column; flex: 1 1 auto; height: 100%; min-height: 0; background: var(--dsw-alias-bg-layer-1, #fff); }
.syb-frame { flex: 1 1 auto; width: 100%; min-height: 0; height: 100%; border: 0; display: block; background: #fff; }
.syb-pill { position: absolute; right: 14px; bottom: 14px; display: flex; gap: 4px; padding: 4px; border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-bg-layer-2, #fff) 88%, transparent); border: 1px solid var(--dsw-alias-border-l1, #e3e5ea);
  box-shadow: 0 6px 20px rgba(15, 20, 34, .12); backdrop-filter: blur(8px); opacity: .5; transition: opacity .18s ease; }
.syb-pill:hover, .syb-pill:focus-within { opacity: 1; }
.syb-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0;
  border: 0; border-radius: 999px; background: transparent; color: var(--dsw-alias-label-secondary, #5a6072); cursor: pointer; }
.syb-icon-btn:hover { background: var(--dsw-alias-bg-layer-3, #f1f2f5); color: var(--dsw-alias-label-primary, #1d2027); }
.syb-card { position: absolute; right: 14px; bottom: 56px; width: 320px; padding: 14px 16px 12px; border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2, #fff); border: 1px solid var(--dsw-alias-border-l1, #e3e5ea);
  box-shadow: 0 12px 32px rgba(15, 20, 34, .18); color: var(--dsw-alias-label-primary, #1d2027); font-size: 13px; z-index: 3; }
.syb-card h4 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
.syb-card label { display: block; margin: 0 0 4px; color: var(--dsw-alias-label-secondary, #5a6072); font-size: 12px; }
.syb-card input { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 7px; font: inherit;
  border: 1px solid var(--dsw-alias-border-l2, #d5d8e0); background: var(--dsw-alias-bg-layer-1, #fff); color: inherit; }
.syb-card .syb-row { display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end; }
.syb-btn { padding: 5px 12px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2, #d5d8e0); background: transparent;
  color: var(--dsw-alias-label-secondary, #5a6072); cursor: pointer; font: inherit; }
.syb-btn:hover { color: var(--dsw-alias-label-primary, #1d2027); }
.syb-btn--primary { background: var(--dsw-alias-state-business-primary, #3b6fd4); border-color: transparent; color: var(--dsw-alias-label-on-accent, #fff); }
.syb-down { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 24px;
  background: var(--dsw-alias-bg-layer-1, #fff); z-index: 4; }
.syb-down__box { max-width: 420px; text-align: center; color: var(--dsw-alias-label-secondary, #5a6072); }
.syb-down__title { margin: 0 0 6px; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary, #1d2027); }
.syb-down__tip { margin: 0 0 14px; font-size: 12.5px; line-height: 1.6; }
.syb-down__dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px;
  background: var(--dsw-alias-state-error-primary, #d64545); }
`

    function Styles() {
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const node = document.createElement('style')
        node.id = 'syb-styles'
        node.textContent = CSS
        document.head.appendChild(node)
        return () => { node.remove() }
      }, [])
      return null
    }

    function GearIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('circle', { cx: 12, cy: 12, r: 3 }),
        h('path', { d: 'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.11a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 3 15.1a1.7 1.7 0 0 0-1.56-1H1.3a2 2 0 1 1 0-4h.11a1.7 1.7 0 0 0 1.56-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 7.33 4a1.7 1.7 0 0 0 1-1.56V2.3a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 20 8.33v.11a1.7 1.7 0 0 0 1.56 1h.11a2 2 0 1 1 0 4h-.11a1.7 1.7 0 0 0-1.56 1Z' }))
    }

    function RefreshIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
        h('path', { d: 'M21 3v6h-6' }))
    }

    function ImportIcon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M12 3v10' }),
        h('path', { d: 'm8 9 4 4 4-4' }),
        h('path', { d: 'M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3' }))
    }

    function ExternalIcon({ size = 16 }) {      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M14 4h6v6' }),
        h('path', { d: 'M20 4 10.5 13.5' }),
        h('path', { d: 'M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5' }))
    }

    /** The bridge page itself; the panel only frames it and reports reachability. */
    function BridgePage(props) {
      const t = props.t || ((key) => (DICT.zh[key] || key))
      const [url, setUrl] = useState(readUrl)
      const [draft, setDraft] = useState(readUrl)
      const [gen, setGen] = useState(0)
      const [down, setDown] = useState(false)
      const [settings, setSettings] = useState(false)
      const timer = useRef(null)
      const frame = useRef(null)

      // The framed page reports its own kernel health; that is the most precise
      // signal the sidebar dot can get while the panel is open.
      useEffect(() => {
        const onMessage = (event) => {
          const data = event.data
          if (!data || data.type !== 'siyuan-bridge/status') return
          setHealth(data.ok === true ? 'ok' : 'down')
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [])

      useEffect(() => {
        setDraft(url)
      }, [url])

      useEffect(() => {
        let alive = true
        const check = async () => {
          try {
            await fetch(url + 'api/status', { mode: 'no-cors', cache: 'no-store' })
            if (alive) setDown(false)
          } catch {
            if (alive) setDown(true)
          }
        }
        check()
        timer.current = window.setInterval(check, 15000)
        return () => { alive = false; if (timer.current) window.clearInterval(timer.current) }
      }, [url, gen])

      const apply = useCallback((next) => {
        const target = normalizeUrl(next)
        writeUrl(target)
        setUrl(target)
        setSettings(false)
        setGen((n) => n + 1)
      }, [])

      return h('div', { className: 'syb-root' },
        h(Styles),
        h('iframe', {
          key: url,
          ref: frame,
          className: 'syb-frame',
          src: url,
          title: t('panel'),
          allow: 'clipboard-read; clipboard-write',
          referrerPolicy: 'no-referrer',
        }),
        down ? h('div', { className: 'syb-down' },
          h('div', { className: 'syb-down__box' },
            h('p', { className: 'syb-down__title' }, h('span', { className: 'syb-down__dot' }), t('down')),
            h('p', { className: 'syb-down__tip' }, t('downTip')),
            h('div', { className: 'syb-row' },
              h('button', { type: 'button', className: 'syb-btn syb-btn--primary', onClick: () => setGen((n) => n + 1) }, t('retry')),
              h('button', { type: 'button', className: 'syb-btn', onClick: () => window.open(url, '_blank', 'noopener') }, t('open')),
              h('button', { type: 'button', className: 'syb-btn', onClick: () => setSettings((v) => !v) }, t('settings'))))) : null,
        settings ? h('div', { className: 'syb-card', role: 'dialog', 'aria-label': t('settings') },
          h('h4', null, t('settings')),
          h('label', { htmlFor: 'syb-url' }, t('bridgeUrl')),
          h('input', {
            id: 'syb-url', value: draft, spellCheck: false,
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') apply(draft) },
          }),
          h('div', { className: 'syb-row' },
            h('button', { type: 'button', className: 'syb-btn', onClick: () => setSettings(false) }, t('close')),
            h('button', { type: 'button', className: 'syb-btn syb-btn--primary', onClick: () => apply(draft) }, t('save')))) : null,
        h('div', { className: 'syb-pill' },
          h('button', {
            type: 'button', className: 'syb-icon-btn', title: t('import'), 'aria-label': t('import'),
            onClick: () => {
              const f = frame.current
              if (f) f.src = url + '#/import'
            },
          }, h(ImportIcon, null)),
          h('button', { type: 'button', className: 'syb-icon-btn', title: t('refresh'), 'aria-label': t('refresh'), onClick: () => setGen((n) => n + 1) }, h(RefreshIcon, null)),
          h('button', { type: 'button', className: 'syb-icon-btn', title: t('open'), 'aria-label': t('open'), onClick: () => window.open(url, '_blank', 'noopener') }, h(ExternalIcon, null)),
          h('button', { type: 'button', className: 'syb-icon-btn', title: t('settings'), 'aria-label': t('settings'), onClick: () => setSettings((v) => !v) }, h(GearIcon, null))))
    }

    /** Bridge glyph with a health dot: green = kernel reachable, amber = service
     *  answers but the kernel state is unknown, red = nothing answers. */
    function BridgeIcon({ size = 18 }) {
      const state = useHealth()
      const color = state === 'ok' ? '#2fa84f' : state === 'service' ? '#e0a020' : state === 'down' ? '#d64545' : '#9aa0ad'
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M3 18h18' }),
        h('path', { d: 'M5 18c0-4.2 3.1-7.5 7-7.5s7 3.3 7 7.5' }),
        h('path', { d: 'M12 10.5V6' }),
        h('path', { d: 'M9 6h6' }),
        h('circle', { cx: 19, cy: 19, r: 3.4, fill: color, stroke: 'var(--dsw-alias-bg-layer-1, #fff)', strokeWidth: 1.4 }))
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), 'siyuan-bridge: dictionaries')
      const t = ctx.locale.bind(NS)
      startProbe()

      ctx.slots.inject('main', function* () {
        yield ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, BridgePage)
      })

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 40,
        label: () => t('panel'),
        locale: NS,
      }, BridgeIcon))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'siyuan-bridge'
    return module.exports
  },
})
