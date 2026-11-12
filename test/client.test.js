/**
 * Browser-half dry run: `client.js` is evaluated in a VM that stands in for the
 * Web UI module loader, so the registration path is exercised without a browser.
 *
 * The source it registers is then driven the way the @ menu drives it: list
 * candidates, pick one, serialize the resulting mention.
 */

import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// A tab listing is the only thing the client fetches from the host.
const fetchCalls = []
const tabsPayload = {
  connected: true,
  currentTabId: 777,
  tabs: [
    { id: 777, windowId: 1, title: '哔哩哔哩 (゜-゜)つロ 干杯~-bilibili', url: 'https://www.bilibili.com/', active: true, injectable: true },
    { id: 778, windowId: 1, title: 'DeepSeek', url: 'https://chat.deepseek.com/sign_in', active: false, injectable: true },
    { id: 779, windowId: 1, title: 'chrome://settings', url: 'chrome://settings', active: false, injectable: false },
  ],
}

const registered = []
let localeRegister
let source

// 真的 locale 服务交出来的是快照对象，不是语言串：照原样给桩，才能挡住
// "String(快照) === '[object Object]'" 这类把中文界面读成英文的错误。
const localeSnapshot = { active: 'zh', locales: [{ id: 'zh' }, { id: 'en' }], revision: 0 }
const localeSubscribers = []
const locale = {
  register: (namespace, dictionaries) => {
    localeRegister = { namespace, dictionaries }
    return () => {}
  },
  getLocale: () => localeSnapshot,
  subscribe: (fn) => {
    localeSubscribers.push(fn)
    return () => {}
  },
}

const sidebarTabs = []
const paneBodies = []
const openedTabs = []
const ctx = {
  effect: (factory) => {
    factory()
    return () => {}
  },
  inject: (names, callback) => {
    const scope = {
      effect: (factory) => {
        factory()
        return () => {}
      },
      sidebarRightTabs: {
        register: (definition) => {
          sidebarTabs.push(definition)
          return () => {}
        },
      },
      slots: {
        inject: (_name, factory) => factory(),
        register: (definition, Body) => {
          paneBodies.push({ definition, Body })
          return () => {}
        },
      },
    }
    // 侧栏导航控制器单独注入：小窗要被「选中标签页」这个动作带出来。
    if (names.includes('sidebarRight')) {
      scope.sidebarRight = { openTab: (kind) => openedTabs.push(kind) }
    }
    callback(scope)
    return () => {}
  },
  on: () => () => {},
  get: (name) => (name === 'inputTriggers' ? { registerSource: (s) => { source = s; registered.push(s); return () => {} } } : undefined),
  locale,
}

// 悬浮窗是原生 DOM 造的：给一个够用的影子，让「建窗口、显示、关闭」真的跑一遍。
class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.style = {}
    this.listeners = {}
    this.attributes = {}
    this.id = ''
    this.textContent = ''
  }

  append(...nodes) {
    this.children.push(...nodes)
  }

  addEventListener(type, fn) {
    ;(this.listeners[type] ??= []).push(fn)
  }

  removeEventListener() {}

  setAttribute(name, value) {
    this.attributes[name] = value
  }

  getAttribute(name) {
    return this.attributes[name]
  }

  closest() {
    return null
  }

  setPointerCapture() {}

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 420, height: 300 }
  }

  getContext() {
    return { drawImage() {} }
  }
}

const body = new StubNode('body')
const findById = (node, id) => {
  if (node.id === id) return node
  for (const child of node.children) {
    const hit = findById(child, id)
    if (hit !== null) return hit
  }
  return null
}
const document = {
  body,
  createElement: (tag) => new StubNode(tag),
  getElementById: (id) => findById(body, id),
}

