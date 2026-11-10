/** Popup: report whether the harness socket is live and let the user retry it. */

const dot = document.getElementById('dot')
const status = document.getElementById('status')
const detail = document.getElementById('detail')
const bridge = document.getElementById('bridge')
const retry = document.getElementById('retry')

const render = (state) => {
  dot.className = state.connected ? 'dot on' : 'dot off'
  status.textContent = state.connected ? '已连接到 DeepSeek Harness' : '未连接'
  bridge.textContent = state.url ? `桥：${state.url.replace('ws://127.0.0.1:', ':')}` : ''
  if (state.connected) {
    detail.textContent = '回到 Harness 输入框键入 @ 选择标签页。'
  } else if (state.error) {
    detail.textContent = state.error
  } else {
    detail.textContent = '请先启动 DeepSeek Harness，然后点“立即重连”。'
  }
}

const ask = (type) => new Promise((resolve) => {
  chrome.runtime.sendMessage({ type }, (reply) => {
    resolve(reply ?? { connected: false, error: chrome.runtime.lastError?.message })
  })
})

void ask('dsh-chrome-tab:status').then(render)

retry.addEventListener('click', () => {
  retry.disabled = true
  status.textContent = '连接中…'
  void ask('dsh-chrome-tab:connect').then((reply) => {
    retry.disabled = false
    render(reply)
  })
})
