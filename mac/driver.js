/**
 * macOS 原生输入通道的 Node 侧客户端。
 *
 * 真正干活的是同目录下的 `axdriver` 可执行文件（由 `axdriver.swift` 编译而来）。
 * 它常驻运行，通过 stdin/stdout 收发一行一个 JSON 的请求与应答。
 *
 * 为什么要有这一层：网页里 `new MouseEvent(...)` 造出来的事件 `isTrusted` 恒为 false，
 * 任何正经的交互逻辑（以及反自动化检测）都能一眼看穿。要拿到 `isTrusted === true`，
 * 事件必须由浏览器自己产生。经实测，macOS 上有三条真实通路：
 *
 *  - 点击：对 AX 元素执行 `kAXPressAction`，Chrome 内部合成完整的
 *    pointerover → pointerdown → mousedown → mouseup → pointerup → click 链，全部可信。
 *  - 输入：AX 聚焦目标元素后用 `CGEvent.postToPid` 逐字符投递 unicode 键盘事件。
 *  - 拖拽：`CGEvent.postToPid` 的 leftMouseDown/Up 永远不会被路由到窗口（字段级穷举已验证），
 *    只能走全局 `cghidEventTap`。那会把真实光标带走，所以执行期间隐藏光标并在结束时复位。
 *
 * 全部操作都不需要把 Chrome 拉到前台，也不需要额外安装 native messaging host。
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const AXDRIVER_PATH = join(HERE, process.platform === 'win32' ? 'axdriver.exe' : 'axdriver')
export const AXDRIVER_SOURCE = join(HERE, 'axdriver.swift')

/** 没编译过时，二进制与编译缓存放这里，避免写进插件安装目录。 */
const CACHE_DIR = join(homedir(), '.dsh', 'chrome-tab-native')
const CACHED_BINARY = join(CACHE_DIR, process.platform === 'win32' ? 'axdriver.exe' : 'axdriver')

/** 单个命令的默认超时。拖拽会分很多步，给得宽一些。 */
const DEFAULT_TIMEOUT_MS = 20000

let compiled
let compileError

/**
 * 找到可用的 axdriver，必要时现场编译。
 *
 * 用户不该为了点一个按钮去手敲 swiftc，所以第一次需要原生通道时自动编译，
 * 产物放在 ~/.dsh 下（插件目录可能是只读的 node_modules）。编译一次之后
 * 只做 mtime 比较，源码没变就直接复用。
 */
export async function ensureDriver({ logger } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error(`原生输入通道只在 macOS 上存在（当前系统是 ${process.platform}）；`
      + '点击、输入、拖拽、滚动请走 CDP 通道，那边 Windows 和 Linux 都能用。')
  }
  if (existsSync(AXDRIVER_PATH)) return AXDRIVER_PATH
  if (compileError !== undefined) throw compileError
  if (compiled !== undefined) return compiled
  if (!existsSync(AXDRIVER_SOURCE)) throw new Error(`缺少驱动源码：${AXDRIVER_SOURCE}`)
  const upToDate = existsSync(CACHED_BINARY)
    && statSync(CACHED_BINARY).mtimeMs >= statSync(AXDRIVER_SOURCE).mtimeMs
  if (upToDate) return CACHED_BINARY

  mkdirSync(CACHE_DIR, { recursive: true })
  logger?.info?.(`chrome-tab: 正在编译原生输入驱动（首次使用需要几秒）…`)
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('swiftc', [
        '-module-cache-path', join(CACHE_DIR, '.mc'),
        '-O', AXDRIVER_SOURCE, '-o', CACHED_BINARY,
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
        if (stderr.length > 4000) stderr = stderr.slice(-4000)
      })
      child.on('error', (error) => {
        reject(new Error(
          `无法运行 swiftc（${error.message}）。装好 Xcode 命令行工具后重试，`
          + `或手动在 ${HERE} 运行 swiftc -O axdriver.swift -o axdriver。`,
        ))
      })
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`swiftc 编译失败（code=${code}）：${stderr.trim().split('\n').slice(-4).join(' | ')}`))
      })
    })
  } catch (error) {
    compileError = error
    throw error
  }
  compiled = CACHED_BINARY
  logger?.info?.(`chrome-tab: 原生输入驱动已编译到 ${CACHED_BINARY}`)
  return compiled
}

/**
 * 常驻 axdriver 子进程。
 *
 * 命令按到达顺序串行执行：同一个进程同一时刻只处理一个请求，并发调用会排队，
 * 这样就不必在 Chrome 侧处理交错。子进程意外退出时自动重启一次。
 */
export class AxDriver {
  #child
  #nextId = 1
  #pending = new Map()
  #ready
  #buffer = ''
  #queue = Promise.resolve()
  #disposed = false
  #lastError
  #binary

  constructor({ logger } = {}) {
    this.logger = logger
  }

  /** 这台机器上是否有希望跑原生通道（有源码或有编译器）。 */
  static available() {
    return process.platform === 'darwin' && (existsSync(AXDRIVER_PATH) || existsSync(AXDRIVER_SOURCE))
  }

