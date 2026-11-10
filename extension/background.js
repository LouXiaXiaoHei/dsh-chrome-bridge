/**
 * DSH Chrome Tab Bridge, extension half.
 *
 * Holds one WebSocket to the DeepSeek Harness host and executes the tab and
 * page operations it asks for. Chrome MV3 forbids `eval` and `new Function`
 * inside extension pages, so every page operation is a fixed function handed to
 * `chrome.scripting.executeScript` together with its arguments. Nothing here
 * interprets host-provided code.
 */

const HOST_PORTS = [
  30795, 30796, 30797, 30798, 30799, 30800, 30801, 30802, 30803, 30804, 30805,
]
const CONFIG_PATH = '/dsh-chrome-tab/config'
const KEEPALIVE_ALARM = 'dsh-chrome-tab-keepalive'

/** Service-worker globals do not survive suspend, so connection state is rebuilt on every wake. */
let socket
let connecting
let lastError

// ---------------------------------------------------------------- page functions
// Each one is serialized by chrome.scripting and runs in the extension's isolated
// world inside the target tab, so it may close over nothing but its arguments.

function fnSnapshot(options) {
  const maxInteractive = Number(options && options.maxInteractive) || 60
  const maxText = Number(options && options.maxText) || 12000
  const selector = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="combobox"]',
    '[role="textbox"]',
    '[contenteditable="true"]',
    '[contenteditable=""]',
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',')

  const compact = (value, limit) => String(value == null ? '' : value).replace(/\s+/gu, ' ').trim().slice(0, limit)

  const visible = (element) => {
    if (!(element instanceof Element)) return false
    const rect = element.getBoundingClientRect()
    if (rect.width < 3 || rect.height < 3) return false
    if (rect.bottom < -4000 || rect.top > 40000) return false
    const style = getComputedStyle(element)
    if (style.visibility === 'hidden' || style.display === 'none') return false
    if (Number(style.opacity || '1') < 0.05) return false
    return true
  }

  const describe = (element) => {
    const parts = []
    const kind = element instanceof HTMLInputElement ? 'input[' + element.type + ']' : element.tagName.toLowerCase()
    const role = element.getAttribute('role')
    parts.push(role ? kind + ':' + role : kind)
    if (element.id) parts.push('#' + compact(element.id, 40))
    const nameAttribute = element.getAttribute('name')
    if (nameAttribute) parts.push('name=' + compact(nameAttribute, 40))
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.type === 'password') parts.push('value="***"')
      else if (element.value) parts.push('value="' + compact(element.value, 60) + '"')
      if (element.placeholder) parts.push('placeholder="' + compact(element.placeholder, 60) + '"')
      if (element.disabled) parts.push('disabled')
      if (element.checked) parts.push('checked')
    }
    const source = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? element.value || element.placeholder
      : element.innerText || element.textContent
    const label = compact(element.getAttribute('aria-label') || element.getAttribute('title') || source, 100)
    if (label) parts.push(JSON.stringify(label))
    const href = element.getAttribute('href')
    if (href && href.slice(0, 11) !== 'javascript:') parts.push('href=' + compact(href, 120))
    return parts.join(' ')
  }

  const elements = []
  const seen = new Set()
  let truncated = false
  const all = document.querySelectorAll(selector)
  for (let i = 0; i < all.length; i += 1) {
    const element = all[i]
    if (elements.length >= maxInteractive) { truncated = true; break }
    if (seen.has(element) || !visible(element)) continue
    seen.add(element)
    elements.push(element)
  }
  globalThis.__dshChromeTab = { elements }

  const headings = []
  const headingNodes = document.querySelectorAll('h1,h2,h3')
  for (let i = 0; i < headingNodes.length; i += 1) {
    if (headings.length >= 12) break
    if (!visible(headingNodes[i])) continue
    const label = compact(headingNodes[i].innerText, 120)
    if (label) headings.push(headingNodes[i].tagName.toLowerCase() + ': ' + label)
  }

  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    headings,
    interactive: elements.map((element, offset) => (offset + 1) + '. ' + describe(element)),
    interactiveTruncated: truncated,
    text: compact(document.body ? document.body.innerText : document.documentElement.textContent, maxText),
    scroll: {
      y: Math.round(window.scrollY),
      height: Math.round(document.documentElement.scrollHeight),
      viewport: window.innerHeight,
    },
  }
}

