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
    const STATUS_PATH = '/dsh-chrome-tab/status'
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

    // 桌面版的页面跑在 dsh-app://app 上：origin 是字符串 "null"，host 是 "app"，
    // 拿它们拼地址一律不可解析。相对路径反而正确——主进程会把 dsh-app://app
    // 上除静态资源以外的请求原样转发给宿主 http 服务。
    const readTabs = async (signal) => {
      try {
        const response = await fetch(TABS_PATH, {
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

    // 每个客户端会话只自动带出小窗一次：用户关掉之后，模型换标签别再把它弹回来。
    let previewAutoOpened = false
    // 上一次看到的宿主目标标签页。
    let lastTargetTab

    /**
     * 选中一个标签页就等于开始用浏览器，顺手把小窗带出来，画面马上就在。
     *
     * force 只给人用：用户自己点了标签页，哪怕刚才关过窗口，也该再弹一次；
     * 轮询发现的目标变化不带 force，关掉就安静着。
     */
    const openPreview = (force) => {
      if (previewAutoOpened && force !== true) return true
      if (!showFloat()) return false
      previewAutoOpened = true
      return true
    }

    const remember = (tabId) => {
      void fetch(SELECT_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tabId }),
      }).catch(() => {})
      openPreview(true)
    }

    /**
     * 宿主的目标标签页换人，面板就该出现：`@` 选中、`chrome_open` 新开、或者模型自己
     * 切了一个页。只认宿主说的目标，不猜；第一次连上时也开——那时目标已经在那儿了，
     * 用户点开侧栏只会看到一个空骨架。
     */
    const watchTarget = () => {
      void fetch(STATUS_PATH, { cache: 'no-store', headers: { accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : undefined))
        .then((body) => {
          const tabId = Number(body?.currentTabId)
          if (!Number.isFinite(tabId) || tabId <= 0) return
          if (tabId === lastTargetTab) return
          lastTargetTab = tabId
          // 宿主已经有了目标标签页，说明上一次就在用浏览器：把画面接上，别让它空等。
          // 没打开就不算看过：清掉记录，让下一轮轮询再试一次。
          if (!openPreview()) lastTargetTab = undefined
        })
        .catch(() => {})
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

    // -------------------------------------------------------------- 预览面板
    // 画面来自本机回环上的推送通道，和模型看到的东西互不相干：这里丢一帧，
    // 模型那边少不了一次调用；这里关掉，agent 照常点。
    const PREVIEW_PATH = '/dsh-chrome-tab/preview'
    const CONTROL_PATH = '/dsh-chrome-tab/control'
    const FOCUS_PATH = '/dsh-chrome-tab/focus'
    const PREVIEW_TAB_ID = 'dsh-chrome-tab/browser-preview'
    const PREVIEW_TAB_KIND = 'chrome-tab-preview'

    let React
    try {
      React = require('react')
    } catch {
      React = undefined
    }

    const previewCopy = {
      zh: {
        tab: '浏览器',
        guide: '浏览器预览',
        guideDescription: '实时看模型操作 Chrome',
        waiting: '等待页面',
        offline: '扩展没有连上宿主',
        paused: '预览已暂停',
        live: '实时',
        empty: '还没有画面。\n在对话里用 @ 选一个 Chrome 标签页，模型一动手这里就会亮。',
        'empty.background': '这个标签页在 Chrome 后台，Chrome 不渲染它，所以这里收不到画面。\n点上面的「切到 Chrome」，或者自己在 Chrome 里点一下这个标签。',
        'empty.first': '通道连上了，正在等第一帧。\n这个标签页得是 Chrome 当前显示的那一个。',
        focus: '切到 Chrome',
        hint: '画面只给人看，不进模型上下文；模型要看页面时仍会自己截图。',
        'hint.float': '画面只给你看，不进模型上下文',
        frozen: '停在最后一帧',
        'hint.frozen': '停在最后一帧 · AI 一动手就刷新',
        refresh: '刷新画面',
        'control.pause': '暂停接管',
        'control.resume': '继续 AI',
        'control.userHint': '已暂停 AI：请直接在 Chrome 窗口里操作，完成后点「继续 AI」，模型会重新读一遍页面。',
        'control.you': '你在操作',
        'tab.background': '这个标签页在 Chrome 后台：切到它，小窗才会继续更新。',
        'error.connect': '连不上预览通道',
        'error.handshake': '预览通道握手失败',
        'error.timeout': '4 秒没等到预览通道回应',
        'error.page': '取不到预览页面',
        'float.close': '关闭小窗',
        channel: '画面通道',
      },
      en: {
        tab: 'Browser',
        guide: 'Browser preview',
        guideDescription: 'Watch the model drive Chrome',
        waiting: 'Waiting for a page',
        offline: 'The extension is not connected',
        paused: 'Preview paused',
        live: 'live',
        empty: 'Nothing yet.\nMention a Chrome tab with @; the panel lights up as soon as the model acts.',
        'empty.background': 'Chrome is not rendering this tab because it sits in the background, so no frames arrive.\nPress "Switch to Chrome", or click the tab yourself.',
        'empty.first': 'Connected, waiting for the first frame.\nThe tab has to be the one Chrome is currently showing.',
        focus: 'Switch to Chrome',
        hint: 'The picture is for you only; it never enters the model context. The model still takes its own screenshots.',
        'hint.float': 'For your eyes only; never in the model context',
        frozen: 'last frame',
        'hint.frozen': 'Frozen on the last frame · it refreshes as soon as the AI acts',
        refresh: 'Refresh the picture',
        'control.pause': 'Take over',
        'control.resume': 'Hand back to AI',
        'control.userHint': 'The AI is paused: drive Chrome yourself, then press "Hand back to AI" so it re-reads the page.',
        'control.you': 'you are driving',
        'tab.background': 'This tab is in the background: switch to it and the preview keeps updating.',
        'error.connect': 'Cannot reach the preview channel',
        'error.handshake': 'Preview channel handshake failed',
        'error.timeout': 'No answer from the preview channel in four seconds',
        'error.page': 'Cannot load the preview page',
        'float.close': 'Close preview',
        channel: 'Preview channel',
      },
    }
    const copy = (key) => (previewCopy[language] ?? previewCopy.zh)[key] ?? key

    const PANEL_STYLE = { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: '#15171b', color: '#e5e7eb' }
    const BAR_STYLE = { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderBottom: '1px solid #262a31', flex: 'none', fontSize: 12 }
    const DOT_STYLE = { width: 8, height: 8, borderRadius: '50%', flex: 'none' }
    const TITLE_STYLE = { fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '45%' }
    const URL_STYLE = { color: '#8b93a1', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }
    const META_STYLE = { color: '#6b7280', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }
    const STAGE_STYLE = { position: 'relative', flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 10, minHeight: 0, background: '#0f1115' }
    const CANVAS_STYLE = { maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', background: '#fff', borderRadius: 6, boxShadow: '0 10px 30px rgba(0, 0, 0, .45)' }
    const OVERLAY_STYLE = { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', textAlign: 'center', padding: 24, whiteSpace: 'pre-wrap', pointerEvents: 'none', fontSize: 12 }
    const FOOT_STYLE = { flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderTop: '1px solid #262a31', color: '#6b7280', fontSize: 11 }
    const FOOT_TEXT_STYLE = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    const BUTTON_STYLE = { flex: 'none', padding: '3px 9px', borderRadius: 6, border: '1px solid #3a3f47', background: 'transparent', color: '#d1d5db', font: 'inherit', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' }
    const BUTTON_MINE_STYLE = { ...BUTTON_STYLE, borderColor: '#3f6b52', background: '#1b2b22', color: '#a7f3d0' }

    const INITIAL_VIEW = {
      status: 'connecting',
      title: '',
      url: '',
      error: '',
      streaming: false,
      // 按需录：没人操作时流是停的，画面冻在最后一帧。这不等于「坏了」。
      paused: false,
      fps: 0,
      size: '',
      // 画面的高宽比。小窗按它定高度，画面和窗体之间就不会留黑边。
      ratio: 0.625,
      owner: 'agent',
      hasFrame: false,
      active: true,
      endpoint: '',
      tabId: 0,
    }

    // 一个 canvas 一个 2D 上下文。改画布尺寸会把它清掉，所以尺寸变了就一起丢。
    const contexts = new WeakMap()
    const drawBitmap = (canvas, bitmap) => {
      if (canvas === null || canvas === undefined) return
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        contexts.delete(canvas)
      }
      let context = contexts.get(canvas)
      if (context === undefined) {
        context = canvas.getContext('2d')
        if (context === null) return
        contexts.set(canvas, context)
      }
      context.drawImage(bitmap, 0, 0)
      bitmap.close?.()
    }

    /**
     * 预览通道的客户端：文本消息改状态，二进制消息交给 onFrame 画。
     *
     * 面板（React 那一套）和悬浮窗（原生 DOM）共用这一份——两边对「什么算新状态」
     * 的理解必须一致，否则同一个画面在两个壳里表现不一样。断线重连也在这里，
     * 壳子只负责显示。
     */
    function createPreviewStream({ onChange, onFrame }) {
      let view = { ...INITIAL_VIEW }
      let disposed = false
      let socket
      let retry
      let ticker
      let frames = 0

      const push = (next) => {
        view = next
        onChange(view)
      }
      // 传函数就按「基于当前状态算下一个」处理，和 setState 的用法一致。
      const update = (patch) => push(typeof patch === 'function' ? patch(view) : { ...view, ...patch })

      // 面板和悬浮窗各自重连，互相不打断：宿主的 screencast 是按标签页算的。
      let opened = false
      const explain = (text) => update({ status: 'error', error: text })

      const discover = async () => {
        // 桌面版页面来自 dsh-app://app，location.origin 是 "null"：只能走相对路径，
        // 主进程会给这种同源请求补上放行头。地址本身问宿主，别猜。
        const response = await fetch(STATUS_PATH, { cache: 'no-store' })
        if (!response.ok) throw new Error('status ' + response.status)
        const info = await response.json()
        const advertised = typeof info?.preview?.wsUrl === 'string' ? info.preview.wsUrl : ''
        if (advertised !== '') return advertised
        const hosted = location.protocol === 'http:' || location.protocol === 'https:'
        if (!hosted) throw new Error('no preview socket advertised')
        return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + PREVIEW_PATH
      }

      const connect = async () => {
        if (disposed) return
        let endpoint
        try {
          endpoint = await discover()
        } catch (error) {
          if (disposed) return
          explain(copy('error.connect') + ' ' + String(error?.message ?? error))
          retry = setTimeout(connect, 1500)
          return
        }
        if (disposed) return
        update({ endpoint })
        const fail = setTimeout(() => {
          if (disposed || opened) return
          explain(copy('error.timeout'))
        }, 4000)
        try {
          socket = new WebSocket(endpoint)
        } catch {
          clearTimeout(fail)
          explain(copy('error.handshake'))
          retry = setTimeout(connect, 1500)
          return
        }
        // 二进制帧直接给 createImageBitmap 用：它只认 Blob，不认裸 ArrayBuffer。
        socket.binaryType = 'blob'
        socket.onopen = () => {
          opened = true
          clearTimeout(fail)
          update({ status: 'connecting', error: '' })
        }
        socket.onmessage = (event) => {
          if (disposed) return
          if (typeof event.data === 'string') {
            let message
            try {
              message = JSON.parse(event.data)
            } catch {
              return
            }
            if (message?.type === 'hello') {
              const control = message.control ?? {}
              update({
                // 扩展没连上时画面永远不来，别让它看起来只是慢。
                status: message.connected === false ? 'offline' : 'live',
                streaming: message.streaming === true,
                owner: control.owner === 'user' ? 'user' : 'agent',
              })
            } else if (message?.type === 'control') {
              update({ owner: message.owner === 'user' ? 'user' : 'agent' })
            } else if (message?.type === 'stream') {
              const running = message.running === true
              update({
                streaming: running,
                // 停流有两种：只是等着（idle，正常），和出错了。
                paused: running === false && message.error === undefined && message.reason === 'idle',
                error: running ? '' : String(message.error ?? ''),
                status: running ? 'live' : view.status === 'error' ? 'error' : 'idle',
              })
            } else if (message?.type === 'tab') {
              update({
                title: String(message.title ?? ''),
                url: String(message.url ?? ''),
                active: message.active !== false,
                tabId: Number(message.tabId) > 0 ? Number(message.tabId) : view.tabId,
              })
            } else if (message?.type === 'meta') {
              const width = Number(message.deviceWidth)
              const height = Number(message.deviceHeight)
              update({
                size: String(message.deviceWidth ?? '?') + '×' + String(message.deviceHeight ?? '?'),
                // 页面尺寸就是窗体的形状：宽高比算出来，小窗自己贴上去。
                ratio: width > 0 && height > 0 ? height / width : view.ratio,
              })
            }
            return
          }
          frames += 1
          void (async () => {
            try {
              onFrame(await createImageBitmap(event.data))
              // 有一帧就足够了：切标签页时画面会短暂停住，别把最后一帧盖掉。
              if (!view.hasFrame) update({ hasFrame: true })
            } catch {
              // 坏帧丢掉，下一帧补上。
            }
          })()
        }
        socket.onclose = (event) => {
          if (disposed) return
          clearTimeout(fail)
          // 握手就没成就别退回「等待页面」：原因留着，下一轮接上了再清。
          if (opened) update({ status: 'connecting' })
          else explain(copy('error.handshake') + ' (code ' + String(event?.code ?? 0) + ')')
          retry = setTimeout(connect, 1500)
        }
      }

      return {
        get view() {
          return view
        },
        start() {
          disposed = false
          opened = false
          // 升级失败也可能是「根本到不了宿主」：先摸一次普通 HTTP，把两种情况分开。
          void fetch(PREVIEW_PATH, { cache: 'no-store' })
            .then((response) => {
              if (disposed || response.ok) return
              update({ status: 'error', error: copy('error.page') + ' ' + response.status })
            })
            .catch(() => {
              if (disposed) return
              update({ status: 'error', error: copy('error.page') + ' ' + PREVIEW_PATH })
            })
          ticker = setInterval(() => {
            update((current) => (current.fps === frames ? current : { ...current, fps: frames }))
            frames = 0
          }, 1000)
          void connect()
        },
        stop() {
          disposed = true
          clearTimeout(retry)
          clearInterval(ticker)
          try {
            socket?.close()
          } catch {
            // 已经关了。
          }
          socket = undefined
        },
        // 换手只改一个开关：AI 那边下一次工具调用就会被拒绝，人这边的输入在
        // Chrome 窗口里本来就通。乐观更新，失败再翻回来。
        switchOwner() {
          const next = view.owner === 'user' ? 'agent' : 'user'
          update({ owner: next })
          void fetch(CONTROL_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ owner: next }),
          })
            .then((response) => response.json())
            .then((state) => update({ owner: state?.owner === 'user' ? 'user' : 'agent' }))
            .catch(() => update({ owner: next === 'user' ? 'agent' : 'user' }))
        },
        // 想看一眼此刻的页面：让宿主临时开一下流，拍到一帧就停。
        refresh() {
          try {
            socket?.send(JSON.stringify({ type: 'refresh' }))
          } catch {
            // 通道没连上，下一次操作自然会刷新。
          }
        },
        // 后台标签页 Chrome 不合成画面。这里只把它换到前台，不碰页面内容。
        focusTab() {
          void fetch(FOCUS_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tabId: view.tabId > 0 ? view.tabId : undefined }),
          }).catch(() => {
            // 扩展没连上时什么都不做：用户自己点一下 Chrome 里那个标签也一样。
          })
        },
      }
    }

    /** React 壳：状态进 useState，画面画进 canvasRef。 */
    function usePreviewStream() {
      const [view, setView] = React.useState(INITIAL_VIEW)
      const canvasRef = React.useRef(null)
      const streamRef = React.useRef(null)

      React.useEffect(() => {
        const stream = createPreviewStream({
          onChange: (next) => setView(next),
          onFrame: (bitmap) => drawBitmap(canvasRef.current, bitmap),
        })
        streamRef.current = stream
        stream.start()
        return () => {
          stream.stop()
          streamRef.current = null
        }
      }, [])

      return {
        view,
        canvasRef,
        switchOwner: () => streamRef.current?.switchOwner(),
        focusTab: () => streamRef.current?.focusTab(),
        refresh: () => streamRef.current?.refresh(),
      }
    }

    const FLOAT_ID = 'dsh-chrome-tab-float'
    const FLOAT_BUTTON = {
      appearance: 'none',
      border: '1px solid rgba(255, 255, 255, .16)',
      background: 'rgba(255, 255, 255, .08)',
      color: '#e5e7eb',
      borderRadius: '6px',
      padding: '1px 7px',
      font: 'inherit',
      fontSize: '11px',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }
    const FLOAT_BUTTON_MINE = { ...FLOAT_BUTTON, borderColor: 'rgba(134, 239, 172, .45)', background: 'rgba(34, 197, 94, .18)', color: '#bbf7d0' }
    // 悬浮窗只有一个：HMR 会再跑一遍 apply，捡回已经挂着的那个，别叠第二个。
    let floatWindow

    /** 建元素顺便把样式写进去。悬浮窗这一堆零碎用 React 写反而更绕。 */
    const styleNode = (tag, style, text) => {
      const node = document.createElement(tag)
      Object.assign(node.style, style)
      if (text !== undefined) node.textContent = text
      return node
    }

    /**
     * 右侧悬浮小窗：盖在对话上，不推挤布局，也不占侧栏。
     *
     * 用原生 DOM 而不是 React —— 它要能被「模型开始操作时自己弹出来」驱动，而客户端
     * 插件的 React 树在别处，硬插进去只会和别人的渲染节奏打架。关掉只是隐藏，
     * 数据流也跟着停：没人看的时候不该继续收帧。
     */
    function mountFloat() {
      if (typeof document === 'undefined' || !document.body) return undefined
      const existing = document.getElementById(FLOAT_ID)
      if (existing !== null) {
        // 热重载会再跑一遍 apply：DOM 里那个还是活的（它的 socket 属于上一个模块
        // 实例），沿用它就行，别再叠第二个窗口。
        if (floatWindow === undefined) {
          floatWindow = {
            root: existing,
            show: () => {
              existing.style.display = 'block'
              return true
            },
            hide: () => {
              existing.style.display = 'none'
            },
            stream: undefined,
            refresh: () => {},
          }
        }
        return floatWindow
      }

      const root = styleNode('div', {
        position: 'fixed',
        right: '18px',
        top: '84px',
        width: 'min(420px, calc(100vw - 36px))',
        height: '262px',
        display: 'none',
        // 高度由 JS 按画面比例算：只让宽度可拖，画面永远不会被塞进一个更大的框里。
        minWidth: '240px',
        overflow: 'hidden',
        resize: 'horizontal',
        borderRadius: '12px',
        background: '#0b0d10',
        color: '#e5e7eb',
        border: '1px solid rgba(255, 255, 255, .09)',
        boxShadow: '0 18px 48px rgba(0, 0, 0, .42)',
        zIndex: '2147483000',
        font: '12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      })
      root.id = FLOAT_ID

      const dot = styleNode('span', { flex: 'none', width: '8px', height: '8px', borderRadius: '50%', background: '#8b93a1', boxShadow: '0 0 0 1px rgba(0, 0, 0, .35)' })
      // 没有背板也要读得清：白字压在浅色页面上，全靠这点影子托住。
      const title = styleNode('span', {
        flex: 'none',
        maxWidth: '52%',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontWeight: '600',
        textShadow: '0 1px 3px rgba(0, 0, 0, .75)',
      })
      const url = styleNode('span', { flex: '1 1 auto', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#8b93a1', fontSize: '11px' })
      const meta = styleNode('span', { flex: 'none', color: 'rgba(226, 232, 240, .62)', fontSize: '11px' })
      const focus = styleNode('button', { ...FLOAT_BUTTON, display: 'none' }, copy('focus'))
      focus.type = 'button'
      const owner = styleNode('button', FLOAT_BUTTON, copy('control.pause'))
      owner.type = 'button'
      const close = styleNode('button', {
        ...FLOAT_BUTTON,
        // 收起是唯一常驻的按钮：它得在亮画面上也看得见，所以给自己留一点底。
        background: 'rgba(0, 0, 0, .42)',
        borderColor: 'rgba(255, 255, 255, .18)',
        padding: '1px 6px',
        fontSize: '13px',
        lineHeight: '15px',
      }, '×')
      close.type = 'button'
      close.title = copy('float.close')
      close.setAttribute('aria-label', copy('float.close'))

      // 控制条浮在画面上，不再单独占一条黑带：不碰它的时候只是一道暗角，
      // 标题和 × 勉强可见；鼠标进来才铺背景、把 URL 和按钮交出来。
      const topbar = styleNode('div', {
        position: 'absolute',
        top: '8px',
        left: '8px',
        right: '8px',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '3px 4px 3px 8px',
        borderRadius: '8px',
        background: 'linear-gradient(to bottom, rgba(0, 0, 0, .42), rgba(0, 0, 0, 0))',
        border: '1px solid transparent',
        cursor: 'move',
        userSelect: 'none',
        transition: 'background .16s ease, border-color .16s ease',
      })
      // 停着的时候想看一眼此刻的页面：拍一张就走，不会因此一直录下去。
      const refresh = styleNode('button', { ...FLOAT_BUTTON, flex: 'none' }, '↻')
      refresh.type = 'button'
      refresh.title = copy('refresh')
      refresh.setAttribute('aria-label', copy('refresh'))
      topbar.append(dot, title, url, meta, focus, owner, refresh, close)

      // 这些只在有人碰窗口时才出现。接管中例外：那时候得让人一眼找到「继续 AI」。
      const extras = [url, meta, focus, owner, refresh]
      for (const node of extras) {
        node.style.opacity = '0'
        node.style.pointerEvents = 'none'
        node.style.transition = 'opacity .16s ease'
      }
      let barOpen = false
      const layBar = (open) => {
        barOpen = open
        topbar.style.background = open
          ? 'rgba(12, 14, 19, .66)'
          : 'linear-gradient(to bottom, rgba(0, 0, 0, .42), rgba(0, 0, 0, 0))'
        topbar.style.borderColor = open ? 'rgba(255, 255, 255, .1)' : 'transparent'
        topbar.style.backdropFilter = open ? 'blur(10px)' : 'none'
        topbar.style.WebkitBackdropFilter = open ? 'blur(10px)' : 'none'
        for (const node of extras) {
          node.style.opacity = open ? '1' : '0'
          node.style.pointerEvents = open ? 'auto' : 'none'
        }
      }

      // 画面铺满整块窗体：没有留白，也就没有黑边。指针事件留给上层控件。
      const canvas = styleNode('canvas', { display: 'block', width: '100%', height: '100%', pointerEvents: 'none' })
      canvas.width = 1280
      canvas.height = 800
      const overlay = styleNode('div', {
        position: 'absolute',
        inset: '0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '26px 22px',
        textAlign: 'center',
        color: '#8b93a1',
        background: '#0b0d10',
      })
      // 画面自己就是窗体的全部，没有留白也没有描边。
      const stage = styleNode('div', { position: 'absolute', inset: '0' })
      stage.append(canvas, overlay)

      // 底部一句话只在有话可说时出现（接管、后台、冻结、出错）。
      const hint = styleNode('div', {
        position: 'absolute',
        left: '0',
        right: '0',
        bottom: '0',
        display: 'none',
        alignItems: 'center',
        padding: '20px 10px 6px',
        background: 'linear-gradient(to bottom, rgba(0, 0, 0, 0), rgba(0, 0, 0, .66))',
        color: '#e2e8f0',
        fontSize: '11px',
        pointerEvents: 'none',
        opacity: '.85',
        transition: 'opacity .16s ease',
      })
      const footText = styleNode('span', {
        flex: '1 1 auto',
        minWidth: '0',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      })
      hint.append(footText)

      root.append(stage, topbar, hint)

      const render = (view) => {
        // 这两处文字只在建窗时算过一次的话，换语言就停在旧语言上了。
        close.title = copy('float.close')
        close.setAttribute('aria-label', copy('float.close'))
        refresh.title = copy('refresh')
        refresh.setAttribute('aria-label', copy('refresh'))
        const live = view.streaming === true && view.fps > 0
        dot.style.background = view.owner === 'user'
          ? '#60a5fa'
          : live
            ? '#34d399'
            : view.status === 'offline' || view.status === 'error'
              ? '#fbbf24'
              : '#8b93a1'
        title.textContent = view.title === '' ? copy('waiting') : view.title
        url.textContent = view.url
        meta.textContent = view.owner === 'user'
          ? copy('control.you')
          : live
            ? view.size === '' ? copy('live') : view.size
            : view.status === 'connecting'
              ? copy('waiting')
              : view.paused && view.hasFrame ? copy('frozen') : copy('paused')
        // 后台标签页 Chrome 根本不合成画面，与其干等，不如直接给个把它换到前台的办法。
        focus.style.display = view.active === false ? '' : 'none'
        owner.textContent = view.owner === 'user' ? copy('control.resume') : copy('control.pause')
        Object.assign(owner.style, view.owner === 'user' ? FLOAT_BUTTON_MINE : FLOAT_BUTTON)
        overlay.style.display = view.hasFrame && view.error === '' ? 'none' : 'flex'
        // 黑屏有好几种原因，分开说，别让人以为坏了。
        overlay.textContent = view.error !== ''
          ? view.error
          : view.active === false
            ? copy('empty.background')
            : view.streaming
              ? copy('empty.first')
              : copy('empty')
        // 底部只在有话要说时出现：正常播放时不该有东西压在画面下沿。
        const note = view.owner === 'user'
          ? copy('control.userHint')
          : view.error !== ''
            ? view.error
            : view.active === false
              ? copy('tab.background')
              : view.hasFrame
                ? view.paused ? copy('hint.frozen') : ''
                : copy('channel') + ' ' + (view.endpoint === '' ? '—' : view.endpoint)
        footText.textContent = note
        hint.style.display = note === '' ? 'none' : 'flex'
        // 用户接管时按钮必须露着：画面停着，总得有个地方点回来。
        layBar(barOpen || view.owner === 'user')
        fit()
      }

      // 窗体高度跟着画面比例走。宽度是用户拖出来的，高度就不是自由的：
      // 自由的唯一后果是画面缩在一个更大的黑框里。
      const latestRatio = () => {
        const ratio = Number(latest?.ratio)
        return Number.isFinite(ratio) && ratio > 0.2 && ratio < 5 ? ratio : 0.625
      }
      let fittedWidth = 0
      const fit = () => {
        const width = root.clientWidth
        if (width <= 0) return
        fittedWidth = width
        root.style.height = Math.round(width * latestRatio()) + 'px'
      }

      // 建流放在 render 之后：流一起来就可能推 view，那时渲染函数得已经就位。
      let latest = INITIAL_VIEW
      const stream = createPreviewStream({
        onChange: (view) => {
          latest = view
          render(view)
        },
        onFrame: (bitmap) => drawBitmap(canvas, bitmap),
      })

      let started = false
      const show = () => {
        root.style.display = 'block'
        // 显示之后才有宽度可量，比例也才是真的。
        fit()
        if (!started) {
          started = true
          stream.start()
        }
        return true
      }
      const hide = () => {
        root.style.display = 'none'
        if (started) {
          started = false
          stream.stop()
        }
      }

      close.addEventListener('click', () => hide())
      owner.addEventListener('click', () => stream.switchOwner())
      focus.addEventListener('click', () => stream.focusTab())
      refresh.addEventListener('click', () => stream.refresh())

      // 拖控制条挪位置。改的是 left/top，因为 right 一旦保留就会把窗口拽回去。
      let drag
      topbar.addEventListener('pointerdown', (event) => {
        if (event.target instanceof Element && event.target.closest('button') !== null) return
        const rect = root.getBoundingClientRect()
        drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top }
        topbar.setPointerCapture?.(event.pointerId)
      })
      topbar.addEventListener('pointermove', (event) => {
        if (drag === undefined) return
        root.style.right = 'auto'
        root.style.left = Math.max(8, drag.left + event.clientX - drag.x) + 'px'
        root.style.top = Math.max(8, drag.top + event.clientY - drag.y) + 'px'
      })
      const endDrag = () => {
        drag = undefined
      }
      topbar.addEventListener('pointerup', endDrag)
      topbar.addEventListener('pointercancel', endDrag)

      // 鼠标不在时控件退场：窗口里剩下的就是那张画面。
      root.addEventListener('pointerenter', () => {
        hint.style.opacity = '1'
        layBar(true)
      })
      root.addEventListener('pointerleave', () => {
        hint.style.opacity = '.85'
        layBar(latest?.owner === 'user')
      })

      // CSS 的横向 resize 只改宽度；高度必须跟着宽度重算，否则就是一条黑边。
      if (typeof ResizeObserver === 'function') {
        const observer = new ResizeObserver(() => {
          if (Math.abs(root.clientWidth - fittedWidth) < 1) return
          fit()
        })
        observer.observe(root)
      }

      document.body.append(root)
      floatWindow = { root, show, hide, stream, refresh: () => render(latest) }
      return floatWindow
    }

    /** 把小窗亮出来。没有界面时返回 false，调用方自己决定怎么办。 */
    function showFloat() {
      const win = floatWindow ?? mountFloat()
      if (win === undefined) return false
      win.show()
      return true
    }

    function BrowserPreviewBody(props) {
      const { view, canvasRef, switchOwner, focusTab, refresh } = usePreviewStream()
      // 页面还没出帧时，用宿主记住的标签页补一句，用户至少知道在等什么。
      let tab
      try {
        tab = typeof props?.useTabInfo === 'function' ? props.useTabInfo().tab : undefined
      } catch {
        // 标签页记录还没提交时 hook 会抛；画面照旧，只是少一个标记。
        tab = undefined
      }
      const live = view.streaming === true && view.fps > 0
      const status = () => {
        if (view.status === 'offline') return copy('offline')
        if (view.status === 'error' && view.error !== '') return view.error
        if (live) return view.size === '' ? copy('live') : view.size
        if (view.status === 'connecting') return copy('waiting')
        // 停在最后一帧是按需录屏的正常状态，不该说成「已暂停」。
        if (view.paused && view.hasFrame) return copy('frozen')
        return copy('paused')
      }
      return React.createElement('div', { style: PANEL_STYLE, 'data-tab': tab?.id },
        React.createElement('div', { style: BAR_STYLE },
          React.createElement('span', { style: { ...DOT_STYLE, background: view.owner === 'user' ? '#60a5fa' : live ? '#34d399' : view.status === 'offline' || view.status === 'error' ? '#fbbf24' : '#8b93a1' } }),
          React.createElement('span', { style: TITLE_STYLE }, view.title === '' ? copy('waiting') : view.title),
          React.createElement('span', { style: URL_STYLE }, view.url),
          React.createElement('span', { style: META_STYLE }, view.owner === 'user' ? copy('control.you') : status()),
          view.active === false
            ? React.createElement('button', { type: 'button', onClick: focusTab, style: BUTTON_STYLE }, copy('focus'))
            : null,
          React.createElement('button', {
            type: 'button',
            onClick: switchOwner,
            style: view.owner === 'user' ? BUTTON_MINE_STYLE : BUTTON_STYLE,
          }, view.owner === 'user' ? copy('control.resume') : copy('control.pause')),
        ),
        React.createElement('div', { style: STAGE_STYLE },
          React.createElement('canvas', { ref: canvasRef, width: 1280, height: 800, style: CANVAS_STYLE }),
          view.hasFrame && view.error === '' ? null : React.createElement(
            'div',
            { style: OVERLAY_STYLE },
            // 黑屏有好几种原因，分开说，别让人以为坏了。
            view.error !== ''
              ? view.error
              : view.active === false
                ? copy('empty.background')
                : view.streaming
                  ? copy('empty.first')
                  : copy('empty'),
          ),
        ),
        React.createElement('div', { style: FOOT_STYLE },
          React.createElement('span', { style: FOOT_TEXT_STYLE },
            view.owner === 'user'
              ? copy('control.userHint')
              : view.active === false
                ? copy('tab.background')
                : view.hasFrame
                  ? view.paused ? copy('hint.frozen') : copy('hint')
                  : copy('channel') + ' ' + (view.endpoint === '' ? '—' : view.endpoint)),
          React.createElement('button', {
            type: 'button',
            onClick: refresh,
            title: copy('refresh'),
            style: { ...BUTTON_STYLE, flex: 'none', padding: '1px 7px' },
          }, '↻'),
        ),
      )
    }

    /** 侧栏里那份小窗。宿主没有侧栏（别的 UI）时安静地不注册。 */
    function registerPreview(ctx) {
      if (React === undefined || typeof ctx?.inject !== 'function') return
      ctx.inject(['sidebarRightTabs', 'slots'], (scope) => {
        scope.effect(() => scope.sidebarRightTabs.register({
          id: PREVIEW_TAB_ID,
          kind: PREVIEW_TAB_KIND,
          priority: 'extension',
          multiple: false,
          title: () => copy('tab'),
          guide: [{
            id: 'open',
            order: 60,
            title: () => copy('guide'),
            description: () => copy('guideDescription'),
          }],
        }), 'chrome-tab: preview tab type')
        scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
          name: 'sidebar.right.pane.tab',
          key: PREVIEW_TAB_ID,
        }, BrowserPreviewBody)), 'chrome-tab: preview tab body')
      })
    }

    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(LOCALE_NS, dictionaries),
        'chrome-tab: locale dictionaries',
      )
      // getLocale() 交出来的是快照对象 { active, locales, revision }，不是语言串。
      // 早先直接 String() 它，得到的是 "[object Object]"，于是中文界面配英文小窗。
      const adoptLanguage = () => {
        let active
        try {
          const snapshot = ctx.locale.getLocale?.()
          active = typeof snapshot === 'string' ? snapshot : snapshot?.active
        } catch {
          active = undefined
        }
        language = typeof active === 'string' && active.toLowerCase().startsWith('zh') === false ? 'en' : 'zh'
      }
      adoptLanguage()
      ctx.effect(() => {
        if (typeof ctx.locale.subscribe !== 'function') return () => {}
        return ctx.locale.subscribe(() => {
          adoptLanguage()
          // 换语言时悬浮窗是活的 DOM，得让它自己重画一遍，不然按钮停在旧语言上。
          floatWindow?.refresh?.()
        })
      }, 'chrome-tab: locale tracking')

      registerPreview(ctx)

      // 小窗挂在界面上，不依赖侧栏：有侧栏时它也能开成全屏 tab，没有就只留悬浮窗。
      mountFloat()
      if (typeof document !== 'undefined') {
        ctx.effect(() => {
          // 宿主那边没有推送通道，问一句很便宜；目标换人时小窗才需要出现。
          const timer = setInterval(watchTarget, 3000)
          timer?.unref?.()
          void watchTarget()
          return () => clearInterval(timer)
        }, 'chrome-tab: preview target tracking')
      }

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
