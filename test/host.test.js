/**
 * Host-half dry run: `apply()` is driven by a stand-in context so the tool and
 * route registrations can be inspected without a running Harness.
 *
 * It proves the module imports cleanly, registers every advertised tool with a
 * usable schema, and never touches the network until a tool actually runs.
 *
 * The host probes sibling bridge ports to explain a missing extension, so the
 * global `fetch` is stubbed out first: a unit test must not care which other
 * DeepSeek Harness instances happen to be running on this machine.
 */

globalThis.fetch = async () => {
  throw new Error('offline in unit tests')
}

const effects = []
const tools = new Map()
const routes = new Map()
const upgrades = new Map()
const warnings = []

const ctx = {
  logger: { info: () => {}, warn: (message) => warnings.push(message) },
  effect: (factory, label) => {
    const cleanup = factory()
    effects.push({ label, cleanup })
    return () => {}
  },
  tools: {
    register: (definition) => {
      if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
      tools.set(definition.name, definition)
      return () => {}
    },
  },
  webServer: {
    port: 55271,
    getOrigin: () => 'http://127.0.0.1:55271',
    register: (route) => {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => {}
    },
    registerUpgrade: (route) => {
      if (upgrades.has(route.path)) throw new Error(`duplicate upgrade route ${route.path}`)
      upgrades.set(route.path, route)
      return () => {}
    },
  },
}

const { apply } = await import('../index.js')
apply(ctx, { snapshotMaxChars: 20000, maxInteractiveItems: 60, toolTimeoutMs: 60000 })

const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

check('apply registered effects', effects.length >= 6, `${effects.length} effects`)

const expectedTools = [
  'chrome_tabs', 'chrome_snapshot', 'chrome_click', 'chrome_click_at', 'chrome_type', 'chrome_press',
  'chrome_scroll', 'chrome_open', 'chrome_query', 'chrome_wait', 'chrome_screenshot',
]
for (const name of expectedTools) {
  check(`tool ${name} registered`, tools.has(name))
}

for (const [name, definition] of tools) {
  const parameters = definition.parameters ?? {}
  const required = Object.entries(parameters)
    .filter(([, value]) => value?.required === true)
    .map(([key]) => key)
  check(`tool ${name} has a description`, typeof definition.description === 'string' && definition.description.length > 20,
    `${definition.description.length} chars${required.length === 0 ? '' : `, requires ${required.join(',')}`}`)
  check(`tool ${name} has an output renderer`, typeof definition.output?.render === 'function'
    && typeof definition.execute === 'function')
}

check('every tool declares a timeout', [...tools.values()].every((definition) => typeof definition.timeoutMs === 'number'))

const expectedRoutes = [
  '/dsh-chrome-tab/tabs', '/dsh-chrome-tab/select', '/dsh-chrome-tab/status', '/dsh-chrome-tab/install',
  '/dsh-chrome-tab/control', '/dsh-chrome-tab/preview', '/dsh-chrome-tab/focus',
]
for (const path of expectedRoutes) check(`route ${path} registered`, routes.has(path))
check('preview upgrade route registered', upgrades.has('/dsh-chrome-tab/preview'))

// A tool call before the extension connects must explain how to fix it, not crash.
let toolError
try {
  await tools.get('chrome_tabs').execute({}, { signal: new AbortController().signal })
} catch (error) {
  toolError = error
}
check('chrome_tabs explains a missing extension',
  typeof toolError?.message === 'string' && toolError.message.includes('chrome://extensions'),
  toolError?.message?.slice(0, 90))

// The tab list route must answer even while disconnected, because the @ menu polls it.
let routeStatus
let routeBody
await routes.get('/dsh-chrome-tab/tabs').handler(
  { method: 'GET', url: '/dsh-chrome-tab/tabs' },
  { writeHead: (status) => { routeStatus = status }, end: (body) => { routeBody = body } },
)
check('tab list route answers while disconnected', routeStatus === 200 && JSON.parse(routeBody).connected === false, routeBody)

// 接管：换成用户，工具必须立刻停手；换回 agent 之后原错误应该回来。
const callRoute = async (path, method = 'GET', body) => {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const request = {
    method,
    url: path,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  let status
  let payload
  await routes.get(path).handler(request, {
    writeHead: (code) => { status = code },
    end: (text) => { payload = text },
  })
  return { status, body: payload === undefined ? undefined : JSON.parse(payload) }
}

const initialControl = await callRoute('/dsh-chrome-tab/control')
check('control starts with the agent', initialControl.status === 200 && initialControl.body.owner === 'agent', JSON.stringify(initialControl.body))

const takeover = await callRoute('/dsh-chrome-tab/control', 'POST', { owner: 'user' })
check('control can be handed to the user', takeover.status === 200 && takeover.body.owner === 'user' && takeover.body.generation === 1, JSON.stringify(takeover.body))

let takeoverError
try {
  await tools.get('chrome_tabs').execute({}, { signal: new AbortController().signal })
} catch (error) {
  takeoverError = error
}
check('tools refuse to run while the user has control',
  typeof takeoverError?.message === 'string' && takeoverError.message.includes('接管'), takeoverError?.message?.slice(0, 80))

const handback = await callRoute('/dsh-chrome-tab/control', 'POST', { owner: 'agent' })
check('control can be handed back', handback.status === 200 && handback.body.owner === 'agent' && handback.body.generation === 2, JSON.stringify(handback.body))

let afterHandback
try {
  await tools.get('chrome_tabs').execute({}, { signal: new AbortController().signal })
} catch (error) {
  afterHandback = error
}
check('tools work again after the handback',
  typeof afterHandback?.message === 'string' && afterHandback.message.includes('chrome://extensions'), afterHandback?.message?.slice(0, 80))

const badOwner = await callRoute('/dsh-chrome-tab/control', 'POST', { owner: 'nobody' })
check('control rejects an unknown owner', badOwner.status === 400 && badOwner.body.ok === false, JSON.stringify(badOwner.body))

// 后台标签页 Chrome 不合成画面，面板上的「切到 Chrome」靠这条路由换回前台。
const focusRead = await callRoute('/dsh-chrome-tab/focus')
check('focus route answers a read', focusRead.status === 200 && focusRead.body.ok === true, JSON.stringify(focusRead.body))

const focusBad = await callRoute('/dsh-chrome-tab/focus', 'POST', { tabId: 'abc' })
check('focus route rejects a non-numeric tab', focusBad.status === 400 && focusBad.body.ok === false, JSON.stringify(focusBad.body))

const focusOffline = await callRoute('/dsh-chrome-tab/focus', 'POST', { tabId: 12345 })
check('focus route reports a missing extension', focusOffline.status === 502 && typeof focusOffline.body.error === 'string', JSON.stringify(focusOffline.body))

const status = await callRoute('/dsh-chrome-tab/status')
check('status reports control and preview', status.status === 200 && status.body.control?.owner === 'agent' && typeof status.body.preview?.frames === 'number', JSON.stringify({ control: status.body.control, preview: status.body.preview }))
// 桌面版的页面跑在自定义协议上，同源推断出的 ws://app/... 不可解析：
// 面板必须能从状态接口拿到这条绝对地址。
check('status advertises an absolute preview socket', status.body.preview?.wsUrl === 'ws://127.0.0.1:55271/dsh-chrome-tab/preview', status.body.preview?.wsUrl)

for (const { cleanup } of effects.reverse()) {
  if (typeof cleanup === 'function') await cleanup()
}
check('no warnings during apply', warnings.length === 0, warnings.join('; '))

const failed = results.filter((ok) => ok !== true).length
console.log('')
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
