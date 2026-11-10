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

  // 每个元素带上视口中心坐标：编号说明是哪几个，坐标说明点哪儿，agent 因此
  // 可以只凭截图和这份清单去驱动鼠标，而不必猜元素名。
  const boxes = []
  const lines = []
  for (let i = 0; i < elements.length; i += 1) {
    const element = elements[i]
    const rect = element.getBoundingClientRect()
    const cx = Math.round(rect.left + rect.width / 2)
    const cy = Math.round(rect.top + rect.height / 2)
    boxes.push({
      n: i + 1,
      x: cx,
      y: cy,
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    })
    let line = (i + 1) + '. ' + describe(element) + ' @' + cx + ',' + cy
    if (rect.bottom < 0) line += ' (above)'
    else if (rect.top > window.innerHeight) line += ' (below)'
    else if (rect.bottom > window.innerHeight || rect.left < 0) line += ' (partly offscreen)'
    lines.push(line)
  }

  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    headings,
    interactive: lines,
    boxes,
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
  // 页面里抛出的异常到了宿主那边会变成 result: undefined（Chrome 不给 InjectionResult.error），
  // 所以错误一律以对象形式返回，由宿主方法判定后再抛。
  if (!store || !store.elements) return { error: 'no snapshot on record; call chrome_snapshot first' }
  const element = store.elements[index - 1]
  if (!element) return { error: 'index ' + index + ' is not in the current snapshot (1-' + store.elements.length + ')' }
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
// 指针是这台插件唯一的手：页面上那只箭头就是执行输入的那只手。它只做装饰
// （pointer-events:none），位置记在 dataset 上，移动由 fnPointer 逐帧推动——
// CSS transition 只有视觉效果，宿主无法知道它什么时候真正落点，逐帧动画可以。
function fnCursor(payload) {
  // 涟漪逻辑必须内联：这个函数是整段序列化后注入页面的，模块作用域里的东西全都不在。
  const ripple = (target) => {
    const ring = target.querySelector('.__ring')
    if (!ring) return
    ring.style.animation = 'none'
    void ring.offsetWidth
    ring.style.animation = '__dsh_ai_ring 460ms ease-out'
  }
  const ID = '__dsh_ai_cursor'
  const STYLE_ID = '__dsh_ai_cursor_style'
  const p = payload || {}
  const existing = document.getElementById(ID)
  if (p.mode === 'release') {
    if (existing) existing.remove()
    const style = document.getElementById(STYLE_ID)
    if (style) style.remove()
    const marks = document.getElementById('__dsh_ai_marks')
    if (marks) marks.remove()
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
      '@keyframes __dsh_ai_ring{0%{opacity:.92;transform:scale(.2)}70%{opacity:.32}100%{opacity:0;transform:scale(1.75)}}',
      '#' + ID + '{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;width:0;height:0;',
      'will-change:transform;contain:layout style}',
      '#' + ID + ' .__arrow{width:20px;height:26px;transform-origin:2px 2px;transition:transform 90ms ease-out;',
      'filter:drop-shadow(0 0 1.8px rgba(255,255,255,.98)) drop-shadow(0 1px 3px rgba(0,0,0,.5))}',
      '#' + ID + '.__press .__arrow{transform:scale(.8);transition-duration:40ms}',
      '#' + ID + ' .__ring{position:absolute;left:0;top:0;width:32px;height:32px;margin:-16px 0 0 -16px;',
      'border-radius:50%;border:2.5px solid rgba(255,255,255,.95);opacity:0;pointer-events:none;',
      'box-shadow:0 0 0 1px rgba(0,0,0,.22) inset,0 0 8px rgba(255,255,255,.7)}',
    ].join('')
    ;(document.head || document.documentElement).appendChild(style)
  }

  const askedX = Number(p.x)
  const askedY = Number(p.y)
  const hasPoint = Number.isFinite(askedX) && Number.isFinite(askedY)
  let root = existing
  if (!root) {
    // 接管那一刻还没有任何操作，没人给出坐标，就落在视口中心——最不突兀的起点。
    const x = hasPoint ? askedX : Math.round(window.innerWidth / 2)
    const y = hasPoint ? askedY : Math.round(window.innerHeight / 2)
    root = document.createElement('div')
    root.id = ID
    root.setAttribute('aria-hidden', 'true')
    root.dataset.px = String(x)
    root.dataset.py = String(y)
    root.style.transform = 'translate3d(' + (x - 1.6) + 'px,' + (y - 1.2) + 'px,0)'
    root.innerHTML = '<div class="__arrow"><svg width="20" height="26" viewBox="0 0 20 26">'
      + '<path d="M2.2 1.4 L2.2 21.4 L7.4 16.4 L10.9 24.4 L14.3 22.9 L10.9 15 L17.6 14.6 Z" '
      + 'fill="#111111" stroke="#ffffff" stroke-width="1.9" stroke-linejoin="round"/></svg></div>'
      + '<span class="__ring"></span>'
    // 挂在 html 上而不是 body：单页应用首屏水合时经常整个替换 body，光标会跟着没。
    ;(document.documentElement || document.body).appendChild(root)
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
  } else if (hasPoint && root.dataset.anim !== '1') {
    // 一次明确的落点：动画没在跑就直接摆过去，跑了就让动画自己收尾。
    root.dataset.px = String(askedX)
    root.dataset.py = String(askedY)
    root.style.transform = 'translate3d(' + (askedX - 1.6) + 'px,' + (askedY - 1.2) + 'px,0)'
  }

  if (p.pressed === true) root.classList.add('__press')
  else if (p.pressed === false) root.classList.remove('__press')
  if (p.pulse === true) ripple(root)
  return { ok: true, created: existing === null, x: Number(root.dataset.px), y: Number(root.dataset.py) }
}

