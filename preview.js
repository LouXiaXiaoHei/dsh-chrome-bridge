/**
 * 预览通道：把扩展抓到的渲染帧送到屏幕上，只给人看。
 *
 * 它和 agent 的截图是两回事——这里一帧都不进模型上下文，模型要看页面仍然调用
 * chrome_screenshot，一张一张按需付费。关掉这个通道，agent 照常工作。
 */
import { createHash } from 'node:crypto'
import { Peer } from './bridge.js'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const PREVIEW_PATH = '/dsh-chrome-tab/preview'

// 屏幕只要看起来连续就够了；把 Chrome 的每一帧都推过去，只是让回环带宽和
// 主线程白忙。12fps 左右已经看不出卡顿。
const FRAME_INTERVAL_MS = 80
// 关掉面板不立刻停：刷新页面、切个标签都会断开再连，留点余量免得反复启停。
const IDLE_STOP_MS = 5000
// 只在真有操作的时候录。操作结束再留一小段，让动画和重排收尾，然后画面冻在最后一帧。
const ACTIVITY_TAIL_MS = 2000
// 空窗口、刚换标签页时先要一张挂上去。Chrome 合成不出来（比如标签页在后台）就放弃，
// 别为了等一张永远不来的图一直开着流。
const BOOTSTRAP_MS = 2500
// 标签页关掉、扩展掉线这类失败，隔一会儿再试一次就够了。
const RETRY_FAILED_MS = 3000
// Chrome 只在标签页是当前页时才合成；这个间隔用来发现它被切到后台。
const TAB_POLL_MS = 2000

// 本机页面的几种写法：同一个屏幕上的页面，认它。
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/** 同源，或者本机回环页（别名、端口不同都认）；别的站点一律不认。 */
function originAllowed(origin, host) {
  // 探针、脚本这类非浏览器客户端不带 Origin；桌面版的页面跑在自定义协议上，
  // WebSocket 握手带的是字符串 "null"。两种都来自本机，放行。
  if (origin === '' || origin === 'null') return true
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.host === host) return true
  return LOOPBACK_HOSTS.has(url.hostname) && (url.protocol === 'http:' || url.protocol === 'https:')
}

/**
 * 接管一条预览 WebSocket，并把当前标签页的 CDP screencast 挂上去。
 *
 * @param {object} options
 * @param {import('./bridge.js').TabBridge} options.bridge 扩展连接
 * @param {() => number} options.currentTabId 宿主记住的标签页
 * @param {{info?: Function, warn?: Function}} [options.logger]
 */
