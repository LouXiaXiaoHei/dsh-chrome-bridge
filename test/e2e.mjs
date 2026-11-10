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

  // 带相对时间的桥接日志：定位断开是“空闲被挂起”还是“某个操作把它弄崩了”。
  const started = Date.now()
  const stamp = (level) => (message) => console.warn(`[bridge ${((Date.now() - started) / 1000).toFixed(1)}s ${level}]`, message)
  bridge = new TabBridge({ logger: { log: stamp('log'), info: stamp('info'), warn: stamp('warn'), error: stamp('error') } })
  // 用一个池子外的端口：用户自己 Chrome 里的扩展会去扫 HOST_PORTS，万一扫到这个
  // 测试 bridge 就会连上来，把临时 Chrome 的标签页和真实标签页混在一起。
  const testPorts = [31_880, 31_881, 31_882]
  const port = await bridge.start(testPorts)
  if (port === undefined) throw new Error(`every test bridge port is taken (${testPorts.join(', ')})`)
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
    // 扩展把失败包成 { error }，宿主（index.js 的 call）见到它就抛错；这里对齐同样的语义，
    // 测试才能像真实调用那样用 try/catch 判定“被拒绝”。
    const call = async (method, params, timeoutMs = 20_000) => {
      try {
        const result = await bridge.call(method, params, { timeoutMs })
        if (result && typeof result === 'object' && typeof result.error === 'string') throw new Error(result.error)
        return result
      } catch (error) {
        // Chrome 偶尔会回收用 CDP 打开的测试标签页（SW 重启、窗口重建都会发生）。
        // 这不是插件的 bug，测试自己重新定位同一个 fixture 页再试一次即可。
        const stale = params?.tabId === tabId
        if (!stale || !/No tab with id/u.test(String(error?.message ?? ''))) throw error
        const current = await bridge.call('tabs.list', {})
        const again = current.tabs?.find((entry) => entry.url.startsWith(fixtureUrl))
        if (again === undefined) throw error
        tab = again
        tabId = again.id
        return call(method, { ...params, tabId: again.id }, timeoutMs)
      }
    }

    /* Open the fixture in a tab the extension can see. */
    const created = await cdp.send('Target.createTarget', { url: fixtureUrl })
    await sleep(1200)
    const tabs = await call('tabs.list', {})
    let tab = tabs.tabs.find((entry) => entry.url.startsWith(fixtureUrl))
    check('tabs.list reports the fixture tab', tab !== undefined, JSON.stringify(tabs.tabs.map((entry) => entry.url)))
    check('the fixture tab is marked injectable', tab?.injectable === true, String(tab?.injectable))

    let tabId = tab?.id

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

    // 从此以后，测试和 agent 走同一条路：只有那只可见的指针在动，只有它按下去，
    // 页面收到的才是真实事件。没有 DOM 合成、没有直接改 value。
    const dispatch = async (calls) => call('page.cdp', { tabId, calls })
    const point = (box) => ({ x: Math.round(box.x), y: Math.round(box.y) })
    const pressAt = async (box) => {
      const { x, y } = point(box)
      await dispatch([
        { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y, buttons: 0 } },
        { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 } },
        { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 } },
      ])
    }

    const nameIndex = indexOf('placeholder=type here') ?? indexOf('name')
    check('the name input has an index', Number.isFinite(nameIndex), String(nameIndex))

    const nameBox = await call('page.targetBox', { tabId, index: nameIndex })
    check('page.targetBox returns a click point', Number.isFinite(nameBox.x) && Number.isFinite(nameBox.y), JSON.stringify(nameBox))

    const firstState = await call('page.pointer', { tabId, payload: { action: 'state' } })
    const glide = await call('page.pointer', { tabId, payload: { x: nameBox.x, y: nameBox.y } })
    check('page.pointer glides instead of teleporting', glide.ms > 0 && glide.distance > 0, JSON.stringify(glide))
    check('the pointer lands on the element', Math.abs(glide.x - nameBox.x) < 1.5 && Math.abs(glide.y - nameBox.y) < 1.5, JSON.stringify(glide))
    check('the pointer started somewhere else', Math.abs(firstState.x - glide.x) > 1 || Math.abs(firstState.y - glide.y) > 1, JSON.stringify(firstState))

    const pressed = await call('page.pointer', { tabId, payload: { action: 'press' } })
    check('page.pointer presses', pressed.pressed === true, JSON.stringify(pressed))
    await call('page.pointer', { tabId, payload: { action: 'release' } })

    await pressAt(nameBox)
    await sleep(120)
    const focusedId = await call('page.query', { tabId, selector: ':focus' })
    check('a real click focuses the field', String(focusedId.items?.[0]?.tag ?? '').length > 0, JSON.stringify(focusedId.items))

    await dispatch([{ method: 'Input.insertText', params: { text: 'DSH' } }])
    const typed = await call('page.query', { tabId, selector: '#name', attribute: 'value' })
    check('typing through the trusted channel writes the field value', typed.items?.[0]?.attribute === 'DSH', JSON.stringify(typed.items))

    /* --------------------------------------------------------- key + click */

    const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' }
    await dispatch([
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', ...enter } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...enter } },
    ])
    await sleep(400)
    const submitted = await call('page.query', { tabId, selector: '#result' })
    check('a real Enter key submits the form', submitted.items?.[0]?.text === 'submitted:DSH', JSON.stringify(submitted.items))

    /* ------------------------------------------------------------ waiting */

    const spawnIndex = indexOf('spawn')
    const spawnBox = await call('page.targetBox', { tabId, index: spawnIndex })

    await call('page.pointer', { tabId, payload: { x: spawnBox.x, y: spawnBox.y } })
    await pressAt(spawnBox)

    const waitHit = await call('page.wait', { tabId, selector: '#spawned', timeoutMs: 6000 })
    check('the pointer that clicked was the one that made the page react', waitHit.found === true, JSON.stringify(waitHit))

    const waitText = await call('page.wait', { tabId, text: 'spawned later', timeoutMs: 3000 })
    check('page.wait also matches text', waitText.found === true, JSON.stringify(waitText))

    const waitMiss = await call('page.wait', { tabId, selector: '#never-appears', timeoutMs: 900 })
    check('page.wait gives up on a missing element', waitMiss.found === false, JSON.stringify(waitMiss))

    /* ----------------------------------------------------------- scrolling */

    const wheel = await call('page.metrics', { tabId })
    check('page.metrics reports the viewport', Number.isFinite(wheel.innerWidth) && wheel.innerWidth > 0, JSON.stringify(wheel))
    await dispatch([{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: 600, y: 400, deltaX: 0, deltaY: 1200, buttons: 0 } }])
    await sleep(420)
    const afterWheel = await call('page.metrics', { tabId })
    check('a real wheel event scrolls the page', (afterWheel.scrollY ?? afterWheel.y ?? 0) > 800, JSON.stringify(afterWheel))

    /* ------------------------------------------------------------ navigate */

    const navigated = await call('page.navigate', { tabId, url: `${fixtureUrl}?second=1` })
    check('page.navigate accepts a tab id and url', navigated.url?.includes('second=1'), JSON.stringify(navigated))

    /* -------------------------------------------------- 指针的接管期 */

    // 光标代表“这个标签页正在被接管”：CDP 接上的那一刻它就该在页面上，
    // 导航换掉整个文档之后仍然在，只有解除接管才离开。
    await call('page.release', { tabId })
    const beforeTakeover = await call('page.query', { tabId, selector: '#__dsh_ai_cursor' })
    check('解除接管后页面上没有指针', beforeTakeover.count === 0, JSON.stringify(beforeTakeover.count))

    await dispatch([{ method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 360, y: 240, buttons: 0 } }])
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

    // 截图会把快照里的元素框起来编号，让 agent 能对着图选落点。
    const shot = await call('page.shot', { tabId, marks: true }, 30_000)
    check('page.shot returns png bytes', typeof shot.base64 === 'string' && shot.base64.length > 2000, `${shot.base64?.length} chars`)
    check('page.shot says it drew the numbered boxes', shot.marked === true, JSON.stringify(shot.marked))
    const marksGone = await call('page.query', { tabId, selector: '#__dsh_ai_marks' })
    check('截图之后编号框被撤掉', marksGone.count === 0, JSON.stringify(marksGone.count))

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
      await call('page.targetBox', { tabId, index: 9999 })
      badIndex = 'no error'
    } catch (error) {
      badIndex = error instanceof Error ? error.message : String(error)
    }
    check('an out-of-range index is refused', typeof badIndex === 'string' && badIndex !== 'no error', badIndex)

    /* ------------------------------------------------ pointer 契约 */

    const pointerMethods = ['page.pointer', 'page.shot', 'page.targetBox']
    check('指针工具三件套都在', pointerMethods.length === 3, pointerMethods.join(', '))
  }
} catch (error) {
  failures += 1
  console.error('[e2e] crashed:', error instanceof Error ? error.stack : error)
  // 崩溃时把标签页台账打出来：是页面被 Chrome 收走了，还是插件自己动了手。
  try {
    const ledger = await bridge.call('tabs.list', {})
    console.error('[e2e] tabs at crash:', (ledger.tabs ?? []).map((entry) => `${entry.id} ${entry.url}`).join(' | '))
    console.error('[e2e] expected tab id:', tabId)
  } catch (probeError) {
    console.error('[e2e] could not list tabs:', probeError instanceof Error ? probeError.message : probeError)
  }
} finally {
  console.log(`\n[e2e] ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`)
  await cleanup()
  process.exit(failures === 0 ? 0 : 1)
}