function fnTargetBox(index) {
  const store = globalThis.__dshChromeTab
  if (!store || !store.elements) return { error: 'no snapshot on record; call chrome_snapshot first' }
  const element = store.elements[index - 1]
  if (!element) return { error: 'index ' + index + ' is not in the current snapshot' }
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  const rect = element.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return { error: 'index ' + index + ' has no clickable box' }
  const label = String(element.getAttribute('aria-label') || element.innerText || element.textContent || '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80)
  const editable = element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
    || element.isContentEditable === true
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
    tag: element.tagName.toLowerCase(),
    label,
    editable,
  }
}

function fnClickAt(point) {
  const x = Number(point.x)
  const y = Number(point.y)
  const element = document.elementFromPoint(x, y)
  if (!element) return { error: 'nothing at ' + x + ',' + y }
  const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, button: 0 }
  const pointer = Object.assign({}, init, { pointerId: 1, pointerType: 'mouse', isPrimary: true })
  element.dispatchEvent(new PointerEvent('pointerdown', pointer))
  element.dispatchEvent(new MouseEvent('mousedown', init))
  if (typeof element.focus === 'function') element.focus({ preventScroll: true })
  element.dispatchEvent(new PointerEvent('pointerup', pointer))
  element.dispatchEvent(new MouseEvent('mouseup', init))
  element.dispatchEvent(new MouseEvent('click', init))
  const label = String(element.getAttribute('aria-label') || element.innerText || element.textContent || '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80)
  const tag = element.tagName.toLowerCase()
  return { tag, label, hit: label ? tag + ' ' + JSON.stringify(label) : tag }
}

function fnFocus(index) {
  const store = globalThis.__dshChromeTab
  if (!store || !store.elements) return { error: 'no snapshot on record; call chrome_snapshot first' }
  const element = store.elements[index - 1]
  if (!element) return { error: 'index ' + index + ' is not in the current snapshot' }
  element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
  if (typeof element.focus === 'function') element.focus({ preventScroll: true })
  const editable = element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
    || element.isContentEditable === true
  return {
    tag: element.tagName.toLowerCase(),
    editable,
    label: String(element.getAttribute('aria-label') || element.getAttribute('placeholder') || '').slice(0, 80),
  }
}

function fnInsertText(payload) {
  const text = String(payload.text == null ? '' : payload.text)
  const element = document.activeElement
  if (!element || element === document.body) return { error: 'no focused element; click the field first' }
  if (payload.replace === true) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.select()
    else if (element.isContentEditable) document.execCommand('selectAll', false)
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype = element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
    const next = payload.replace === true ? text : element.value + text
    setter.call(element, next)
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return { tag: element.tagName.toLowerCase(), value: element.value.slice(0, 200) }
  }
  if (element.isContentEditable) {
    document.execCommand('insertText', false, text)
    return { tag: element.tagName.toLowerCase(), value: String(element.innerText || '').slice(0, 200) }
  }
  return { error: 'the focused element accepts no text' }
}

function fnKey(payload) {
  const element = document.activeElement || document.body
  const key = String(payload.key)
  const base = { key, bubbles: true, cancelable: true, composed: true, view: window }
  if (key === 'Enter') Object.assign(base, { code: 'Enter', keyCode: 13, which: 13 })
  if (key === 'Escape') Object.assign(base, { code: 'Escape', keyCode: 27, which: 27 })
  if (key === 'Tab') Object.assign(base, { code: 'Tab', keyCode: 9, which: 9 })
  element.dispatchEvent(new KeyboardEvent('keydown', base))
  element.dispatchEvent(new KeyboardEvent('keypress', base))
  element.dispatchEvent(new KeyboardEvent('keyup', base))
  if (key === 'Enter' && element.form && typeof element.form.requestSubmit === 'function') {
    // A synthetic Enter rarely submits on its own; help form fields along.
    element.form.requestSubmit()
  }
  return { tag: element.tagName.toLowerCase(), key }
}

