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
    register: (route) => {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
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

const expectedRoutes = ['/dsh-chrome-tab/tabs', '/dsh-chrome-tab/select', '/dsh-chrome-tab/status', '/dsh-chrome-tab/install']
for (const path of expectedRoutes) check(`route ${path} registered`, routes.has(path))

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

for (const { cleanup } of effects.reverse()) {
  if (typeof cleanup === 'function') await cleanup()
}
check('no warnings during apply', warnings.length === 0, warnings.join('; '))

const failed = results.filter((ok) => ok !== true).length
console.log('')
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