// 目标标签页轮询收到的答复；一开始没有目标，面板不该自己跳出来。
const statusPayload = {
  connected: true,
  preview: { wsUrl: 'ws://127.0.0.1:55271/dsh-chrome-tab/preview' },
}
// 定时器换成手摇的：轮询时机由测试决定，不靠等真实时间。
const intervals = []
const timeouts = []
const sockets = []
class StubSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    // 上行只有两句：换手和「要一张」。两句都要能在测试里看到。
    this.sent = []
    sockets.push(this)
  }

  send(data) {
    this.sent.push(String(data))
  }

  close() {
    this.readyState = 3
  }
}
const sandbox = {
  console,
  location: { origin: 'http://127.0.0.1:55271' },
  fetch: async (url, init) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET' })
    if (String(url).includes('/dsh-chrome-tab/tabs')) {
      return { ok: true, json: async () => tabsPayload }
    }
    if (String(url).includes('/dsh-chrome-tab/status')) {
      return { ok: true, json: async () => statusPayload }
    }
    return { ok: true, json: async () => ({ ok: true }) }
  },
  setInterval: (fn, ms) => {
    intervals.push({ fn, ms })
    return intervals.length
  },
  clearInterval: (id) => {
    intervals[id - 1] = undefined
  },
  setTimeout: (fn, ms) => {
    timeouts.push({ fn, ms })
    return timeouts.length
  },
  clearTimeout: (id) => {
    timeouts[id - 1] = undefined
  },
  WebSocket: StubSocket,
  // 帧是 Blob：解成位图这一步在测试里只需要一个有宽高的替身。
  createImageBitmap: async () => ({ width: 1280, height: 800, close() {} }),
  Element: StubNode,
  document,
  AbortSignal,
  window: {},
}
sandbox.window.__ModuleLoader__ = {
  load: ({ id, factory }) => {
    sandbox.__loaded = { id, module: factory((name) => {
      if (name !== 'react') throw new Error(`unexpected require ${name}`)
      return {}
    }) }
  },
}
sandbox.globalThis = sandbox

const context = createContext(sandbox)
runInContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), context, { filename: 'client.js' })

const loaded = sandbox.__loaded
check('module loader received the package id', loaded?.id === 'dsh-chrome-tab', loaded?.id)
check('exports apply()', typeof loaded?.module?.apply === 'function')
check('declares its cordis inject list', Array.isArray(loaded?.module?.inject)
  && loaded.module.inject.includes('inputTriggers'), JSON.stringify(loaded?.module?.inject))

loaded.module.apply(ctx)
check('locale dictionaries registered under meta namespace', localeRegister?.namespace === 'dsh-chrome-tab'
  && typeof localeRegister.dictionaries.zh === 'object' && typeof localeRegister.dictionaries.en === 'object')
// 小窗是侧栏里的一个 tab 类型：标题要能当场求值，body 的 key 必须是那个 tab id。
check('one sidebar tab type registered', sidebarTabs.length === 1
  && typeof sidebarTabs[0].title === 'function' && sidebarTabs[0].title().length > 0,
  JSON.stringify({ id: sidebarTabs[0]?.id, kind: sidebarTabs[0]?.kind, title: sidebarTabs[0]?.title?.() }))
check('one pane body registered under the tab id', paneBodies.length === 1
  && paneBodies[0].definition.name === 'sidebar.right.pane.tab'
  && paneBodies[0].definition.key === sidebarTabs[0].id,
  JSON.stringify(paneBodies.map((entry) => entry.definition)))
check('the tab body renders without a layout', typeof paneBodies[0]?.Body === 'function')

check('one @ source registered', registered.length === 1)
check('source triggers on @', source?.trigger === '@', source?.trigger)
check('source has a unique name', source?.name === 'chrome-tab', source?.name)
check('source implements the pick codec', typeof source?.codec?.serialize === 'function'
  && typeof source?.codec?.clipboardText === 'function')

const rows = await source.candidates({ sessionId: 's1' }, { query: '', signal: new AbortController().signal })
check('candidate list skips undrivable tabs', rows.length === 2, `${rows.length} rows`)
check('candidate rows carry the required fields',
  rows.every((row) => typeof row.name === 'string' && typeof row.icon === 'string'
    && typeof row.section === 'string' && typeof row.value === 'string'))
check('the controlled tab is marked', rows[0].description.includes('当前目标'), rows[0].description)

const filtered = await source.candidates({ sessionId: 's1' }, { query: 'deepseek', signal: new AbortController().signal })
check('query narrows the list', filtered.length === 1 && filtered[0].name === 'DeepSeek', JSON.stringify(filtered.map((row) => row.name)))