function fnScroll(payload) {
  const amount = Number(payload.amount) || 600
  window.scrollBy({ top: amount, left: 0, behavior: 'instant' })
  return {
    y: Math.round(window.scrollY),
    height: Math.round(document.documentElement.scrollHeight),
    viewport: window.innerHeight,
  }
}

function fnQuery(payload) {
  const selector = String(payload.selector)
  const attribute = typeof payload.attribute === 'string' ? payload.attribute.trim() : ''
  const limit = Math.min(Math.max(Number(payload.limit) || 40, 1), 200)
  const all = document.querySelectorAll(selector)
  const items = []
  for (let i = 0; i < all.length && items.length < limit; i += 1) {
    const element = all[i]
    const item = {
      tag: element.tagName.toLowerCase(),
      text: String(element.innerText || element.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, 200),
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      // A form control's live value is what the user typed, not the HTML attribute.
      item.value = element instanceof HTMLSelectElement ? String(element.value) : String(element.value).slice(0, 300)
    }
    if (attribute !== '') {
      // "value" on a control means what it currently holds; everything else is a real attribute.
      const live = attribute === 'value' && 'value' in element && typeof element.value === 'string'
      const value = live ? element.value : element.getAttribute(attribute)
      if (value !== null) {
        item.attributeName = attribute
        item.attribute = String(value).slice(0, 300)
      }
    }
    items.push(item)
  }
  return { count: all.length, truncated: all.length > items.length, items }
}

/** One poll of a wait; the extension repeats it so a slow page never blocks a single call. */
function fnWaitProbe(payload) {
  const selector = typeof payload.selector === 'string' ? payload.selector : ''
  const text = typeof payload.text === 'string' ? payload.text : ''
  if (selector !== '') {
    const element = document.querySelector(selector)
    if (element) {
      const label = String(element.innerText || element.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, 120)
      return { found: true, detail: `${selector} matched <${element.tagName.toLowerCase()}> ${label}` }
    }
  }
  if (text !== '') {
    const body = String(document.body ? document.body.innerText : document.documentElement.textContent || '')
    const at = body.indexOf(text)
    if (at !== -1) {
      const around = body.slice(Math.max(0, at - 60), at + text.length + 60).replace(/\s+/gu, ' ').trim()
      return { found: true, detail: `text appeared: …${around}…` }
    }
  }
  return { found: false, detail: '' }
}

/**
 * Viewport metrics the host needs to turn a CSS pixel into a screen point.
 *
 * The native input path works in screen coordinates, while everything the page
 * reports is in CSS pixels. `dpr` and the page zoom both scale one into the
 * other, so the host reads the viewport size here and divides it into the web
 * area's real size, which Chrome already reports in screen points.
 */
