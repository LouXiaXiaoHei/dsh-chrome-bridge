/**
 * Smoke test against a real site with a real Chrome.
 *
 * `e2e.mjs` drives a local fixture so it can assert exact strings. This one opens
 * whatever URL you give it (the Bilibili link from the feature request by default)
 * and shows what the model would actually receive, which is the only honest way to
 * see whether the snapshot survives a heavy SPA.
 *
 *   node test/smoke.mjs [url]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TabBridge } from '../bridge.js'

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const EXTENSION_ROOT = new URL('../extension', import.meta.url).pathname
const CDP_PORT = Number(process.env.CDP_PORT || 9337)
const PAGE_URL = process.argv[2] || 'https://www.bilibili.com/?spm_id_from=333.1365.0.0'
const KEEP = process.env.KEEP === '1'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const profile = mkdtempSync(join(tmpdir(), 'dsh-ct-smoke-'))
let chrome
let bridge
let socket

function log(...args) {
  console.log('[smoke]', ...args)
}

async function waitForCdp(deadlineMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (response.ok) return (await response.json()).webSocketDebuggerUrl
    } catch {}
    await sleep(250)
  }
  throw new Error(`Chrome did not expose CDP on ${CDP_PORT}`)
}

async function connectCdp(url) {
  const ws = new WebSocket(url)
  const pending = new Map()
  let nextId = 1
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true })
  })
  ws.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data)
    const slot = pending.get(payload.id)
    if (slot === undefined) return
    pending.delete(payload.id)
    if (payload.error) slot.reject(new Error(payload.error.message))
    else slot.resolve(payload.result)
  })
  return {
    send(method, params = {}) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    close() {
      ws.close()
    },
  }
}

async function cleanup() {
  try {
    await bridge?.dispose()
  } catch {}
  try {
    socket?.close()
  } catch {}
  if (!KEEP) {
    chrome?.kill('SIGKILL')
    await sleep(400)
    rmSync(profile, { recursive: true, force: true })
  }
}

let failures = 0

try {
  chrome = spawn(
    CHROME,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${CDP_PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  const cdpUrl = await waitForCdp()
  socket = await connectCdp(cdpUrl)
  log('chrome is up')

  bridge = new TabBridge({ logger: { info: log, warn: log, error: log } })
  const port = await bridge.start()
  log(`bridge listening on 127.0.0.1:${port}`)

  const loaded = await socket.send('Extensions.loadUnpacked', { path: EXTENSION_ROOT })
  log(`extension installed as ${loaded.id}`)

  const deadline = Date.now() + 45_000
  while (!bridge.connected && Date.now() < deadline) await sleep(200)
  if (!bridge.connected) throw new Error('the extension never connected')

  await socket.send('Target.createTarget', { url: PAGE_URL })
  log(`opened ${PAGE_URL}`)
  await sleep(3500)

  const tabs = await bridge.call('tabs.list', {}, { timeoutMs: 15_000 })
  const tab = tabs.tabs.find((entry) => entry.url.startsWith('https://www.bilibili.com')) ?? tabs.tabs[0]
  log(`driving tab ${tab.id} — ${tab.title}`)

  const snapshot = await bridge.call(
    'page.snapshot',
    { tabId: tab.id, maxInteractive: 60, maxText: 1500 },
    { timeoutMs: 30_000 },
  )

  console.log('\n--- what the model would see ---')
  console.log('title:      ', snapshot.title)
  console.log('url:        ', snapshot.url)
  console.log('headings:   ', JSON.stringify(snapshot.headings))
  console.log('scroll:     ', JSON.stringify(snapshot.scroll))
  console.log(`interactive (${snapshot.interactive.length}${snapshot.interactiveTruncated ? '+' : ''}):`)
  for (const line of snapshot.interactive.slice(0, 12)) console.log('  ', line)
  console.log('text:       ', String(snapshot.text).replace(/\s+/gu, ' ').slice(0, 260), '…')
  console.log('---\n')

  const checks = [
    ['the real page reports a title', typeof snapshot.title === 'string' && snapshot.title.length > 0],
    ['the real page reports its url', String(snapshot.url).includes('bilibili.com')],
    ['the real page finished loading', snapshot.readyState === 'complete'],
    ['the snapshot finds interactive elements', snapshot.interactive.length >= 5],
    ['the snapshot carries page text', String(snapshot.text).length > 100],
  ]
  for (const [label, ok] of checks) {
    if (!ok) failures += 1
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`)
  }
} catch (error) {
  failures += 1
  console.error('[smoke] crashed:', error instanceof Error ? error.stack : error)
} finally {
  console.log(`\n[smoke] ${failures === 0 ? 'passed' : `${failures} check(s) failed`}`)
  await cleanup()
  process.exit(failures === 0 ? 0 : 1)
}
