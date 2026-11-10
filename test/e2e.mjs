/**
 * End-to-end test: a real Chrome, a real copy of the extension, and a real
 * `TabBridge`. Nothing is mocked except the page content, which is served from
 * `test/fixture.html` on loopback so the run needs no network.
 *
 * Why it drives Chrome over CDP instead of by hand: `--load-extension` is
 * ignored by current Chrome builds, so the only reliable way to install an
 * unpacked extension programmatically is `Extensions.loadUnpacked`.
 *
 * Usage:
 *   node test/e2e.mjs
 *
 * Environment:
 *   CHROME  path to a Chrome binary (default: /Applications/Google Chrome.app)
 *   KEEP    set to 1 to leave Chrome and the fixture server running
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TabBridge } from '../bridge.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXTENSION_ROOT = join(HERE, '..', 'extension')
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const CDP_PORT = Number(process.env.CDP_PORT ?? 9336)
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

const fixture = await readFile(join(HERE, 'fixture.html'))
const server = createServer((req, res) => {
  if (req.url === '/fixture' || req.url?.startsWith('/fixture?')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(fixture)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})
await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
const fixtureUrl = `http://127.0.0.1:${server.address().port}/fixture`
console.log(`[e2e] fixture served at ${fixtureUrl}`)

/* ------------------------------------------------------------------- chrome */

const profileDir = mkdtempSync(join(tmpdir(), 'dsh-ct-e2e-'))
console.log(`[e2e] chrome profile ${profileDir}`)