export function attachPreview({ bridge, currentTabId, control, logger, timing }) {
  // 自检要快，生产要稳：同一套逻辑，时间参数由调用方收紧，默认值就是上面那几个常数。
  const frameMs = timing?.frameIntervalMs ?? FRAME_INTERVAL_MS
  const tailMs = timing?.activityTailMs ?? ACTIVITY_TAIL_MS
  const bootstrapMs = timing?.bootstrapMs ?? BOOTSTRAP_MS
  const idleStopMs = timing?.idleStopMs ?? IDLE_STOP_MS
  const clients = new Set()
  // 只留最新一张：慢的界面丢的是旧帧，不会积压成队列。
  // stats.frames / stats.bytes 是本次开流以来的流水（像水表），不是占用，也不是磁盘。
  let latest
  let pushedSeq = 0
  let lastMetaKey = ''
  let idleTimer
  let streamingTabId
  let startingTabId
  // 目标标签页刚失败过就别每 80ms 重试：扩展那边可能已经把它关了。
  let failedTabId
  let failedAt = 0
  let lastTabPoll = 0
  // 正在执行的浏览器工具数：只要有一个在跑，画面就得是活的。
  let activeCalls = 0
  // 操作刚结束还留着的那点尾巴，以及「只要一张新图」的时限。
  let activeUntil = 0
  let wantFrameUntil = 0
  let lastTargetTab

  // accepted 是累计值：clients 只说明此刻谁在看，它是「有没有人连过」的证据。
  // frames / bytes 记的是这次开流流过多少，每开一次流归零——流量，不是存量。
  const stats = { frames: 0, bytes: 0, startedAt: 0, errors: 0, accepted: 0 }

  const resolveTab = () => {
    const id = Number(currentTabId?.())
    return Number.isFinite(id) && id > 0 ? id : undefined
  }

  const broadcastJson = (message) => {
    const text = JSON.stringify(message)
    for (const client of clients) {
      try {
        client.peer.send(text)
      } catch {
        // 一个坏连接不该拖住其它人。
      }
    }
  }

  const stopStream = async (why) => {
    const tabId = streamingTabId
    streamingTabId = undefined
    if (tabId === undefined) return
    try {
      await bridge.call('page.screencast', { tabId, action: 'stop' }, { timeoutMs: 6000 })
    } catch {
      // 标签页可能已经关了，或扩展刚好被 MV3 挂起；没有什么要补救的。
    }
    logger?.info?.(`chrome-tab: preview stopped (${why})`)
    // 带上原因：界面要能分清「没人看所以停」和「等你操作所以停」，后者不该显示成故障。
    broadcastJson({ type: 'stream', running: false, tabId, reason: why })
  }

  const startStream = async (tabId) => {
    if (streamingTabId === tabId || startingTabId === tabId) return
    startingTabId = tabId
    if (streamingTabId !== undefined) await stopStream('switching tab')
    if (!bridge.connected) {
      startingTabId = undefined
      failedTabId = tabId
      failedAt = Date.now()
      broadcastJson({ type: 'stream', running: false, tabId, error: '扩展没有连上宿主' })
      return
    }
    try {
      const options = await bridge.call('page.screencast', {
        tabId,
        action: 'start',
        quality: 70,
        maxWidth: 1280,
        maxHeight: 800,
        // UI 每 80ms 才取一帧（12.5fps），CDP 就没必要按满帧发：每两帧取一帧，
        // 宿主解码 JPEG 的开销减半，观感看不出差别。
        everyNthFrame: 2,
      }, { timeoutMs: 10000 })
      streamingTabId = tabId
      failedTabId = undefined
      stats.startedAt = Date.now()
      stats.frames = 0
      stats.bytes = 0
      latest = undefined
      pushedSeq = 0
      lastMetaKey = ''
      broadcastJson({ type: 'stream', running: true, tabId, options })
      logger?.info?.(`chrome-tab: preview streaming tab ${tabId}`)
      await describeTab(tabId)
    } catch (error) {
      stats.errors += 1
      failedTabId = tabId
      failedAt = Date.now()
      const message = String(error?.message ?? error)
      // 装了新版宿主、Chrome 里还是旧扩展：重试没用，得让人去点一下刷新。
      const hint = /unknown method/i.test(message)
        ? 'Chrome 扩展还是旧版本，不会录屏。打开 chrome://extensions，点一下这个扩展的刷新图标。'
        : message
      broadcastJson({ type: 'stream', running: false, tabId, error: hint })
    } finally {
      if (startingTabId === tabId) startingTabId = undefined
    }
  }

  const describeTab = async (tabId) => {
    try {
      const result = await bridge.call('tabs.get', { tabId }, { timeoutMs: 5000 })
      // 扩展回的是 { tab }，宿主自己的老代码直接读 result.url —— 这里两种都认。
      const tab = result?.tab ?? result
      broadcastJson({ type: 'tab', tabId, url: tab?.url, title: tab?.title, active: tab?.active })
    } catch {
      // 标签页可能刚被关掉。
    }
  }

  /** 第一个锁定了标签页的观众；没有锁定的人跟着宿主的目标走。 */
  const watchedTab = () => {
    for (const client of clients) if (client.tabId !== undefined) return client.tabId
    return undefined
  }

  const ensureStreaming = () => {
    if (clients.size === 0) return
    const tabId = watchedTab() ?? resolveTab()
    if (tabId === undefined) return
    if (tabId === failedTabId && Date.now() - failedAt < RETRY_FAILED_MS) return
    void startStream(tabId)
  }

  /** 现在该不该占着录屏：有人看着，并且确实有东西要动。 */
  const shouldStream = () => clients.size > 0
    && (activeCalls > 0 || Date.now() < activeUntil || Date.now() < wantFrameUntil)

  /** 要一张当前画面：换目标、换手、用户点刷新，都只值这一张。 */
  const wantFrame = () => {
    wantFrameUntil = Date.now() + bootstrapMs
    if (clients.size > 0) ensureStreaming()
  }

  /**
   * 一次操作开始。工具跑多久画面就活多久，中间不会因为模型在想事情而断掉。
   * 调用方必须在 finally 里配上 endActivity，否则流永远停不下来。
   */
  const beginActivity = () => {
    activeCalls += 1
    // 别等下一次 pump：点击和开流同时发生，动画才不会被错过。
    if (clients.size > 0) ensureStreaming()
  }

  const endActivity = () => {
    activeCalls = Math.max(0, activeCalls - 1)
    if (activeCalls > 0) return
    activeUntil = Date.now() + tailMs
  }

  const scheduleIdleStop = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = undefined
      if (clients.size > 0) return
      void stopStream('nobody watching')
    }, idleStopMs)
  }

  const pump = () => {
    // 目标换了（用户切标签、agent 改主意）：先要一张新图挂上去，之后没有操作就停在那儿。
    const target = watchedTab() ?? resolveTab()
    if (target !== lastTargetTab) {
      lastTargetTab = target
      wantFrameUntil = target === undefined ? 0 : Date.now() + bootstrapMs
    }
    if (clients.size === 0) return
    // 有操作才录。停下来的画面和一张截图没有区别，没必要一秒十二帧地推给一个不动的人。
    if (shouldStream()) ensureStreaming()
    else if (streamingTabId !== undefined) void stopStream('idle')
    // 标签页什么时候被切到后台，扩展不会主动说；每两秒问一次，面板才好解释画面为什么停了。
    const polled = streamingTabId ?? resolveTab()
    if (polled !== undefined && Date.now() - lastTabPoll >= TAB_POLL_MS) {
      lastTabPoll = Date.now()
      void describeTab(polled)
    }
    if (latest === undefined || latest.seq === pushedSeq) return
    pushedSeq = latest.seq
    const meta = latest.metadata ?? {}
    const key = `${latest.tabId}:${meta.deviceWidth ?? '?'}x${meta.deviceHeight ?? '?'}:${meta.pageScaleFactor ?? '?'}:${meta.scrollOffsetY ?? 0}`
    if (key !== lastMetaKey) {
      lastMetaKey = key
      broadcastJson({ type: 'meta', tabId: latest.tabId, ...meta })
    }
    for (const client of clients) {
      if (client.tabId !== undefined && client.tabId !== latest.tabId) continue
      try {
        client.peer.sendBinary(latest.buffer)
      } catch {
        // 同上：断开的连接由 close 事件清理。
      }
    }
  }

  const pumping = setInterval(pump, frameMs)
  pumping.unref?.()

  const unsubscribe = bridge.subscribe((name, data) => {
    if (name !== 'screencast.frame') return
    if (data?.tabId !== streamingTabId) return
    if (typeof data?.data !== 'string') return
    stats.frames += 1
    stats.bytes += data.data.length
    latest = {
      tabId: data.tabId,
      seq: Number(data.seq) > 0 ? Number(data.seq) : stats.frames,
      buffer: Buffer.from(data.data, 'base64'),
      metadata: data.metadata,
    }
  })

  const handleClientMessage = (client, text) => {
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (message === null || typeof message !== 'object') return
    if (message.type === 'ping') {
      client.peer.send(JSON.stringify({ type: 'pong', at: Date.now() }))
      return
    }
    // 面板上那个「刷新」：用户想看一眼此刻的页面，但并没有谁在操作。
    if (message.type === 'refresh') {
      wantFrame()
      return
    }
    if (message.type === 'watch') {
      const tabId = Number(message.tabId)
      if (!Number.isFinite(tabId) || tabId <= 0) return
      client.tabId = tabId
      failedTabId = undefined
      // 锁定一个标签页只值一张图：拍完就停，等他真的开始操作。
      wantFrame()
    }
  }

  const accept = (request, socket, head) => {
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      logger?.warn?.('chrome-tab: preview refused a socket with no sec-websocket-key')
      socket.destroy()
      return
    }
    // 预览能看见用户屏幕上的一切，只接受本机页面连进来。
    const origin = String(request.headers.origin ?? '')
    const host = String(request.headers.host ?? '')
    if (!originAllowed(origin, host)) {
      // 拒绝要说出来：客户端那头只会看到连接被掐断，静默 destroy 让人无从查起。
      logger?.warn?.(`chrome-tab: preview refused origin ${origin || '(none)'} (host ${host || '(none)'}); only this machine may watch`)
      socket.destroy()
      return
    }
    if (origin === '') logger?.info?.('chrome-tab: preview accepted a socket with no Origin header')
    const acceptKey = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`,
    )
    // 不锁定建连时的标签页：宿主换了目标（用户切标签、新开页面），画面要跟过去。
    const client = { tabId: undefined }
    const peer = new Peer(socket, head, {
      onMessage: (text) => handleClientMessage(client, text),
      onClose: () => {
        clients.delete(client)
        if (clients.size === 0) scheduleIdleStop()
      },
    })
    client.peer = peer
    clients.add(client)
    stats.accepted += 1
    clearTimeout(idleTimer)
    idleTimer = undefined
    const tabId = resolveTab()
    peer.send(JSON.stringify({
      type: 'hello',
      connected: bridge.connected,
      tabId,
      streaming: streamingTabId,
      features: Array.isArray(bridge.info?.features) ? bridge.info.features : [],
      control: typeof control === 'function' ? control() : undefined,
    }))
    if (latest !== undefined && latest.tabId === tabId) {
      try {
        peer.sendBinary(latest.buffer)
      } catch {
        // 下一帧会补上。
      }
    }
    // 没见过画面的新观众：先要一张挂上去，哪怕此刻没人操作。
    wantFrame()
  }

  return {
    accept,
    /** 控制权换手：画面照旧，只是告诉看的人现在谁能操作。 */
    broadcastControl: (state) => broadcastJson({ type: 'control', ...state }),
    /** 工具开始执行：这段时间画面是活的，调用方要在 finally 里配 endActivity。 */
    beginActivity,
    endActivity,
    /** 只想要一张当前画面（换目标、换手、用户点刷新）。 */
    wantFrame,
    stats: () => ({ ...stats, clients: clients.size, streamingTabId }),
    dispose: () => {
      clearInterval(pumping)
      clearTimeout(idleTimer)
      unsubscribe()
      for (const client of clients) {
        try {
          client.peer.close(1001, 'harness stopped')
        } catch {
          // 已经断了。
        }
      }
      clients.clear()
      void stopStream('dispose')
    },
  }
}