// The pointer the user sees while the agent works. It lives inside the page, so it
// can never float over another application — and because it is only decoration it
// opts out of hit testing entirely.
//
// 光标代表“这个标签页正在被接管”，所以它的生命周期跟接管一样长：接管开始时创建，
// 中途只移动、不消失，解除接管时才移除。每次调用都先补齐元素，移动只是附带动作。
function fnCursor(payload) {
  const ID = '__dsh_ai_cursor'
  const STYLE_ID = '__dsh_ai_cursor_style'
  const p = payload || {}
  const existing = document.getElementById(ID)
  if (p.mode === 'release') {
    if (existing) existing.remove()
    const style = document.getElementById(STYLE_ID)
    if (style) style.remove()
    const guard = window.__dshAiCursorGuard
    if (guard !== undefined) {
      guard.disconnect()
      window.__dshAiCursorGuard = undefined
    }
    return { ok: true, released: true }
  }

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = [
      '@keyframes __dsh_ai_bob{0%,100%{transform:translate3d(0,0,0)}50%{transform:translate3d(0,-1.4px,0)}}',
      '@keyframes __dsh_ai_ring{0%{opacity:.85;transform:scale(.25)}70%{opacity:.28}100%{opacity:0;transform:scale(1.55)}}',
      `#${ID}{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:0;height:0;`,
      'transition:transform 200ms cubic-bezier(.22,.9,.28,1);will-change:transform}',
      `#${ID} .__bob{width:19px;height:25px;transform-origin:2px 2px;`,
      'animation:__dsh_ai_bob 3s ease-in-out infinite;transition:transform 90ms ease-out;',
      'filter:drop-shadow(0 0 1.6px rgba(255,255,255,.95)) drop-shadow(0 1px 2.5px rgba(0,0,0,.45))}',
      `#${ID}.__press .__bob{transform:scale(.86)}`,
      `#${ID} .__ring{position:absolute;left:0;top:0;width:30px;height:30px;margin:-15px 0 0 -15px;`,
      'border-radius:50%;border:2.5px solid rgba(255,255,255,.95);opacity:0;pointer-events:none;',
      'box-shadow:0 0 0 1px rgba(0,0,0,.22) inset,0 0 6px rgba(255,255,255,.65)}',
    ].join('')
    ;(document.head || document.documentElement).appendChild(style)
  }

  let root = existing
  const askedX = Number(p.x)
  const askedY = Number(p.y)
  const hasPoint = Number.isFinite(askedX) && Number.isFinite(askedY)
  // 接管那一刻还没有任何操作，没人给出坐标，就落在视口中心——最不突兀的起点。
  const x = hasPoint ? askedX : Math.round(window.innerWidth / 2)
  const y = hasPoint ? askedY : Math.round(window.innerHeight / 2)
  if (!root) {
    root = document.createElement('div')
    root.id = ID
    root.setAttribute('aria-hidden', 'true')
    root.style.transition = 'none'
    root.style.transform = `translate3d(${x - 1.6}px, ${y - 1.2}px, 0)`
    root.innerHTML =
      '<div class="__bob"><svg width="19" height="25" viewBox="0 0 19 25">' +
      '<path d="M1.7 1.3 L1.7 20.2 L6.8 15.5 L10.1 23.1 L13.3 21.7 L10 14.1 L16.7 13.8 Z" ' +
      'fill="#111111" stroke="#ffffff" stroke-width="1.7" stroke-linejoin="round"/>' +
      '</svg></div><span class="__ring"></span>'
    // 挂在 html 上而不是 body：单页应用首屏水合时经常整个替换 body，光标会跟着没。
    ;(document.documentElement || document.body).appendChild(root)
    void root.offsetWidth
    root.style.transition = ''
    // 仍然可能有框架重排 html 的子节点，守望一次，把被挤掉的光标放回原处，
    // 这样“接管期间光标一直在”不依赖任何操作的时机。
    if (window.__dshAiCursorGuard === undefined) {
      const home = () => document.documentElement || document.body
      const guard = new MutationObserver(() => {
        const el = document.getElementById(ID)
        if (el && !el.isConnected && home()) home().appendChild(el)
      })
      guard.observe(document.documentElement, { childList: true })
      window.__dshAiCursorGuard = guard
    }
  } else if (hasPoint) {
    root.style.transform = `translate3d(${x - 1.6}px, ${y - 1.2}px, 0)`
  }

  if (p.pressed === true) root.classList.add('__press')
  else root.classList.remove('__press')

  if (p.pulse === true) {
    const ring = root.querySelector('.__ring')
    if (ring) {
      ring.style.animation = 'none'
      void ring.offsetWidth
      ring.style.animation = '__dsh_ai_ring 420ms ease-out'
    }
  }
  // created 为真表示这一次调用才把光标放上去，调用方可以据此判断接管是否刚刚成立。
  return { ok: true, created: existing === null, x, y }
}

function fnMetrics() {
  return {
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    dpr: window.devicePixelRatio || 1,
    scrollX: Math.round(window.scrollX),
    scrollY: Math.round(window.scrollY),
    scrollHeight: Math.round(document.documentElement.scrollHeight),
    url: location.href,
    title: document.title,
  }
}

/** Tabs this extension can script; the rest are still listed so the picker can show why. */
function injectable(url) {
  return typeof url === 'string' && /^https?:\/\//u.test(url)
}

/**
 * Snapshot indexes are 1-based. Anything else has to fail here: Chrome refuses to
 * serialize `undefined` into executeScript arguments, and the raw error ("Value is
 * unserializable") tells the model nothing about what went wrong.
 */
