// Prove the in-page pointer and the CDP input path end to end, in an isolated
// Chrome so the user's own browser is never touched.
//
// Usage:
//   node test/serve-probe.mjs &                       # fixtures on :8731
//   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
//     --user-data-dir=/tmp/ct --remote-debugging-port=9334 --no-sandbox about:blank &
//   node test/cdp-probe.mjs [url] [screenshot.png]
import { readFileSync, writeFileSync } from 'node:fs'

const PORT = Number(process.env.CDP_PORT ?? 9334)
const URL_UNDER_TEST = process.argv[2] ?? 'http://127.0.0.1:8731/'
const SHOT = process.argv[3] ?? 'test/probe-cursor.png'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('no page target; start Chrome with --remote-debugging-port first')

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = () => reject(new Error('cdp connect failed'))
})
let nextId = 1
const pending = new Map()
socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  const waiter = pending.get(message.id)
  if (waiter === undefined) return
  pending.delete(message.id)
  if (message.error) waiter.reject(new Error(message.error.message))
  else waiter.resolve(message.result)
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})

// The cursor lives in the extension, but the function is plain code: lift it out
// so this test drives exactly what ships.
const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8')
const start = source.indexOf('function fnCursor(payload) {')
const end = source.indexOf('\n// The pointer the user sees', start)
const fnSource = source.slice(start, source.indexOf('\n}\n', start) + 3)

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: URL_UNDER_TEST })
await sleep(1200)

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

const inject = (payload) => evaluate(`(() => { ${fnSource}; return fnCursor(${JSON.stringify(payload)}) })()`)

const centre = await evaluate(`(() => {
  const el = document.getElementById('btn')
  const box = el.getBoundingClientRect()
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
})()`)
console.log('button centre', centre)

await evaluate(`document.getElementById('hit').textContent = '-'`)
const shoot = async (path) => {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
  console.log('shot ->', path)
}

await inject({ x: centre.x, y: centre.y })
await sleep(320)
console.log('cursor injected at', centre)
await shoot(SHOT)

// Press and hold so the ripple and the pressed state are visible in a screenshot.
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centre.x, y: centre.y, buttons: 0 })
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: centre.x, y: centre.y, button: 'left', buttons: 1, clickCount: 1 })
await inject({ x: centre.x, y: centre.y, pressed: true, pulse: true })
await sleep(120)
await shoot(SHOT.replace('.png', '-press.png'))
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: centre.x, y: centre.y, button: 'left', buttons: 0, clickCount: 1 })

const summary = await evaluate(`(() => {
  const rows = window.__ev ?? []
  const bad = rows.filter((r) => r.trusted !== true).length
  return {
    total: rows.length,
    untrusted: bad,
    hit: document.getElementById('hit').textContent,
    types: [...new Set(rows.map((r) => r.t))].join(','),
  }
})()`)
console.log(summary)
console.log(summary.untrusted === 0 && summary.total > 0 ? 'cdp + in-page cursor ok' : 'FAILED')
socket.close()
