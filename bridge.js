/**
 * Loopback WebSocket endpoint the Chrome extension dials, plus the discovery
 * beacon that tells it which port to dial.
 *
 * The harness web server binds a fresh system-assigned port on every launch and
 * an extension cannot read the filesystem, so this module owns a tiny listener
 * on a small, fixed set of loopback ports instead: the first free candidate
 * serves both `GET /dsh-chrome-tab/config` (the discovery answer) and the
 * WebSocket upgrade. Nothing here depends on the harness port, and a second
 * harness instance simply takes the next candidate.
 *
 * Frames are spoken directly rather than through a dependency: the bridge only
 * needs text frames, ping/pong and close, and a zero-dependency package can
 * never fail to install.
 *
 * @module
 */

import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

/**
 * Loopback ports the extension probes, in order. Compiled into the extension too.
 *
 * The pool is generous on purpose: a hot-reloaded plugin leaves its previous
 * listener bound until that instance is disposed, and a stale listener that
 * still holds a live socket can outlive several reloads. Three candidates ran
 * out during ordinary development; eleven do not.
 */
export const BRIDGE_PORTS = [
  30795, 30796, 30797, 30798, 30799, 30800, 30801, 30802, 30803, 30804, 30805,
]

/** Path the extension fetches for the live WebSocket URL. */
export const CONFIG_PATH = '/dsh-chrome-tab/config'

/** Path the extension upgrades to a WebSocket. */
export const SOCKET_PATH = '/dsh-chrome-tab/bridge'

const HOST = '127.0.0.1'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/**
 * Calls that may be sent again after a dropped connection without changing the page.
 *
 * Chrome restarts an extension's service worker now and then, which drops the socket and
 * fails whatever was in flight. Re-sending a read is free; re-sending a click is not, so
 * anything that touches the page as a side effect stays out of this set and fails loudly.
 */
const RETRY_SAFE = new Set([
  'ping',
  'tabs.list',
  'tabs.get',
  'page.snapshot',
  'page.query',
  'page.wait',
  'page.metrics',
  'page.targetBox',
  'page.shot',
  'page.cursor',
  // 指针动作是幂等的（滑到某点、按下、抬起），重发一次不会让页面多做一件事。
  'page.pointer',
])

const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa }

/** Encode one unmasked server frame. */
export function encodeFrame(opcode, payload) {
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

/** One accepted socket: incremental frame decoding and lifetime events. */
export class Peer {
  #socket
  #buffer = Buffer.alloc(0)
  #fragments = []
  #fragmentOpcode = 0
  #closed = false
  #onMessage
  #onClose

  constructor(socket, head, { onMessage, onClose }) {
    this.#socket = socket
    this.#onMessage = onMessage
    this.#onClose = onClose
    socket.setNoDelay(true)
    socket.on('data', (chunk) => this.#push(chunk))
    socket.on('error', () => this.#shutdown())
    socket.on('close', () => this.#shutdown())
    if (head !== undefined && head.length > 0) this.#push(head)
  }

  get closed() {
    return this.#closed
  }

  #push(chunk) {
    if (this.#closed) return
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    try {
      this.#drain()
    } catch {
      this.close(1002, 'protocol error')
    }
  }

  #drain() {
    for (;;) {
      const buffer = this.#buffer
      if (buffer.length < 2) return
      const first = buffer[0]
      const second = buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let cursor = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        cursor = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        length = Number(buffer.readBigUInt64BE(2))
        cursor = 10
      }
      const maskAt = cursor
      if (masked) {
        if (buffer.length < cursor + 4) return
        cursor += 4
      }
      if (buffer.length < cursor + length) return
      let payload = buffer.subarray(cursor, cursor + length)
      if (masked) {
        const mask = buffer.subarray(maskAt, maskAt + 4)
        const unmasked = Buffer.allocUnsafe(length)
        for (let index = 0; index < length; index += 1) unmasked[index] = payload[index] ^ mask[index & 3]
        payload = unmasked
      } else {
        payload = Buffer.from(payload)
      }
      this.#buffer = buffer.subarray(cursor + length)
      this.#handle(fin, opcode, payload)
      if (this.#closed) return
    }
  }

  #handle(fin, opcode, payload) {
    if (opcode === OPCODE.close) {
      this.close(1000, '')
      return
    }
    if (opcode === OPCODE.ping) {
      this.#write(encodeFrame(OPCODE.pong, payload))
      return
    }
    if (opcode === OPCODE.pong) return
    if (opcode === OPCODE.text || opcode === OPCODE.binary) {
      if (fin) {
        this.#deliver(payload)
        return
      }
      this.#fragmentOpcode = opcode
      this.#fragments = [payload]
      return
    }
    if (opcode === OPCODE.continuation && this.#fragmentOpcode !== 0) {
      this.#fragments.push(payload)
      if (!fin) return
      const joined = Buffer.concat(this.#fragments)
      this.#fragments = []
      this.#fragmentOpcode = 0
      this.#deliver(joined)
    }
  }

  #deliver(payload) {
    const text = payload.toString('utf8')
    try {
      this.#onMessage(text)
    } catch {
      // A throwing handler must not tear down the transport.
    }
  }

  #write(buffer) {
    if (this.#closed) return
    try {
      this.#socket.write(buffer)
    } catch {
      this.#shutdown()
    }
  }

  send(text) {
    this.#write(encodeFrame(OPCODE.text, Buffer.from(text, 'utf8')))
  }

  /** 预览流走二进制：一帧 JPEG 原样下发，不 base64，省掉三分之一体积和一次解码。 */
  sendBinary(buffer) {
    this.#write(encodeFrame(OPCODE.binary, buffer))
  }

  ping() {
    this.#write(encodeFrame(OPCODE.ping, Buffer.alloc(0)))
  }

  close(code = 1000, reason = '') {
    if (this.#closed) return
    const body = Buffer.alloc(2 + Buffer.byteLength(reason))
    body.writeUInt16BE(code, 0)
    body.write(reason, 2)
    this.#write(encodeFrame(OPCODE.close, body))
    this.#shutdown()
  }

  #shutdown() {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#socket.destroy()
    } catch {
      // Already gone.
    }
    this.#onClose?.()
  }
}

/**
 * Owns the extension connection: discovery, the socket, and request/response
 * correlation. One extension may be connected at a time; a newer connection
 * replaces the older one, which is what a reloaded service worker looks like.
 */
export class TabBridge {
  #server
  #peer
  #pending = new Map()
  #waiters = []
  #heartbeat
  #port
  #info = undefined
  #logger
  #startedAt = undefined
  #listeners = new Set()

  constructor({ logger } = {}) {
    this.#logger = logger
  }

  get port() {
    return this.#port
  }

  /** When this instance bound its port; a newer instance wins a contested extension. */
  get startedAt() {
    return this.#startedAt
  }

  get connected() {
    return this.#peer !== undefined && !this.#peer.closed
  }

  /** What the extension last reported about itself, for status surfaces. */
  get info() {
    return this.#info
  }

  /**
   * Listen for events the extension pushes on its own.
   *
   * 请求/响应只覆盖“宿主问、扩展答”；画面帧没有对应的问句，所以走这条旁路。
   * 一个订阅者抛错不能拖垮传输，也不能让别的订阅者漏掉同一帧。
   *
   * @param listener - called with the event name and its payload.
   * @returns the disposer removing the subscription.
   */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #emit(name, data) {
    for (const listener of this.#listeners) {
      try {
        listener(name, data)
      } catch {
        // 订阅者是宿主自己的代码；它坏了不该影响扩展这一侧。
      }
    }
  }

  /** WebSocket URL the extension should dial, or undefined before `start`. */
  get wsUrl() {
    return this.#port === undefined ? undefined : `ws://${HOST}:${this.#port}${SOCKET_PATH}`
  }

  /** Bind the first free candidate port. Resolves the bound port, or undefined. */
  async start(ports = BRIDGE_PORTS) {
    for (const port of ports) {
      const server = createServer((request, response) => this.#handleHttp(request, response))
      server.on('upgrade', (request, socket, head) => this.#handleUpgrade(request, socket, head))
      const bound = await new Promise((resolve) => {
        const onError = (error) => {
          server.removeListener('listening', onListening)
          server.close()
          if (error?.code !== 'EADDRINUSE' && error?.code !== 'EACCES') {
            this.#logger?.warn?.(`chrome-tab: listener on ${port} failed: ${String(error)}`)
          }
          resolve(false)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          server.on('error', (error) => this.#logger?.warn?.(`chrome-tab: listener error: ${String(error)}`))
          resolve(true)
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, HOST)
      })
      if (!bound) continue
      this.#server = server
      this.#port = port
      this.#startedAt = Date.now()
      this.#logger?.info?.(`chrome-tab: bridge listening on ${this.wsUrl}`)
      return port
    }
    this.#logger?.warn?.(`chrome-tab: no free bridge port among ${ports.join(', ')}`)
    return undefined
  }

  #handleHttp(request, response) {
    const path = (request.url ?? '').split('?')[0]
    if (request.method !== 'GET' || path !== CONFIG_PATH) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }
    const body = JSON.stringify({
      wsUrl: this.wsUrl,
      connected: this.connected,
      extensionVersion: this.#info?.version,
      // An extension that finds several bridges alive (a reloaded plugin leaves
      // the previous listener bound until it is disposed) must be able to pick
      // the newest one instead of whichever port it happens to probe first.
      startedAt: this.#startedAt,
    })
    response.writeHead(200, {
      'content-type': 'application/json',
      // A stale extension-side cache must never hide a restarted bridge.
      'cache-control': 'no-store',
    })
    response.end(body)
  }

  #handleUpgrade(request, socket, head) {
    const path = (request.url ?? '').split('?')[0]
    const key = request.headers['sec-websocket-key']
    if (path !== SOCKET_PATH || typeof key !== 'string') {
      socket.destroy()
      return
    }
    const origin = String(request.headers.origin ?? '')
    if (!origin.startsWith('chrome-extension://')) {
      // Only an extension page may hold the browser; a web page must not.
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    if (this.#peer !== undefined) this.#peer.close(1000, 'replaced')
    this.#failAll(new Error('browser extension reconnected'))
    const peer = new Peer(socket, head, {
      onMessage: (text) => this.#receive(text),
      onClose: () => {
        if (this.#peer === peer) {
          this.#peer = undefined
          this.#stopHeartbeat()
          // 请求可能已经执行，只是回执没回来：不自动重发（点击重复执行更糟），交给调用方决定。
          this.#failAll(new Error('browser extension disconnected; the MV3 service worker was probably suspended, retry the call'))
        }
      },
    })
    this.#peer = peer
    this.#startHeartbeat()
    const waiters = this.#waiters
    this.#waiters = []
    for (const wake of waiters) wake(peer)
    this.#logger?.info?.('chrome-tab: browser extension connected')
  }

  #receive(text) {
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (message === null || typeof message !== 'object') return
    if (message.type === 'hello') {
      this.#info = {
        version: String(message.version ?? 'unknown'),
        // 扩展会说它会什么；宿主据此决定要不要给模型一个它做不到的工具。
        features: Array.isArray(message.features) ? message.features.map(String) : [],
        at: Date.now(),
      }
      return
    }
    if (message.type === 'event') {
      // 扩展主动推来的东西（画面帧、页面状态），不是某次调用的回执。
      const name = String(message.event ?? '')
      if (name !== '') this.#emit(name, message.data)
      return
    }
    if (typeof message.id !== 'string') return
    const pending = this.#pending.get(message.id)
    if (pending === undefined) return
    this.#pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok === true) pending.resolve(message.result)
    else pending.reject(new Error(String(message.error ?? 'extension call failed')))
  }

  #failAll(error) {
    // 没有人在等回执时，断开是正常收起，不是故障；别拿它吓用户。
    if (this.#pending.size === 0) return
    const waiting = [...this.#pending.values()].map((pending) => pending.method).filter(Boolean)
    const detail = waiting.length === 0 ? error.message : `${error.message} (while ${waiting.join(', ')} was waiting)`
    this.#logger?.warn?.(`chrome-tab: ${detail}`)
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(waiting.length === 0 ? error.message : detail))
    }
    this.#pending.clear()
  }

  /**
   * Keep the MV3 service worker awake.
   *
   * Chrome suspends an idle service worker after about 30 seconds, which drops the socket and
   * fails whatever the next call was. One small message every 20 seconds is an event it has to
   * handle, so the worker stays up while the session is idle between tool calls.
   */
  #startHeartbeat() {
    this.#stopHeartbeat()
    const timer = setInterval(() => {
      if (!this.connected) return
      this.call('ping', {}, { timeoutMs: 15000 }).catch(() => {})
    }, 20000)
    if (typeof timer.unref === 'function') timer.unref()
    this.#heartbeat = timer
  }

  #stopHeartbeat() {
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat)
    this.#heartbeat = undefined
  }

  /** Wait up to `ms` for the extension to (re)connect; resolves to the peer or undefined. */
  #awaitPeer(ms) {
    const peer = this.#peer
    if (peer !== undefined && !peer.closed) return Promise.resolve(peer)
    if (ms <= 0) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      let timer
      const wake = (live) => {
        clearTimeout(timer)
        resolve(live)
      }
      timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((entry) => entry !== wake)
        resolve(undefined)
      }, ms)
      if (typeof timer.unref === 'function') timer.unref()
      this.#waiters.push(wake)
    })
  }

  /** One request/response round trip to the extension. */
  call(method, params = {}, { timeoutMs = 60000 } = {}) {
    // MV3 把 service worker 挂起再唤醒的瞬间，socket 会短暂缺席；只读的调用再等一次、再发一次，
    // 用户就看不到这次抖动。有副作用的调用不重发：宁可报错，也不要把点击做两遍。
    return this.#callWithRetry(method, params, timeoutMs, RETRY_SAFE.has(method) ? 1 : 0)
  }

  async #callWithRetry(method, params, timeoutMs, attemptsLeft) {
    const peer = await this.#awaitPeer(Math.min(3000, timeoutMs))
    if (peer === undefined) throw new Error('browser extension is not connected')
    try {
      return await this.#roundTrip(peer, method, params, timeoutMs)
    } catch (error) {
      const transient = /disconnected|reconnected|not connected/iu.test(String(error?.message ?? ''))
      if (attemptsLeft <= 0 || !transient) throw error
      return this.#callWithRetry(method, params, timeoutMs, attemptsLeft - 1)
    }
  }

  #roundTrip(peer, method, params, timeoutMs) {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`browser extension did not answer ${method} within ${timeoutMs}ms`))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      this.#pending.set(id, { resolve, reject, timer, method })
      try {
        peer.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  async dispose() {
    this.#stopHeartbeat()
    this.#peer?.close(1001, 'host shutting down')
    this.#peer = undefined
    this.#failAll(new Error('browser bridge stopped'))
    const server = this.#server
    this.#server = undefined
    this.#port = undefined
    this.#info = undefined
    if (server !== undefined) {
      // An upgraded socket is not an HTTP request the server counts, but a live
      // connection still keeps `close`'s callback pending forever. Drop every
      // socket first, then close, then stop waiting on a callback that a
      // half-open peer may never let fire.
      server.closeAllConnections?.()
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000)
        server.close(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }
}