function requireIndex(value) {
  const index = Number(value)
  if (!Number.isFinite(index) || index < 1 || Math.floor(index) !== index) {
    throw new Error(`index must be a whole number of 1 or more, got ${JSON.stringify(value)}; run chrome_snapshot first`)
  }
  return index
}

async function listTabs() {
  const tabs = await chrome.tabs.query({})
  return {
    tabs: tabs
      .filter((tab) => typeof tab.id === 'number')
      .map((tab) => ({
        id: tab.id,
        windowId: tab.windowId,
        title: tab.title || '',
        url: tab.url || '',
        active: tab.active === true,
        injectable: injectable(tab.url),
      })),
  }
}

async function describeTab(tabId) {
  const tab = await chrome.tabs.get(tabId)
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title || '',
    url: tab.url || '',
    active: tab.active === true,
    injectable: injectable(tab.url),
  }
}

async function runInPage(tabId, fn, args) {
  const tab = await chrome.tabs.get(tabId)
  if (!injectable(tab.url)) {
    throw new Error(`tab ${tabId} is ${tab.url || 'an internal page'}; only http and https pages can be driven`)
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: fn,
    args: args === undefined ? [] : [args],
  })
  const first = Array.isArray(results) ? results[0] : undefined
  if (!first) throw new Error('the page returned no result')
  if (first.error) throw new Error(String(first.error.message || first.error))
  return first.result
}

async function capture(tabId) {
  const tab = await chrome.tabs.get(tabId)
  await chrome.tabs.update(tabId, { active: true })
  await chrome.windows.update(tab.windowId, { focused: true })
  // captureVisibleTab reads a painted frame; give the switch a moment to land.
  await new Promise((resolve) => setTimeout(resolve, 220))
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  const comma = dataUrl.indexOf(',')
  return { base64: comma === -1 ? '' : dataUrl.slice(comma + 1) }
}

/** Every method the host may call, with its handler. */
// Chrome DevTools Protocol over chrome.debugger. These are the events the page
// receives as genuinely trusted: the browser's own input pipeline produces them,
// so isTrusted is true and no synthetic-event sniffing can tell them apart.
const debuggees = new Set()

/**
 * 已经挂着常驻光标的标签页。光标是“这个标签页正在被接管”的标志，
 * 所以它跟着接管走：接管开始就创建，期间一直存在，解除接管才移除。
 */
const engagedTabs = new Set()

// 正在进行的 attach，按标签页。host 在选定标签的那一刻就点亮光标，紧跟其后的
// 第一个操作往往同时要求接管，两次 attach 会撞上 “Another debugger is already
// attached”。
const attaching = new Map()

// The API only exists once Chrome grants the debugger permission, so touching it at
// the top level would take the whole service worker down on an older install.
function debuggerApi() {
  const api = chrome.debugger
  if (api === undefined) {
    throw new Error('扩展缺少 debugger 权限：到 chrome://extensions 把这个扩展重新加载一次')
  }
  return api
}

async function attachDebugger(tabId) {
  if (debuggees.has(tabId)) return
  const inflight = attaching.get(tabId)
  if (inflight !== undefined) return inflight
  const work = (async () => {
    const api = debuggerApi()
    try {
      await api.attach({ tabId }, '1.3')
    } catch (error) {
      const message = String(error && error.message ? error.message : error)
      if (!/already attached/i.test(message)) {
        throw new Error(`无法接管标签页 ${tabId} 的调试通道：${message}`)
      }
    }
    debuggees.add(tabId)
    // CDP 接管的这一刻，光标就该出现在页面上——之后整段接管期它都在，
    // 不等到第一次点击才凭空冒出来。
    engagedTabs.add(tabId)
    void ensureCursor(tabId)
    // 文档常常还在加载：过一拍再确认一次，别让这一次落空变成整段接管没有指针。
    setTimeout(() => {
      if (engagedTabs.has(tabId)) void ensureCursor(tabId)
    }, 400)
  })()
  attaching.set(tabId, work)
  try {
    await work
  } finally {
    if (attaching.get(tabId) === work) attaching.delete(tabId)
  }
}