const chrome = spawn(CHROME, [
  `--user-data-dir=${profileDir}`,
  `--remote-debugging-port=${CDP_PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate',
  '--window-size=1200,900',
  // Chrome's own sandbox cannot initialise inside a container that already holds
  // one parent sandbox (the classic case is an agent harness), and every renderer
  // then crash-loops: pages load but no script runs and the extension worker never
  // answers. Nothing here touches untrusted content, so its sandbox is not the
  // thing keeping this test honest.
  '--no-sandbox',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })
chrome.stdout.resume()
chrome.stderr.resume()

const cleanup = async () => {
  await bridge?.dispose()
  if (!KEEP) {
    chrome.kill('SIGKILL')
    server.close()
    await sleep(300)
    rmSync(profileDir, { recursive: true, force: true })
  }
}

let bridge
process.on('SIGINT', () => { void cleanup().then(() => process.exit(130)) })

/** Wait until the DevTools endpoint answers. */
const waitForCdp = async () => {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return await response.json()
    } catch {
      // Chrome is still starting.
    }
    await sleep(300)
  }
  throw new Error('Chrome never opened its DevTools endpoint')
}

/** Minimal CDP client over the browser websocket. */
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
  console.log('[e2e] chrome is up')
  const cdp = await connectCdp(version.webSocketDebuggerUrl)

  bridge = new TabBridge({ logger: { log: () => {}, warn: console.warn, error: console.error } })
  const port = await bridge.start()
  if (port === undefined) throw new Error('every bridge port is taken')
  console.log(`[e2e] bridge listening on 127.0.0.1:${port}`)

  // Pin the copy to this run's port. A real DSH install normally owns one of the
  // low ports in HOST_PORTS, and the extension always dials the first bridge that
  // answers — so an unmodified copy would connect to the developer's own session
  // instead of this test's bridge.
  const extensionCopy = join(profileDir, 'extension-under-test')
  cpSync(EXTENSION_ROOT, extensionCopy, { recursive: true })
  const backgroundPath = join(extensionCopy, 'background.js')
  const backgroundSource = readFileSync(backgroundPath, 'utf8')
  const pinned = backgroundSource.replace(/const HOST_PORTS = \[[^\]]*\]/u, `const HOST_PORTS = [\n  ${port},\n]`)
  if (pinned === backgroundSource) throw new Error('could not pin HOST_PORTS in the extension copy')
  writeFileSync(backgroundPath, pinned)

  const installed = await cdp.send('Extensions.loadUnpacked', { path: extensionCopy })
  console.log(`[e2e] extension installed as ${installed.id}`)

  const deadline = Date.now() + 45_000
  while (!bridge.connected && Date.now() < deadline) await sleep(300)
  check('the extension connects to the bridge', bridge.connected, JSON.stringify(bridge.info))

  if (bridge.connected) {
    const call = async (method, params, timeoutMs = 20_000) => bridge.call(method, params, { timeoutMs })

    /* Open the fixture in a tab the extension can see. */
    const created = await cdp.send('Target.createTarget', { url: fixtureUrl })
    await sleep(1200)
    const tabs = await call('tabs.list', {})
    const tab = tabs.tabs.find((entry) => entry.url.startsWith(fixtureUrl))
    check('tabs.list reports the fixture tab', tab !== undefined, JSON.stringify(tabs.tabs.map((entry) => entry.url)))
    check('the fixture tab is marked injectable', tab?.injectable === true, String(tab?.injectable))

    const tabId = tab?.id

    /* ---------------------------------------------------------- snapshot */

    const snapshot = await call('page.snapshot', { tabId, maxInteractive: 40, maxText: 2000 })
    check('snapshot reports the title', snapshot.title === 'DSH Chrome Tab fixture', String(snapshot.title))
    check('snapshot reports the url', snapshot.url === fixtureUrl, String(snapshot.url))
    check('snapshot is complete', snapshot.readyState === 'complete', String(snapshot.readyState))
    check('snapshot finds the h1', snapshot.headings.some((line) => line.includes('Bridge fixture')), JSON.stringify(snapshot.headings))
    check('snapshot numbers interactive elements', snapshot.interactive.length >= 6, String(snapshot.interactive.length))
    check('snapshot includes the name input', snapshot.interactive.some((line) => line.includes('input') && line.includes('placeholder="type here"')), JSON.stringify(snapshot.interactive.slice(0, 8)))
    check('snapshot includes the submit button', snapshot.interactive.some((line) => line.toLowerCase().includes('send')), JSON.stringify(snapshot.interactive.slice(0, 8)))
    check('snapshot reports scroll metrics', typeof snapshot.scroll?.height === 'number' && snapshot.scroll.height > 2400, JSON.stringify(snapshot.scroll))
    check('snapshot passes page text through', snapshot.text.includes('A page the end-to-end test can drive'), snapshot.text.slice(0, 80))

    /** Find the 1-based index of an interactive element by a substring of its line. */
    const indexOf = (needle) => {
      const line = snapshot.interactive.find((entry) => entry.toLowerCase().includes(needle))
      return line === undefined ? undefined : Number(line.slice(0, line.indexOf('.')))
    }

    /* ------------------------------------------------------------- typing */

    const nameIndex = indexOf('placeholder=type here') ?? indexOf('name')
    check('the name input has an index', Number.isFinite(nameIndex), String(nameIndex))

    const focused = await call('page.focus', { tabId, index: nameIndex })
    check('page.focus lands on an editable field', focused.editable === true, JSON.stringify(focused))

    await call('page.insertText', { tabId, text: 'DSH' })
    const typed = await call('page.query', { tabId, selector: '#name', attribute: 'value' })
    check('page.insertText writes the field value', typed.items?.[0]?.attribute === 'DSH', JSON.stringify(typed.items))

    /* --------------------------------------------------------- key + click */

    const submitIndex = indexOf('send')
    await call('page.focus', { tabId, index: submitIndex })
    await call('page.key', { tabId, key: 'Enter' })
    await sleep(400)
    const submitted = await call('page.query', { tabId, selector: '#result' })
    check('page.key Enter submits the form', submitted.items?.[0]?.text === 'submitted:DSH', JSON.stringify(submitted.items))

    /* ------------------------------------------------------------ waiting */

    const spawnIndex = indexOf('spawn')
    const spawnBox = await call('page.targetBox', { tabId, index: spawnIndex })
    check('page.targetBox returns a click point', Number.isFinite(spawnBox.x) && Number.isFinite(spawnBox.y), JSON.stringify(spawnBox))

    const spawned = await call('page.clickAt', { tabId, ...spawnBox })
    check('page.clickAt reports what it hit', String(spawned.hit ?? '').length > 0, JSON.stringify(spawned))

    const waitHit = await call('page.wait', { tabId, selector: '#spawned', timeoutMs: 6000 })
    check('page.wait waits for a delayed element', waitHit.found === true, JSON.stringify(waitHit))

    const waitText = await call('page.wait', { tabId, text: 'spawned later', timeoutMs: 3000 })
    check('page.wait also matches text', waitText.found === true, JSON.stringify(waitText))

    const waitMiss = await call('page.wait', { tabId, selector: '#never-appears', timeoutMs: 900 })
    check('page.wait gives up on a missing element', waitMiss.found === false, JSON.stringify(waitMiss))

    /* ----------------------------------------------------------- scrolling */

    const scrolled = await call('page.scroll', { tabId, amount: 1200 })
    check('page.scroll moves the page', scrolled.y > 800, JSON.stringify(scrolled))

    /* ------------------------------------------------------------ navigate */

    const navigated = await call('page.navigate', { tabId, url: `${fixtureUrl}?second=1` })
    check('page.navigate accepts a tab id and url', navigated.url?.includes('second=1'), JSON.stringify(navigated))

    /* -------------------------------------------------- 指针的接管期 */

    // 光标代表“这个标签页正在被接管”：CDP 接上的那一刻它就该在页面上，
    // 导航换掉整个文档之后仍然在，只有解除接管才离开。
    await call('page.release', { tabId })
    const beforeTakeover = await call('page.query', { tabId, selector: '#__dsh_ai_cursor' })
    check('解除接管后页面上没有指针', beforeTakeover.count === 0, JSON.stringify(beforeTakeover.count))

    await call('page.cdp', {
      tabId,
      calls: [{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 360, y: 240, buttons: 0 } }],
    })
    await sleep(400)
    const onAttach = await call('page.query', { tabId, selector: '#__dsh_ai_cursor' })
    check('CDP 接管的那一刻指针就在页面上', onAttach.count === 1, JSON.stringify(onAttach.count))

    await call('page.navigate', { tabId, url: `${fixtureUrl}?third=1` })
    await sleep(1800)
    const afterNav = await call('page.query', { tabId, selector: '#__dsh_ai_cursor' })
    check('导航换掉文档之后指针被补回来', afterNav.count === 1, JSON.stringify(afterNav.count))

    const engaged = await call('page.engage', { tabId })
    check('page.engage 报告接管成立与指针在位', engaged.attached === true && engaged.cursor?.ok === true, JSON.stringify(engaged))

    await call('page.release', { tabId })
    const afterRelease = await call('page.query', { tabId, selector: '#__dsh_ai_cursor' })
    check('解除接管后指针离开', afterRelease.count === 0, JSON.stringify(afterRelease.count))

    /* ---------------------------------------------------------- screenshot */

    const shot = await call('page.screenshot', { tabId }, 30_000)
    check('page.screenshot returns png bytes', typeof shot.base64 === 'string' && shot.base64.length > 2000, `${shot.base64?.length} chars`)

    /* --------------------------------------------------- refusal behaviour */

    let refused
    try {
      await call('page.snapshot', { tabId: 1 })
      refused = 'no error'
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error)
    }
    check('an unknown tab id is refused', typeof refused === 'string' && refused !== 'no error', refused)

    let badIndex
    try {
      await call('page.focus', { tabId, index: undefined })
      badIndex = 'no error'
    } catch (error) {
      badIndex = error instanceof Error ? error.message : String(error)
    }
    check(
      'a missing index is refused in words the model can act on',
      badIndex.includes('chrome_snapshot'),
      badIndex,
    )
  }
} catch (error) {
  failures += 1
  console.error('[e2e] crashed:', error instanceof Error ? error.stack : error)
} finally {
  console.log(`\n[e2e] ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`)
  await cleanup()
  process.exit(failures === 0 ? 0 : 1)
}