const picked = source.onPick({ candidate: rows[0], action: 'pick' })
check('pick returns an atomic insert', typeof picked?.insert?.ref === 'string' && picked.insert.ref === 'chrome-tab:777', JSON.stringify(picked?.insert?.ref))
check('pick uses an existing appearance', ['session', 'file', 'folder'].includes(picked?.insert?.appearance), picked?.insert?.appearance)
check('pick labels the mention', typeof picked.insert.label === 'string' && picked.insert.label.length > 0, picked.insert.label)
check('pick hands the url to the clipboard', picked.insert.clipboardText === 'https://www.bilibili.com/')

// The host learns which tab the model will drive from this POST.
await new Promise((resolve) => setTimeout(resolve, 20))
check('pick tells the host which tab was chosen', fetchCalls.some((call) => call.method === 'POST'
  && String(call.url).endsWith('/dsh-chrome-tab/select')), JSON.stringify(fetchCalls.map((call) => call.method)))

// 宿主没有推送通道，小窗靠轮询知道目标换了人。
check('the panel polls the host target', intervals.some((entry) => entry?.ms === 3000),
  JSON.stringify(intervals.map((entry) => entry?.ms)))

// 选完标签页就把小窗带出来：浮在界面右上，不占侧栏，也不用去翻入口。
const floatRoot = document.getElementById('dsh-chrome-tab-float')
check('picking a tab floats the preview out', floatRoot !== null, String(floatRoot?.id))
check('the float is an overlay at the right edge',
  floatRoot?.style.position === 'fixed' && floatRoot?.style.right === '18px',
  JSON.stringify({ position: floatRoot?.style.position, right: floatRoot?.style.right }))
check('the float is visible after a pick', floatRoot?.style.display === 'block', String(floatRoot?.style.display))
check('the preview no longer takes over the sidebar', openedTabs.length === 0, JSON.stringify(openedTabs))
// 窗体就是画面：stage 铺满，控件浮在上面。没有留白的舞台，也就没有黑框。
const floatStage = floatRoot?.children?.[0]
const floatTopbar = floatRoot?.children?.[1]
const floatButtons = (floatTopbar?.children ?? []).filter((node) => node.tagName === 'BUTTON')
check('the float header has a take-over button and a close button',
  floatButtons.some((node) => node.textContent === '暂停接管') && floatButtons.some((node) => node.textContent === '×'),
  JSON.stringify(floatButtons.map((node) => node.textContent)))
const floatCanvas = (floatStage?.children ?? []).find((node) => node.tagName === 'CANVAS')
check('the float draws the page into a canvas', floatCanvas !== undefined,
  JSON.stringify((floatStage?.children ?? []).map((node) => node.tagName)))
check('the picture fills the window instead of sitting in a black frame',
  floatCanvas?.style.width === '100%' && floatCanvas?.style.height === '100%'
  && floatStage?.style.inset === '0',
  JSON.stringify({ width: floatCanvas?.style.width, height: floatCanvas?.style.height, inset: floatStage?.style.inset }))

// 换语言：悬浮窗是活的 DOM，没人重渲染它，只能自己跟着 locale 订阅重画。
localeSnapshot.active = 'en'
localeSnapshot.revision += 1
for (const fn of localeSubscribers) fn()
check('the float follows a language switch',
  floatButtons.some((node) => node.textContent === 'Take over'),
  JSON.stringify(floatButtons.map((node) => node.textContent)))
localeSnapshot.active = 'zh-CN'
localeSnapshot.revision += 1
for (const fn of localeSubscribers) fn()
check('the float switches back to chinese',
  floatButtons.some((node) => node.textContent === '暂停接管'),
  JSON.stringify(floatButtons.map((node) => node.textContent)))

// 按需录屏：流停了不是故障，是「没有东西在动」。画面要留在最后一帧上，
// 而且得让人能手动再要一张，不然他会以为只能等模型。
const previewSocket = sockets.filter((socket) => String(socket.url).includes('/dsh-chrome-tab/preview')).at(-1)
check('the float opened a preview socket', previewSocket !== undefined, String(previewSocket?.url))
previewSocket.readyState = 1
previewSocket.onopen?.()
previewSocket.onmessage?.({ data: JSON.stringify({ type: 'hello', connected: true, streaming: false, control: { owner: 'agent' } }) })
// 先给一帧：有画面，「停住」才有东西可留。
previewSocket.onmessage?.({ data: { blob: true } })
await new Promise((resolve) => setTimeout(resolve, 20))
previewSocket.onmessage?.({ data: JSON.stringify({ type: 'stream', running: false, tabId: 777, reason: 'idle' }) })
const floatHint = floatRoot.children[2]
const floatFootText = floatHint?.children?.[0]
const floatRefresh = (floatTopbar?.children ?? []).find((node) => node.textContent === '↻')
check('an idle stop reads as frozen, not as a failure',
  String(floatFootText?.textContent).includes('停在最后一帧'),
  String(floatFootText?.textContent))