// 接管往往正好赶上换文档：那时注入会落空。光标只等一次就可能整段缺席，
// 所以失败要退避着重试，等文档稳下来再补。
const cursorRetries = new Map()

function scheduleCursorRetry(tabId, payload, attempt) {
  if (attempt >= 3) return
  const pending = cursorRetries.get(tabId)
  if (pending !== undefined) clearTimeout(pending)
  const timer = setTimeout(() => {
    cursorRetries.delete(tabId)
    if (engagedTabs.has(tabId)) void ensureCursor(tabId, payload, attempt + 1)
  }, 200 * 2 ** attempt)
  cursorRetries.set(tabId, timer)
}

async function ensureCursor(tabId, payload, attempt = 0) {
  const options = payload === undefined ? {} : payload
  try {
    const result = await runInPage(tabId, fnCursor, options)
    const pending = cursorRetries.get(tabId)
    if (pending !== undefined) {
      clearTimeout(pending)
      cursorRetries.delete(tabId)
    }
    return result
  } catch {
    // 内部页面注入不了，或者页面正在换文档；光标只是装饰，不该让接管因此失败，
    // 但也不能就这么丢掉——退避重试，别让它等到下一次点击才回来。
    if (options.mode !== 'release') scheduleCursorRetry(tabId, options, attempt)
    return undefined
  }
}

/** 接管一个标签页：接上 CDP、把常驻光标放到视口中心，涟漪一次表示接管开始。 */
async function engageTab(tabId) {
  engagedTabs.add(tabId)
  let attached = false
  try {
    await attachDebugger(tabId)
    attached = debuggees.has(tabId)
  } catch {
    // 被 DevTools 占着时 CDP 接不上，但光标仍然代表“这个标签页在被操作”。
  }
  const cursor = await ensureCursor(tabId, { pulse: true })
  return { attached, cursor }
}

/** 解除接管：撤掉光标，放开调试通道。 */
async function releaseTab(tabId) {
  engagedTabs.delete(tabId)
  debuggees.delete(tabId)
  await ensureCursor(tabId, { mode: 'release' })
  try {
    await debuggerApi().detach({ tabId })
  } catch {
    // 本来就没接上，或者标签页已经关掉了。
  }
}

async function sendCdp(tabId, method, params) {
  await attachDebugger(tabId)
  return debuggerApi().sendCommand({ tabId }, method, params === undefined ? {} : params)
}

// The tab is gone, or the user opened DevTools on it: forget the session so the
// next call re-attaches instead of failing forever.
try {
  chrome.debugger.onDetach.addListener((source) => {
    if (typeof source.tabId !== 'number') return
    debuggees.delete(source.tabId)
    // 调试通道断了（用户打开了 DevTools 等），接管随之结束，光标也不该留在页面上。
    if (engagedTabs.delete(source.tabId)) void ensureCursor(source.tabId, { mode: 'release' })
  })
} catch {
  // 没有 debugger 权限，CDP 通道自动退化为不可用。
}
chrome.tabs.onRemoved.addListener((tabId) => {
  debuggees.delete(tabId)
  engagedTabs.delete(tabId)
})

// 导航会换掉整个文档，光标元素跟着消失。接管期间补回来，所以打开新页面
// 之后不用等下一次点击，光标就已经在新文档的视口中心了。
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return
  if (!engagedTabs.has(tabId)) return
  void ensureCursor(tabId)
})