// 指针在这里真正移动：逐帧插值，宿主可以等它落点，也可以被下一次移动打断。
// 返回这次移动的起止点、距离和实际耗时，宿主据此等待，输入才会落在指针上。
async function fnPointer(options) {
  // 涟漪逻辑必须内联：这个函数是整段序列化后注入页面的，模块作用域里的东西全都不在。
  const ripple = (target) => {
    const ring = target.querySelector('.__ring')
    if (!ring) return
    ring.style.animation = 'none'
    void ring.offsetWidth
    ring.style.animation = '__dsh_ai_ring 460ms ease-out'
  }
  const ID = '__dsh_ai_cursor'
  const o = options || {}
  const action = String(o.action || 'glide')
  const el = document.getElementById(ID)
  if (!el) return { present: false, action }
  if (action === 'state') {
    return {
      present: true,
      x: Number(el.dataset.px),
      y: Number(el.dataset.py),
      pressed: el.classList.contains('__press'),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }
  }
  if (action === 'press' || action === 'release') {
    if (action === 'press') el.classList.add('__press')
    else el.classList.remove('__press')
    ripple(el)
    return { present: true, pressed: action === 'press', x: Number(el.dataset.px), y: Number(el.dataset.py) }
  }
  if (action === 'pulse') {
    ripple(el)
    return { present: true, x: Number(el.dataset.px), y: Number(el.dataset.py) }
  }

  const x = Number(o.x)
  const y = Number(o.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('pointer glide needs finite x and y')
  const fromX = Number(el.dataset.px)
  const fromY = Number(el.dataset.py)
  const sx = Number.isFinite(fromX) ? fromX : x
  const sy = Number.isFinite(fromY) ? fromY : y
  const distance = Math.hypot(x - sx, y - sy)
  const asked = Number(o.ms)
  const ms = Number.isFinite(asked) && asked >= 0
    ? Math.min(asked, 2000)
    : Math.max(180, Math.min(620, 170 + distance * 0.45))
  const token = (Number(el.dataset.token) || 0) + 1
  el.dataset.token = String(token)
  el.classList.remove('__press')
  const place = (px, py) => {
    el.dataset.px = px.toFixed(2)
    el.dataset.py = py.toFixed(2)
    el.style.transform = 'translate3d(' + (px - 1.6).toFixed(2) + 'px,' + (py - 1.2).toFixed(2) + 'px,0)'
  }
  const settle = (px, py) => {
    el.dataset.px = String(px)
    el.dataset.py = String(py)
  }
  const report = (used) => ({
    present: true,
    x,
    y,
    fromX: Math.round(sx),
    fromY: Math.round(sy),
    distance: Math.round(distance),
    ms: Math.round(used),
  })
  if (distance < 0.75 || ms === 0) {
    place(x, y)
    settle(x, y)
    return report(0)
  }
  place(sx, sy)
  el.dataset.anim = '1'
  await new Promise((resolve) => {
    const started = performance.now()
    const step = (now) => {
      // 期间又来了新的移动：让位，别把指针往回拽。
      if (Number(el.dataset.token) !== token || !el.isConnected) { resolve(); return }
      const t = Math.min(1, (now - started) / ms)
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
      place(sx + (x - sx) * eased, sy + (y - sy) * eased)
      if (t < 1) requestAnimationFrame(step)
      else resolve()
    }
    requestAnimationFrame(step)
  })
  if (Number(el.dataset.token) === token) place(x, y)
  settle(x, y)
  if (Number(el.dataset.token) === token) el.dataset.anim = ''
  return report(ms)
}

// 截图上的编号框：先选出要看的东西，再把它编号画在页面上，agent 看到的就是
// 一张带坐标的图。只在截图那一瞬间存在，取完立刻撤掉。
function fnMarks(options) {
  const HOST_ID = '__dsh_ai_marks'
  const o = options || {}
  const existing = document.getElementById(HOST_ID)
  if (existing) existing.remove()
  if (o.mode === 'hide') return { ok: true, hidden: existing !== null }
  const store = globalThis.__dshChromeTab
  const items = Array.isArray(o.items)
    ? o.items
    : store && Array.isArray(store.elements)
      ? store.elements.map((element, offset) => {
        const rect = element.getBoundingClientRect()
        return {
          n: offset + 1,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        }
      })
      : []
  const host = document.createElement('div')
  host.id = HOST_ID
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none'
  let drawn = 0
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] || {}
    const n = Number(item.n)
    const left = Number(item.left)
    const top = Number(item.top)
    const width = Number(item.width)
    const height = Number(item.height)
    if (!Number.isFinite(n) || !Number.isFinite(left) || !Number.isFinite(top)) continue
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) continue
    const box = document.createElement('div')
    box.style.cssText = 'position:fixed;left:' + left.toFixed(1) + 'px;top:' + top.toFixed(1) + 'px;'
      + 'width:' + width.toFixed(1) + 'px;height:' + height.toFixed(1) + 'px;'
      + 'border:2px solid rgba(255,45,85,.92);border-radius:4px;background:rgba(255,45,85,.10);'
      + 'box-sizing:border-box;pointer-events:none'
    const tag = document.createElement('span')
    tag.textContent = String(n)
    tag.style.cssText = 'position:absolute;left:-2px;top:-15px;min-width:16px;padding:0 3px;border-radius:8px;'
      + 'background:#ff2d55;color:#ffffff;font:700 10px/15px ui-monospace,SFMono-Regular,Menlo,monospace;'
      + 'text-align:center;box-shadow:0 0 0 1.5px rgba(255,255,255,.95);box-sizing:border-box'
    box.appendChild(tag)
    host.appendChild(box)
    drawn += 1
  }
  ;(document.documentElement || document.body).appendChild(host)
  return { ok: true, drawn }
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
  // 注入函数抛错时 Chrome 只把 result 置空、不报告原因：宁可报错，也不要静默返回 undefined。
  if (first.result === undefined) {
    throw new Error('the page function returned nothing; it probably threw (check the page console)')
  }
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
  // 指针是这台插件唯一的手：移动、按下、松开都由它来做，宿主等它真的到位
  // 之后才注入输入，所以用户看到的箭头和页面实际发生的事是同一件事。
  async 'page.pointer'(params) {
    const tabId = Number(params.tabId)
    if (!Number.isFinite(tabId)) throw new Error('page.pointer needs a numeric tabId')
    // 导演要动指针之前，指针得先存在：先造一只（已在就什么都不做）。
    await ensureCursor(tabId, {})
    return runInPage(tabId, fnPointer, params.payload || {})
  },
  // 截图前把编号框画在页面上，截完立刻撤掉：一次调用里完成，不会留残影。
  async 'page.shot'(params) {
    const tabId = Number(params.tabId)
    if (!Number.isFinite(tabId)) throw new Error('page.shot needs a numeric tabId')
    const tab = await chrome.tabs.get(tabId)
    await chrome.tabs.update(tabId, { active: true })
    await chrome.windows.update(tab.windowId, { focused: true })
    const wantMarks = params.marks === true
    if (wantMarks) await runInPage(tabId, fnMarks, {})
    try {
      // 先激活再画框再等重绘：视口尺寸在激活那一刻才稳定，框才不会画错位置。
      await new Promise((resolve) => setTimeout(resolve, 260))
      const shot = await capture(tabId)
      return wantMarks ? { base64: shot.base64, marked: true } : shot
    } finally {
      if (wantMarks) {
        try {
          await runInPage(tabId, fnMarks, { mode: 'hide' })
        } catch {
          // 页面可能已经跳走，框跟着文档一起没了。
        }
      }
    }
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
    const box = await runInPage(params.tabId, fnTargetBox, requireIndex(params.index))
    if (box && typeof box.error === 'string') throw new Error(box.error)
    return box
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