check('the header says frozen too',
  (floatTopbar?.children ?? []).some((node) => node.textContent === '停在最后一帧'),
  JSON.stringify((floatTopbar?.children ?? []).map((node) => node.textContent)))
check('the refresh button rides along with the controls', floatRefresh !== undefined,
  JSON.stringify((floatTopbar?.children ?? []).map((node) => node.textContent)))
floatRefresh.listeners.click?.[0]?.()
check('the refresh button asks the host for one frame',
  previewSocket.sent.includes(JSON.stringify({ type: 'refresh' })), JSON.stringify(previewSocket.sent))

const serialized = await source.codec.serialize(picked.insert.ref)
check('serialize carries the tab id to the model', serialized.includes('777') && serialized.includes('bilibili.com'), serialized.slice(0, 100))
check('serialize names the tools to use', serialized.includes('chrome_snapshot'))

// Flip the same host into its disconnected state; the source must degrade to a
// single row that explains how to connect rather than fall silent.
tabsPayload.connected = false
tabsPayload.tabs = []
const offlineRows = await source.candidates({ sessionId: 's1' }, { query: '', signal: new AbortController().signal })
check('a disconnected host yields one hint row', offlineRows.length === 1 && offlineRows[0].name.includes('未连接'), JSON.stringify(offlineRows.map((row) => row.name)))
const offlinePick = source.onPick({ candidate: offlineRows[0], action: 'pick' })
check('the hint row explains how to connect', typeof offlinePick?.text === 'string' && offlinePick.text.includes('chrome://extensions'), String(offlinePick?.text).slice(0, 60))

// A tab bridge other than the current one holding the extension is the cause
// users actually hit after a plugin reload, and "load the extension" is wrong
// advice there: it is loaded, it is just talking to a listener nothing drives.
tabsPayload.reason = { kind: 'stale', port: 30795, message: 'stale' }
const staleRows = await source.candidates({ sessionId: 's1' }, { query: '', signal: new AbortController().signal })
check('a stale holder is named instead of a missing extension',
  staleRows.length === 1 && staleRows[0].name.includes('旧实例'),
  JSON.stringify(staleRows.map((row) => row.name)))
const stalePick = source.onPick({ candidate: staleRows[0], action: 'pick' })
check('the stale hint names the port and the fix',
  typeof stalePick?.text === 'string' && stalePick.text.includes('30795') && stalePick.text.includes('重启'),
  String(stalePick?.text).slice(0, 70))

tabsPayload.reason = { kind: 'elsewhere', port: 30796, message: 'elsewhere' }
const elsewhereRows = await source.candidates({ sessionId: 's1' }, { query: '', signal: new AbortController().signal })
check('a second harness window is named as such',
  elsewhereRows.length === 1 && elsewhereRows[0].name.includes('另一个'),
  JSON.stringify(elsewhereRows.map((row) => row.name)))

// 用户关掉窗口之后，模型换目标不该把它弹回来；他自己再选标签页才会。
const closeButton = floatButtons.find((node) => node.textContent === '×')
closeButton.listeners.click?.[0]?.()
check('the close button hides the float', floatRoot.style.display === 'none', floatRoot.style.display)
const poller = intervals.find((entry) => entry?.ms === 3000)
statusPayload.currentTabId = 999
poller.fn()
await new Promise((resolve) => setTimeout(resolve, 20))
statusPayload.currentTabId = 1000
poller.fn()
await new Promise((resolve) => setTimeout(resolve, 20))
check('a new host target leaves a closed float closed', floatRoot.style.display === 'none', floatRoot.style.display)
source.onPick({ candidate: rows[1], action: 'pick' })
check('picking another tab brings it back', floatRoot.style.display === 'block', floatRoot.style.display)

const failed = results.filter((ok) => ok !== true).length
console.log('')
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