const METHODS = {
  async ping() {
    return { pong: true, at: Date.now() }
  },
  async 'tabs.list'() {
    return listTabs()
  },
  async 'tabs.get'(params) {
    return { tab: await describeTab(params.tabId) }
  },
  async 'tabs.open'(params) {
    const url = String(params.url)
    if (!/^https?:\/\//u.test(url)) throw new Error('only http and https urls can be opened')
    const tab = await chrome.tabs.create({ url, active: params.active !== false })
    return { tab: await describeTab(tab.id) }
  },
  async 'tabs.activate'(params) {
    const tabId = Number(params.tabId)
    if (!Number.isFinite(tabId)) throw new Error('tabs.activate needs a numeric tabId')
    // The native input channel can only reach the page the user can see, so
    // bringing the tab forward is part of driving it, not an extra flourish.
    const tab = await chrome.tabs.update(tabId, { active: true })
    await chrome.windows.update(tab.windowId, { focused: params.focus === true })
    return { tab: await describeTab(tab.id) }
  },
  async 'page.cdp'(params) {
    const tabId = Number(params.tabId)
    if (!Number.isFinite(tabId)) throw new Error('page.cdp needs a numeric tabId')
    const calls = Array.isArray(params.calls) ? params.calls : []
    const results = []
    for (const item of calls) {
      const method = String(item && item.method ? item.method : '')
      if (method === '') throw new Error('page.cdp got a call without a method')
      results.push(await sendCdp(tabId, method, item.params))
      const wait = Number(item.wait)
      if (Number.isFinite(wait) && wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 500)))
      }
    }
    return { results, attached: true }
  },
  async 'page.engage'(params) {
    const tabId = Number(params.tabId)
    if (!Number.isFinite(tabId)) throw new Error('page.engage needs a numeric tabId')
    const outcome = await engageTab(tabId)
    return { ok: true, attached: outcome.attached, cursor: outcome.cursor }
  },
  async 'page.release'(params) {
    const tabId = Number(params.tabId)
    if (!Number.isFinite(tabId)) throw new Error('page.release needs a numeric tabId')
    await releaseTab(tabId)
    return { ok: true, released: true }
  },
  async 'page.cursor'(params) {
    // 移动只是附带：元素不在就先补上，光标因此不会因为某次移动“提前清理”而消失。
    return ensureCursor(params.tabId, params.payload === undefined ? {} : params.payload)
  },
  async 'page.metrics'(params) {
    return runInPage(params.tabId, fnMetrics)
  },
  async 'page.snapshot'(params) {
    return runInPage(params.tabId, fnSnapshot, {
      maxInteractive: params.maxInteractive,
      maxText: params.maxText,
    })
  },
  async 'page.targetBox'(params) {
    return runInPage(params.tabId, fnTargetBox, requireIndex(params.index))
  },
  async 'page.clickAt'(params) {
    const x = Number(params.x)
    const y = Number(params.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('clickAt needs finite x and y viewport coordinates')
    return runInPage(params.tabId, fnClickAt, { x, y })
  },
  async 'page.focus'(params) {
    return runInPage(params.tabId, fnFocus, requireIndex(params.index))
  },
  async 'page.insertText'(params) {
    return runInPage(params.tabId, fnInsertText, { text: String(params.text ?? ''), replace: params.replace === true })
  },
  async 'page.key'(params) {
    return runInPage(params.tabId, fnKey, { key: params.key })
  },
  async 'page.scroll'(params) {
    return runInPage(params.tabId, fnScroll, { amount: params.amount })
  },
  async 'page.navigate'(params) {
    const url = String(params.url)
    if (!/^[a-z]+:\/\//iu.test(url)) throw new Error('navigate needs an absolute url')
    await chrome.tabs.update(params.tabId, { url })
    return { ok: true, url }
  },
  async 'page.query'(params) {
    return runInPage(params.tabId, fnQuery, {
      selector: params.selector,
      attribute: params.attribute,
      limit: params.limit,
    })
  },
  async 'page.wait'(params) {
    const started = Date.now()
    const timeoutMs = Math.min(Math.max(Number(params.timeoutMs) || 5000, 200), 15000)
    const probe = {
      selector: typeof params.selector === 'string' ? params.selector : '',
      text: typeof params.text === 'string' ? params.text : '',
    }
    let last
    for (;;) {
      // A missing element simply means "not yet"; only a broken selector throws.
      try {
        last = await runInPage(params.tabId, fnWaitProbe, probe)
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        if (/not a valid selector|is not a valid selector/iu.test(message)) throw error
        last = { found: false, detail: message }
      }
      // The tab may still be mid-navigation, which reports as no frame to script.
      if (last && last.found === true) return { found: true, elapsedMs: Date.now() - started, detail: last.detail }
      if (Date.now() - started >= timeoutMs) return { found: false, elapsedMs: Date.now() - started, detail: last?.detail || '' }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  },
  async 'page.screenshot'(params) {
    return capture(params.tabId)
  },
}

// ------------------------------------------------------------------- transport

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  try {
    socket.send(JSON.stringify(payload))
  } catch (error) {
    lastError = String(error && error.message ? error.message : error)
  }
}

async function handle(message) {
  const handler = METHODS[message.method]
  if (typeof handler !== 'function') {
    send({ id: message.id, ok: false, error: `unknown method "${message.method}"` })
    return
  }
  try {
    const result = await handler(message.params || {})
    send({ id: message.id, ok: true, result })
  } catch (error) {
    const text = error && error.message ? error.message : String(error)
    lastError = text
    send({ id: message.id, ok: false, error: text })
  }
}

/** Ask each host port for its socket url; the host answers on the port it actually bound. */
async function findHost() {
  // A reloaded plugin can leave its previous listener bound on an earlier port
  // for a moment, so probing in port order would attach this extension to a
  // bridge nothing drives any more. Ask every port and keep the newest.
  const probes = await Promise.all(HOST_PORTS.map(async (port) => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${CONFIG_PATH}`, { cache: 'no-store' })
      if (!response.ok) return undefined
      const body = await response.json()
      if (typeof body.wsUrl !== 'string' || body.wsUrl === '') return undefined
      return { wsUrl: body.wsUrl, startedAt: Number(body.startedAt) || 0 }
    } catch {
      // Not this port; the host may not have bound it.
      return undefined
    }
  }))
  const live = probes.filter((probe) => probe !== undefined)
  if (live.length === 0) return undefined
  live.sort((a, b) => b.startedAt - a.startedAt)
  return live[0].wsUrl
}

async function connect() {
  if (connecting) return connecting
  if (socket && socket.readyState === WebSocket.OPEN) {
    // A reloaded plugin leaves its previous listener bound for a moment, and
    // this extension may still be attached to it. Prefer the newest bridge and
    // move over; a live host that has not restarted keeps the same URL.
    const live = await findHost()
    if (live === undefined || live === socket.url) return socket
    try {
      socket.close(1000, 'moving to a newer host bridge')
    } catch {
      // Already gone; the close handler clears the slot.
    }
    socket = undefined
  }
  connecting = (async () => {
    const wsUrl = await findHost()
    if (wsUrl === undefined) {
      lastError = 'no DeepSeek Harness host answered on ' + HOST_PORTS.join(', ')
      return undefined
    }
    return new Promise((resolve) => {
      let settled = false
      let next
      try {
        next = new WebSocket(wsUrl)
      } catch (error) {
        lastError = String(error && error.message ? error.message : error)
        resolve(undefined)
        return
      }
      const settle = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      next.addEventListener('open', () => {
        socket = next
        lastError = undefined
        send({ type: 'hello', version: chrome.runtime.getManifest().version })
        chrome.storage.local.set({ status: 'connected', wsUrl, at: Date.now() })
        settle(next)
      })
      next.addEventListener('message', (event) => {
        let message
        try {
          message = JSON.parse(String(event.data))
        } catch {
          return
        }
        if (message && typeof message.id === 'string') void handle(message)
      })
      next.addEventListener('close', () => {
        if (socket === next) socket = undefined
        chrome.storage.local.set({ status: 'disconnected', at: Date.now() })
        settle(undefined)
      })
      next.addEventListener('error', () => {
        lastError = 'the harness closed the socket'
        settle(undefined)
      })
    })
  })().finally(() => {
    connecting = undefined
  })
  return connecting
}

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) void connect()
})
chrome.runtime.onStartup.addListener(() => void connect())
chrome.runtime.onInstalled.addListener(() => void connect())
void connect()

/** The popup asks for a fresh attempt, or for what the last one did. */
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'dsh-chrome-tab:connect') {
    void connect().then((live) => respond({ connected: live !== undefined, error: lastError }))
    return true
  }
  if (message?.type === 'dsh-chrome-tab:status') {
    respond({
      connected: socket !== undefined && socket.readyState === WebSocket.OPEN,
      // Which bridge this actually reached: a stale one on an older port looks
      // identical to a live one from the popup, so name it.
      url: socket?.url,
      error: lastError,
      ports: HOST_PORTS,
    })
    return false
  }
  return false
})
