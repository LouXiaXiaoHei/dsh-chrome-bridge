/**
 * The stale-bridge test: two `TabBridge` instances listen at once, exactly like
 * a hot-reloaded plugin whose previous instance still holds a port because a
 * live extension socket keeps `server.close()` pending. The extension must
 * notice the newer bridge (higher `startedAt`) on its next reconnect and move to
 * it instead of staying on the zombie it happened to reach first.
 *
 * This is the bug that made the @ menu say "not connected" while the extension
 * popup cheerfully reported a live socket: the extension was talking to a bridge
 * nobody drove any more.
 *
 * Usage:
 *   node test/beacon.mjs
 *
 * Environment:
 *   CHROME  path to a Chrome binary (default: /Applications/Google Chrome.app)
 *   KEEP    set to 1 to leave Chrome running
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TabBridge } from '../bridge.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXTENSION_ROOT = join(HERE, '..', 'extension')
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP_PORT = Number(process.env.CDP_PORT ?? 9337)
const KEEP = process.env.KEEP === '1'

let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/* ------------------------------------------------------------------ fixture */

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end('<!doctype html><title>beacon</title><h1>beacon</h1>')
})
await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
const pageUrl = `http://127.0.0.1:${server.address().port}/page`

/* ------------------------------------------------------------------- chrome */

const profileDir = mkdtempSync(join(tmpdir(), 'dsh-ct-beacon-'))
const chrome = spawn(CHROME, [
  `--user-data-dir=${profileDir}`,
  `--remote-debugging-port=${CDP_PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate',
  '--window-size=1100,800',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })
chrome.stdout.resume()
chrome.stderr.resume()

let older
let newer

const cleanup = async () => {
  await older?.dispose()
  await newer?.dispose()
  await new Promise((resolve) => { server.close(() => resolve()) })
  if (KEEP) return
  chrome.kill('SIGTERM')
  await sleep(600)
  try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
}

const waitForCdp = async () => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (response.ok) return await response.json()
    } catch {}
    await sleep(200)
  }
  throw new Error(`chrome did not open its debugging port on ${CDP_PORT}`)
}

const connectCdp = async (wsUrl) => {
  const ws = new WebSocket(wsUrl)
  let nextId = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const settle = pending.get(message.id)
    if (settle === undefined) return
    pending.delete(message.id)
    if (message.error === undefined) settle.resolve(message.result)
    else settle.reject(new Error(message.error.message ?? 'CDP error'))
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('could not open the CDP socket')), { once: true })
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  return { ws, send }
}

/* -------------------------------------------------------------------- run it */

try {
  const version = await waitForCdp()
  const cdp = await connectCdp(version.webSocketDebuggerUrl)

  const quiet = { log: () => {}, warn: console.warn, error: console.error }

  /* The older bridge starts first, exactly as a long-lived plugin would. */
  older = new TabBridge({ logger: quiet })
  const olderPort = await older.start()
  if (olderPort === undefined) throw new Error('every bridge port is taken')

  const installed = await cdp.send('Extensions.loadUnpacked', { path: EXTENSION_ROOT })
  console.log(`[beacon] extension installed as ${installed.id}`)

  const firstDeadline = Date.now() + 45_000
  while (!older.connected && Date.now() < firstDeadline) await sleep(300)
  check('the extension connects to the first bridge', older.connected, JSON.stringify(older.info))

  /* Now a second bridge appears — the hot-reloaded plugin. It must land on a
     different port, because the first one is still bound. */
  newer = new TabBridge({ logger: quiet })
  const newerPort = await newer.start()
  check('the second bridge gets a different port', newerPort !== undefined && newerPort !== olderPort,
    `${olderPort} vs ${newerPort}`)

  const config = await fetch(`http://127.0.0.1:${newerPort}/dsh-chrome-tab/config`).then((r) => r.json())
  check('the config beacon carries startedAt', Number.isFinite(config.startedAt), JSON.stringify(config))
  check('the newer bridge reports a later startedAt than the older one',
    config.startedAt > (Number(await fetch(`http://127.0.0.1:${olderPort}/dsh-chrome-tab/config`)
      .then((r) => r.json()).then((body) => body.startedAt))), String(config.startedAt))

  /* The extension polls every 30s, so give it a little over one period. The
     reconnect has to notice the newer beacon and move. */
  console.log('[beacon] waiting for the extension to migrate to the newer bridge…')
  const migrateDeadline = Date.now() + 75_000
  while (!newer.connected && Date.now() < migrateDeadline) await sleep(500)

  check('the extension moves to the newer bridge', newer.connected, JSON.stringify(newer.info))
  check('the older bridge loses the extension', !older.connected)

  if (newer.connected) {
    const created = await cdp.send('Target.createTarget', { url: pageUrl })
    await sleep(1200)
    const tabs = await newer.call('tabs.list', {}, { timeoutMs: 20_000 })
    const tab = tabs.tabs.find((entry) => entry.url.startsWith(pageUrl))
    check('the migrated bridge can list and drive tabs', tab !== undefined,
      JSON.stringify(tabs.tabs.map((entry) => entry.url)))
    check('the migrated bridge can read the page',
      tab !== undefined && (await newer.call('page.snapshot', { tabId: tab.id }, { timeoutMs: 20_000 })).title === 'beacon')
    void created
  }
} catch (error) {
  failures += 1
  console.log(`  FAIL ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await cleanup()
}

console.log(failures === 0 ? '\n[beacon] all checks passed' : `\n[beacon] ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
