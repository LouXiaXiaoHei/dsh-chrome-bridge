/**
 * Loopback smoke test for the hand-written WebSocket server in `bridge.js`.
 *
 * It stands in for the Chrome extension: connects with a stock `ws` client,
 * exercises the handshake, hello frame, a request/response round trip, an error
 * reply and a concurrent second call. Run with `node test/bridge.test.js`.
 */

import WebSocket from '/Users/howard/.dsh/profiles/desktop/node_modules/ws/index.js'

import { TabBridge } from '../bridge.js'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

const bridge = new TabBridge({ logger: { info: () => {}, warn: (message) => console.log('warn:', message) } })
const port = await bridge.start()
check('binds a port', typeof port === 'number', String(port))
check('wsUrl points at the bound port', typeof bridge.wsUrl === 'string' && bridge.wsUrl.includes(String(port)), bridge.wsUrl)
check('reports disconnected before any client', bridge.connected === false)

// The config route is how the extension discovers which port to dial.
const configResponse = await fetch(`http://127.0.0.1:${port}/dsh-chrome-tab/config`)
const config = await configResponse.json()
check('config route serves the socket url', config.wsUrl === bridge.wsUrl, JSON.stringify(config))

const socket = new WebSocket(bridge.wsUrl, { origin: 'chrome-extension://abcdefghijklmnop' })
await new Promise((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})
check('extension handshake accepted', true)
check('connected after handshake', bridge.connected === true)

// A hello frame is how the extension announces its version.
socket.send(JSON.stringify({ type: 'hello', version: '9.9.9' }))

const seen = []
socket.on('message', async (raw) => {
  const message = JSON.parse(raw.toString())
  seen.push(message)
  if (message.method === 'tabs.list') {
    socket.send(JSON.stringify({
      id: message.id,
      ok: true,
      result: { tabs: [{ id: 123456, windowId: 1, title: '哔哩哔哩', url: 'https://www.bilibili.com/', active: true, injectable: true }] },
    }))
    return
  }
  if (message.method === 'page.boom') {
    socket.send(JSON.stringify({ id: message.id, ok: false, error: 'tab 1 is refocused' }))
    return
  }
  if (message.method === 'page.slow') {
    setTimeout(() => socket.send(JSON.stringify({ id: message.id, ok: true, result: { slow: true } })), 60)
  }
})

const listing = await bridge.call('tabs.list', {}, { timeoutMs: 3000 })
check('request/response round trip', listing?.tabs?.[0]?.id === 123456, JSON.stringify(listing))

// Two calls in flight must not cross their ids.
const [first, second] = await Promise.all([
  bridge.call('page.slow', {}, { timeoutMs: 3000 }),
  bridge.call('tabs.list', {}, { timeoutMs: 3000 }),
])
check('concurrent calls keep their ids', first?.slow === true && second?.tabs?.length === 1)

let failure
try {
  await bridge.call('page.boom', {}, { timeoutMs: 3000 })
} catch (error) {
  failure = error
}
check('an error reply rejects the call', failure?.message === 'tab 1 is refocused', String(failure?.message))

await new Promise((resolve) => setTimeout(resolve, 30))
check('hello frame recorded the extension version', bridge.info?.version === '9.9.9', JSON.stringify(bridge.info))

socket.close()
await new Promise((resolve) => setTimeout(resolve, 120))
check('disconnect is observed', bridge.connected === false)

await bridge.dispose()
console.log('')
const failed = results.filter((entry) => entry.ok !== true)
console.log(`${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)
