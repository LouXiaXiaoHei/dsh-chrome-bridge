/**
 * Live harness: run a real `TabBridge` outside DeepSeek Harness so the browser
 * extension can connect to it and the whole wire protocol can be exercised
 * before the host plugin itself is loaded.
 *
 * Usage:
 *   node test/live.mjs              # list tabs, then snapshot the active one
 *   node test/live.mjs <tabId>      # list tabs, then snapshot that tab
 *
 * It prints every frame it sends and receives, so a failure points at the
 * extension, the bridge, or the page rather than at DSH.
 */

import { TabBridge } from '../bridge.js'

const WAIT_MS = Number(process.env.WAIT_MS ?? 240_000)
const wanted = process.argv[2] === undefined ? undefined : Number(process.argv[2])

const bridge = new TabBridge({ logger: console })

process.on('SIGINT', () => { void bridge.dispose().then(() => process.exit(130)) })

const port = await bridge.start()
if (port === undefined) {
  console.log('[live] FAIL every bridge port is taken (30795, 30796, 30797)')
  process.exit(1)
}
console.log(`[live] bridge is listening on http://127.0.0.1:${port}/dsh-chrome-tab/config`)
console.log('[live] waiting for the extension to connect…')

const deadline = Date.now() + WAIT_MS
while (!bridge.connected && Date.now() < deadline) {
  await new Promise((resolve) => { setTimeout(resolve, 500) })
}

if (!bridge.connected) {
  console.log(`[live] FAIL no extension connected in ${Math.round(WAIT_MS / 1000)}s`)
  await bridge.dispose()
  process.exit(1)
}

console.log('[live] extension connected:', JSON.stringify(bridge.info))

const step = async (label, method, params, timeoutMs = 20_000) => {
  process.stdout.write(`\n[live] ${label} → ${method} ${JSON.stringify(params)}\n`)
  try {
    const result = await bridge.call(method, params, { timeoutMs })
    process.stdout.write(`[live] ${label} ok\n${JSON.stringify(result, null, 2)}\n`)
    return result
  } catch (error) {
    process.stdout.write(`[live] ${label} FAIL ${error instanceof Error ? error.message : String(error)}\n`)
    return undefined
  }
}

await step('ping', 'ping', {})
const list = await step('tabs', 'tabs.list', {})
if (list === undefined) {
  await bridge.dispose()
  process.exit(1)
}

const tabs = Array.isArray(list.tabs) ? list.tabs : []
const target = wanted ?? tabs.find((tab) => tab.active && tab.injectable !== false)?.id
if (target === undefined) {
  console.log('[live] no drivable tab to snapshot')
  await bridge.dispose()
  process.exit(1)
}

await step('snapshot', 'page.snapshot', { tabId: target, maxInteractive: 20, maxText: 600 })
await step('text', 'page.query', { tabId: target, selector: 'body', limit: 1 })

console.log('\n[live] done; bridge stays up for 5s')
await new Promise((resolve) => { setTimeout(resolve, 5000) })
await bridge.dispose()
process.exit(0)
