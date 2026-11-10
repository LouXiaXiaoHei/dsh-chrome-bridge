/**
 * Chrome tab bridge, browser half.
 *
 * Adds a `@` source that lists the tabs open in the user's own Chrome window, so
 * a mention reads like a file mention and hands the model a concrete tab id.
 * `codec.serialize` is where the tab id actually reaches the model: the returned
 * text replaces the atomic mention in the request.
 */
window.__ModuleLoader__.load({
  id: 'dsh-chrome-tab',
  factory: (require) => {
    const module = { exports: {} }

    const LOCALE_NS = 'dsh-chrome-tab'
    const TABS_PATH = '/dsh-chrome-tab/tabs'
    const SELECT_PATH = '/dsh-chrome-tab/select'
    const inject = ['inputTriggers', 'locale']

    const dictionaries = {
      zh: {
        'section.tabs': 'Chrome 标签页',
        'section.none': 'Chrome 标签页',
        'candidate.disconnected': '未连接 Chrome 扩展',
        'candidate.disconnected.description': '在 Chrome 的扩展程序页加载 DSH Chrome 标签页扩展后重试',
        'candidate.stale': '扩展连在旧实例上',
        'candidate.stale.description': '重启 DeepSeek Harness 让扩展改连当前实例',
        'candidate.elsewhere': '扩展被另一个 Harness 窗口占用',
        'candidate.elsewhere.description': '关闭另一个窗口，或到那个窗口里使用',
        'candidate.empty': 'Chrome 里没有可操作的标签页',
        'candidate.empty.description': '打开一个 http 或 https 页面后重试',
        'candidate.notDrivable': '不可操作',
        'candidate.controlled': '当前目标',
        'hint.disconnected': '[Chrome 标签页] 还没有连接。在 Chrome 打开 chrome://extensions，开启"开发者模式"，用"加载已解压的扩展程序"选择 ~/.dsh/chrome-tab-extension 目录，然后回来再试。',
        'hint.stale': '[Chrome 标签页] 扩展已经加载好了，但它连在一个旧实例上（端口 {port}），那个实例已经不工作。重启 DeepSeek Harness 即可；扩展会自动改连当前实例。',
        'hint.elsewhere': '[Chrome 标签页] 扩展正被另一个 DeepSeek Harness 窗口占用（端口 {port}）。关闭那个窗口，或直接到那个窗口里操作。',
        'hint.empty': '[Chrome 标签页] 当前 Chrome 里没有 http 或 https 页面可操作。',
        'serialize': '[Chrome 标签页 {id}] 《{title}》 {url} —— 该标签页已由 chrome_* 工具接手：先用 chrome_snapshot 读取当前内容，再用 chrome_click / chrome_type 等操作它。',
        'serialize.unknown': '[Chrome 标签页 {id}] —— 该标签页已由 chrome_* 工具接手：先用 chrome_tabs 或 chrome_snapshot 确认它的内容。',
      },
      en: {
        'section.tabs': 'Chrome tabs',
        'section.none': 'Chrome tabs',
        'candidate.disconnected': 'Chrome extension not connected',
        'candidate.disconnected.description': 'Load the DSH Chrome Tab extension in chrome://extensions, then try again',
        'candidate.stale': 'Extension is on an older instance',
        'candidate.stale.description': 'Restart DeepSeek Harness so the extension reconnects here',
        'candidate.elsewhere': 'Extension is held by another Harness window',
        'candidate.elsewhere.description': 'Close the other window, or use the extension from that one',
        'candidate.empty': 'No drivable tab in Chrome',
        'candidate.empty.description': 'Open an http or https page, then try again',
        'candidate.notDrivable': 'not drivable',
        'candidate.controlled': 'current target',
        'hint.disconnected': '[Chrome tab] Not connected yet. Open chrome://extensions in Chrome, turn on Developer mode, use "Load unpacked" on ~/.dsh/chrome-tab-extension, then come back and try again.',
        'hint.stale': '[Chrome tab] The extension is loaded, but it is connected to an older instance of this plugin (port {port}) that nothing drives any more. Restart DeepSeek Harness and it will reconnect here by itself.',
        'hint.elsewhere': '[Chrome tab] Another DeepSeek Harness window owns the extension right now (port {port}). Close that window, or use the extension from it.',
        'hint.empty': '[Chrome tab] No http or https page is open in Chrome right now.',
        'serialize': '[Chrome tab {id}] "{title}" {url} — this tab is now the target of the chrome_* tools: call chrome_snapshot to read it, then chrome_click / chrome_type and friends to act on it.',
        'serialize.unknown': '[Chrome tab {id}] — this tab is now the target of the chrome_* tools: call chrome_tabs or chrome_snapshot to see what it holds.',
      },
    }

    let language = 'zh'
    const t = (key, vars) => {
      const table = dictionaries[language] ?? dictionaries.en
      const template = table[key] ?? dictionaries.en[key] ?? key
      if (vars === undefined) return template
      return template.replace(/\{(\w+)\}/gu, (_match, name) => String(vars[name] ?? ''))
    }

    /** Tab facts keyed by id, so a mention can be serialized without a round trip. */
    const known = new Map()

    const shorten = (value, limit) => {
      const text = String(value ?? '').replace(/\s+/gu, ' ').trim()
      return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
    }

    const tabIdOf = (ref) => {
      const match = /(\d+)/u.exec(String(ref ?? ''))
      return match === null ? undefined : Number(match[1])
    }

    const readTabs = async (signal) => {
      try {
        const response = await fetch(`${location.origin}${TABS_PATH}`, {
          signal,
          cache: 'no-store',
          headers: { accept: 'application/json' },
        })
        if (!response.ok) return { connected: false, tabs: [] }
        const body = await response.json()
        const tabs = Array.isArray(body?.tabs) ? body.tabs : []
        for (const tab of tabs) {
          if (typeof tab?.id !== 'number') continue
          known.set(tab.id, { id: tab.id, title: tab.title ?? '', url: tab.url ?? '' })
        }
        return {
          connected: body?.connected === true,
          tabs,
          currentTabId: body?.currentTabId,
          // Forward the host's diagnosis so the menu can name the real cause.
          reason: body?.reason,
        }
      } catch {
        // A closed menu or an offline host must not surface as an error row.
        return { connected: false, tabs: [] }
      }
    }

    const remember = (tabId) => {
      void fetch(`${location.origin}${SELECT_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tabId }),
      }).catch(() => {})
    }

    const source = {
      trigger: '@',
      name: 'chrome-tab',
      order: 20,
      showGroupTitle: true,

      async candidates(_session, { query, signal }) {
        const listing = await readTabs(signal)
        const section = t('section.tabs')
        if (listing.connected !== true) {
          // The host names the cause; "load the extension" is only right when it
          // truly is not loaded, and saying it otherwise sends users in circles.
          const kind = listing.reason?.kind === 'stale' || listing.reason?.kind === 'elsewhere'
            ? listing.reason.kind
            : 'disconnected'
          return [{
            name: t(`candidate.${kind}`),
            description: t(`candidate.${kind}.description`),
            icon: 'session',
            section: t('section.none'),
            value: JSON.stringify({ hint: kind, port: listing.reason?.port }),
          }]
        }
        const needle = String(query ?? '').trim().toLowerCase()
        const matched = listing.tabs.filter((tab) => {
          if (tab?.injectable === false) return false
          if (needle === '') return true
          return `${tab.title ?? ''} ${tab.url ?? ''}`.toLowerCase().includes(needle)
        })
        if (matched.length === 0) {
          return [{
            name: t('candidate.empty'),
            description: t('candidate.empty.description'),
            icon: 'session',
            section: t('section.none'),
            value: JSON.stringify({ hint: 'empty' }),
          }]
        }
        return matched.map((tab) => {
          const marks = []
          if (tab.id === listing.currentTabId) marks.push(t('candidate.controlled'))
          if (tab.active === true) marks.push('active')
          const suffix = marks.length === 0 ? '' : ` · ${marks.join(' · ')}`
          return {
            name: shorten(tab.title || tab.url || `Tab ${tab.id}`, 90),
            description: `${shorten(tab.url, 110)}${suffix}`,
            icon: 'session',
            section,
            value: JSON.stringify({ tabId: tab.id, title: tab.title ?? '', url: tab.url ?? '' }),
          }
        })
      },

      onPick({ candidate }) {
        let payload
        try {
          payload = JSON.parse(String(candidate?.value ?? ''))
        } catch {
          return { text: '' }
        }
        if (payload?.hint === 'disconnected') return { text: t('hint.disconnected') }
        if (payload?.hint === 'stale') return { text: t('hint.stale', { port: payload.port }) }
        if (payload?.hint === 'elsewhere') return { text: t('hint.elsewhere', { port: payload.port }) }
        if (payload?.hint === 'empty') return { text: t('hint.empty') }
        const tabId = Number(payload?.tabId)
        if (!Number.isFinite(tabId)) return { text: '' }
        known.set(tabId, { id: tabId, title: payload.title ?? '', url: payload.url ?? '' })
        remember(tabId)
        return {
          insert: {
            source: 'chrome-tab',
            ref: `chrome-tab:${tabId}`,
            label: shorten(payload.title || payload.url || `Tab ${tabId}`, 60),
            appearance: 'session',
            clipboardText: payload.url || `chrome-tab:${tabId}`,
          },
        }
      },

      codec: {
        clipboardText: (ref) => {
          const tab = known.get(tabIdOf(ref))
          return tab?.url || String(ref ?? '')
        },
        async serialize(ref) {
          const tabId = tabIdOf(ref)
          if (tabId === undefined) return String(ref ?? '')
          let tab = known.get(tabId)
          if (tab === undefined) {
            const listing = await readTabs()
            tab = known.get(tabId)
            if (tab === undefined && listing.tabs.length === 0) {
              return t('serialize.unknown', { id: tabId })
            }
          }
          if (tab === undefined) return t('serialize.unknown', { id: tabId })
          return t('serialize', { id: tabId, title: tab.title || '(untitled)', url: tab.url })
        },
      },
    }

    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(LOCALE_NS, dictionaries),
        'chrome-tab: locale dictionaries',
      )
      try {
        language = String(ctx.locale.getLocale?.() ?? 'zh').startsWith('zh') ? 'zh' : 'en'
      } catch {
        language = 'zh'
      }
      ctx.effect(() => {
        if (typeof ctx.locale.subscribe !== 'function') return () => {}
        return ctx.locale.subscribe(() => {
          try {
            language = String(ctx.locale.getLocale?.() ?? 'zh').startsWith('zh') ? 'zh' : 'en'
          } catch {
            language = 'zh'
          }
        })
      }, 'chrome-tab: locale tracking')

      const inputTriggers = typeof ctx.get === 'function' ? ctx.get('inputTriggers') : undefined
      if (inputTriggers === undefined || typeof inputTriggers.registerSource !== 'function') {
        ctx.logger?.warn?.('chrome-tab: inputTriggers is unavailable; the @ menu cannot list Chrome tabs')
        return
      }
      ctx.effect(() => inputTriggers.registerSource(source), 'chrome-tab: @ source')
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
