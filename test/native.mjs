/**
 * 原生输入通道的现场测试。
 *
 * 与其它测试不同，这个测试要一个真的 Chrome 窗口、一个真的网页，和已经
 * 授权过辅助功能的终端。它验证的是 index.js 里那段坐标换算：DOM 给的视口
 * CSS 像素 + webArea 的屏幕原点 = 事件该投递到哪里。
 *
 * 用法：
 *   node test/native.mjs [url]
 *
 * 默认打开 http://127.0.0.1:8731/，那是 `node test/serve-probe.mjs` 提供的探针页。
 * 页面元素的位置是固定的，事件会 POST 回来落在 test/probe-events.log，所以这里能
 * 直接断言"点中了按钮"，而不只是"命令没报错"。
 */

import { AxDriver, AXDRIVER_SOURCE } from '../mac/driver.js'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const URL_UNDER_TEST = process.argv[2] ?? 'http://127.0.0.1:8731/'
const FIXTURE_TITLE = 'trust probe'
// 探针页把每条事件都 POST 回来，服务端落在 test/probe-events.log。拖拽没有别的证据可看：
// 页面自己记录的 input 事件才是"真的拖动了一个滑块"。
const EVENTS_LOG = fileURLToPath(new URL('./probe-events.log', import.meta.url))
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

let failures = 0
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`)
  else { failures += 1; console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`) }
}

if (!existsSync(AXDRIVER_SOURCE)) {
  console.log(`SKIP 原生驱动源码缺失：${AXDRIVER_SOURCE}`)
  process.exit(0)
}

const driver = new AxDriver({ logger: { info: (line) => console.log(`  [axdriver] ${line}`) } })
try {
  await driver.start()
  const ping = await driver.call('ping', {}, { timeoutMs: 5000 })
  check('axdriver 就绪', ping.ok === true, JSON.stringify(ping))
  check('辅助功能已授权', ping.axTrusted === true, '系统设置 → 隐私与安全性 → 辅助功能')
  if (ping.chrome === undefined || ping.chrome === null) {
    console.log('SKIP Chrome 没有在运行')
    process.exit(failures === 0 ? 0 : 1)
  }

  // 探针页必须是当前标签页：命令投递的是屏幕坐标，落在别的页面上就测错了对象。
  let openedByUs = false
  const before = await driver.call('windows', {})
  const titles = (before.windows ?? []).map((window) => String(window.webTitle ?? ''))
  if (!titles.includes(FIXTURE_TITLE)) {
    execFileSync('open', ['-a', 'Google Chrome', URL_UNDER_TEST])
    openedByUs = true
    await wait(2500)
  }

  // ---------------------------------------------------------------- 几何
  const geometry = await driver.call('geometry', { title: FIXTURE_TITLE })
  check('拿到 webArea 的屏幕几何', Array.isArray(geometry.origin) && Array.isArray(geometry.size),
    JSON.stringify({ origin: geometry.origin, size: geometry.size }))

  const [originX, originY] = geometry.origin
  const [width, height] = geometry.size
  check('webArea 有正的宽高', width > 0 && height > 0, `${width}x${height}`)

  // 页面把自己的视口尺寸写在 #log 上方；这里用一个已知元素的相对位置反推：
  // probe 页把 #btn 放在 left:300 top:200，尺寸 160x60，所以它的中心在视口
  // (380,230)，屏幕上就是 origin + (380,230)。
  const targetX = originX + 380
  const targetY = originY + 230

  // ---------------------------------------------------------------- 点击
  await driver.call('clickAt', { x: targetX, y: targetY, title: FIXTURE_TITLE }, { timeoutMs: 10_000 })
  await new Promise((resolve) => { setTimeout(resolve, 300) })

  const nodes = await driver.call('tree', { title: FIXTURE_TITLE })
  const hit = (nodes.nodes ?? []).find((node) => node.role === 'AXStaticText' && /^\d+,\d+,(trusted|untrusted)$/u.test(String(node.value ?? '')))
  check('页面记录到了点击', hit !== undefined, '在 AX 树里找 #hit 的文本')
  const hitText = String(hit?.value ?? '')
  check('事件是可信的', hitText.endsWith(',trusted'), hitText)
  check('点了按钮的中心', hitText.startsWith('380,230,'), hitText)

  // ---------------------------------------------------------------- 输入
  // 按 placeholder 寻址：输入框没有标题，人在页面上看到的就是那句提示文字。
  const typed = `dsh-${Date.now() % 100000}`
  await driver.call('type', { text: typed, replace: true, name: 'rich', title: FIXTURE_TITLE }, { timeoutMs: 15_000 })
  await wait(300)
  let after = await driver.call('tree', { title: FIXTURE_TITLE })
  const inputs = (after.nodes ?? []).filter((node) => node.role === 'AXTextArea')
  const textarea = inputs.find((node) => String(node.placeholder ?? '') === 'rich')
  check('文本写进了输入框', String(textarea?.value ?? '') === typed, JSON.stringify(textarea?.value ?? null))

  // ---------------------------------------------------------------- 拖拽
  // 拖拽必须走全局事件（postToPid 的按下拿不到窗口内坐标），所以它同时验证了
  // 隐藏光标、投递拖动、再把光标放回原处这一整套。
  // 滑块要能被反复测试：先按 Home 归零，否则第二次跑时它已经顶在 100，拖不动也就没有 input。
  await driver.call('key', { name: '音量', key: 'home', title: FIXTURE_TITLE }, { timeoutMs: 10_000 })
  await wait(120)
  const beforeDrag = existsSync(EVENTS_LOG) ? readFileSync(EVENTS_LOG, 'utf8').split('\n').length : 0
  const dragged = await driver.call('drag', { fromName: '音量', dx: 150, steps: 14, title: FIXTURE_TITLE }, { timeoutMs: 20_000 })
  await wait(400)
  check('拖拽命令返回了起止点', Array.isArray(dragged.from) && Array.isArray(dragged.to), JSON.stringify(dragged))
  if (existsSync(EVENTS_LOG)) {
    const rows = readFileSync(EVENTS_LOG, 'utf8').split('\n').filter((line) => line.trim() !== '')
    const inputs = rows.slice(Math.max(beforeDrag - 1, 0)).filter((line) => line.includes('"t":"input"'))
    check('拖动滑块让它连续变化', inputs.length >= 5, `${inputs.length} input events`)
  }

  // ---------------------------------------------------------------- 富文本
  // contenteditable 在 AX 里同样是 AXTextArea，但编辑器没有 value 语义，光看命令返回
  // 说不了话，所以再读一次它的内容。
  // 用 aria-label 定位：contenteditable 的可见文字会被上一次测试改掉，标签不会。
  const rich = `富文本${Date.now() % 1000}`
  await driver.call('type', { text: rich, replace: true, name: '富文本区', title: FIXTURE_TITLE }, { timeoutMs: 15_000 })
  await wait(300)
  after = await driver.call('tree', { title: FIXTURE_TITLE })
  const editorial = (after.nodes ?? []).find((node) => node.role === 'AXTextArea' && String(node.value ?? '').includes(rich))
  check('富文本也能写入', editorial !== undefined, JSON.stringify((after.nodes ?? []).map((n) => n.value)))

  if (openedByUs) {
    await driver.call('key', { key: 'w', cmd: true })
    await wait(300)
  }
} catch (error) {
  failures += 1
  console.log(`  FAIL ${error.message}`)
} finally {
  await driver.dispose()
}

console.log('')
console.log(failures === 0 ? 'native channel ok' : `${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