  /** 启动并等待 axdriver 报 ready。失败时抛出带诊断的错误。 */
  start() {
    if (this.#ready) return this.#ready
    if (!AxDriver.available()) {
      return Promise.reject(new Error(
        `原生输入驱动只在 macOS 上可用，而且需要 ${AXDRIVER_PATH} 或 ${AXDRIVER_SOURCE}。`,
      ))
    }
    this.#ready = (async () => {
      const binary = this.#binary ?? await ensureDriver({ logger: this.logger })
      this.#binary = binary
      return new Promise((resolve, reject) => {
        let settled = false
        const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] })
        this.#child = child
        let stderr = ''
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString()
          if (stderr.length > 4000) stderr = stderr.slice(-4000)
        })
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk) => this.#onData(chunk, () => {
          if (!settled) {
            settled = true
            resolve({ path: binary })
          }
        }))
        child.on('error', (error) => {
          this.#lastError = error
          if (!settled) {
            settled = true
            reject(new Error(`无法启动 axdriver：${error.message}`))
          }
          this.#failAll(new Error(`axdriver 进程错误：${error.message}`))
        })
        child.on('exit', (code, signal) => {
          this.#child = undefined
          const detail = stderr.trim() ? `；stderr: ${stderr.trim().split('\n').slice(-3).join(' | ')}` : ''
          const error = new Error(`axdriver 已退出（code=${code} signal=${signal}）${detail}`)
          this.#lastError = error
          if (!settled) { settled = true; reject(error) }
          this.#failAll(error)
          this.#ready = undefined
        })
      })
    })()
    // 编译或启动失败后允许下一次重试，否则一次手抖就会永久禁用原生通道。
    this.#ready.catch(() => { this.#ready = undefined })
    return this.#ready
  }

  #onData(chunk, onReady) {
    this.#buffer += chunk
    let newline = this.#buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      newline = this.#buffer.indexOf('\n')
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.ready === true) {
        this.info = message
        this.logger?.info?.(`axdriver 就绪：pid=${message.pid} axTrusted=${message.axTrusted}`)
        onReady()
        continue
      }
      const waiting = this.#pending.get(message.id)
      if (!waiting) continue
      this.#pending.delete(message.id)
      clearTimeout(waiting.timer)
      if (message.ok === true) waiting.resolve(message)
      else {
        const error = new Error(message.error ?? 'axdriver 拒绝执行')
        error.code = message.code
        waiting.reject(error)
      }
    }
  }

  #failAll(error) {
    for (const [, waiting] of this.#pending) {
      clearTimeout(waiting.timer)
      waiting.reject(error)
    }
    this.#pending.clear()
  }

  /**
   * 发一条命令并等结果。并发调用会串行排队。
   * @param cmd - 命令名，例如 click、type、drag、scroll。
   * @param params - 命令参数。
   */
  call(cmd, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const run = async () => {
      if (this.#disposed) throw new Error('axdriver 已关闭')
      await this.start()
      const child = this.#child
      if (!child?.stdin?.writable) throw new Error(this.#lastError?.message ?? 'axdriver 未在运行')
      const id = this.#nextId++
      const payload = `${JSON.stringify({ id, cmd, params })}\n`
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pending.delete(id)
          reject(new Error(`axdriver 命令 ${cmd} 超时（${timeoutMs}ms）`))
        }, timeoutMs)
        this.#pending.set(id, { resolve, reject, timer })
      })
      child.stdin.write(payload)
      return result
    }
    const start = () => run()
    // 串行化：上一条失败不应阻塞下一条。
    const chained = this.#queue.then(start, start)
    this.#queue = chained.then(() => undefined, () => undefined)
    return chained
  }

  /** AX 辅助功能是否已授权给当前进程。 */
  get trusted() {
    return this.info?.axTrusted === true
  }

  /** Chrome 是否在运行（由最近一次 ping 得知）。 */
  get chromeRunning() {
    return Boolean(this.info?.chrome)
  }

  async dispose() {
    this.#disposed = true
    this.#failAll(new Error('axdriver 已关闭'))
    const child = this.#child
    this.#child = undefined
    this.#ready = undefined
    if (!child) return
    try { child.stdin.end() } catch { /* 已经关了就算了 */ }
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* noop */ } ; resolve() }, 1000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}

/**
 * 就绪探测：返回 { available, trusted, chrome, error }，不抛异常。
 * 工具在决定走原生通道还是退回扩展通道时用它。
 */
export async function probeNative(logger) {
  if (!AxDriver.available()) {
    return {
      available: false,
      trusted: false,
      chrome: false,
      error: process.platform === 'darwin'
        ? `缺少驱动源码：${AXDRIVER_SOURCE}`
        : `原生输入通道只在 macOS 上存在（当前系统是 ${process.platform}），这里只有 CDP 通道可用`,
    }
  }
  const driver = new AxDriver({ logger })
  try {
    await driver.start()
    const result = await driver.call('ping', {}, { timeoutMs: 5000 })
    return { available: true, trusted: result.axTrusted === true, chrome: Boolean(result.chrome), driver, error: undefined }
  } catch (error) {
    await driver.dispose()
    return { available: false, trusted: false, chrome: false, error: error.message }
  }
}
