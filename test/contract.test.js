/**
 * Contract test between the two halves that only meet at runtime.
 *
 * The host asks for methods by name and the extension answers by name; a typo in
 * either file would only surface as a failed tool call in Chrome. Both lists are
 * read from source and compared here instead.
 */

import { readFileSync } from 'node:fs'

const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const preview = readFileSync(new URL('../preview.js', import.meta.url), 'utf8')
const extension = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8')
const bridge = readFileSync(new URL('../bridge.js', import.meta.url), 'utf8')
const clientHalf = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** `call('page.snapshot', ...)` in the host, plus the direct bridge.call spots. */
const hostMethods = new Set()
for (const source of [host, preview]) {
  for (const match of source.matchAll(/\bcall\('([a-z]+\.[a-zA-Z]+)'/gu)) hostMethods.add(match[1])
  for (const match of source.matchAll(/bridge\.call\('([a-z]+\.[a-zA-Z]+)'/gu)) hostMethods.add(match[1])
}

/** The METHODS table in the extension. */
const extensionMethods = new Set(
  [...extension.matchAll(/^\s{2}async '([a-z]+\.[a-zA-Z]+)'\(/gmu)].map((match) => match[1]),
)

check('the host calls at least one extension method', hostMethods.size > 0, [...hostMethods].join(', '))
check('the extension exposes at least one method', extensionMethods.size > 0, [...extensionMethods].join(', '))

for (const method of hostMethods) {
  check(`extension implements ${method}`, extensionMethods.has(method))
}

for (const method of extensionMethods) {
  const used = hostMethods.has(method)
  check(`extension method ${method} is called by the host`, used || method === 'ping', used ? undefined : 'unused')
}

// The discovery beacon both halves must agree on.
const hostPorts = /HOST_PORTS = \[([^\]]+)\]/u.exec(extension)?.[1]?.split(',').map((value) => value.trim())
const bridgePorts = /BRIDGE_PORTS = \[([^\]]+)\]/u.exec(bridge)?.[1]?.split(',').map((value) => value.trim())
check('both halves scan the same ports', JSON.stringify(hostPorts) === JSON.stringify(bridgePorts), `${hostPorts} vs ${bridgePorts}`)

const hostConfigPath = /CONFIG_PATH = '([^']+)'/u.exec(extension)?.[1]
const bridgeConfigPath = /CONFIG_PATH = '([^']+)'/u.exec(bridge)?.[1]
check('both halves agree on the config path', hostConfigPath === bridgeConfigPath, `${hostConfigPath} vs ${bridgeConfigPath}`)

const hostSocketPath = /SOCKET_PATH = '([^']+)'/u.exec(bridge)?.[1]
const extensionSocketUsage = extension.includes('wsUrl')
check('the extension dials the url the host serves', typeof hostSocketPath === 'string' && extensionSocketUsage, hostSocketPath)

// Every tool the model sees must exist in the host module.
const toolNames = [...host.matchAll(/name: '(chrome_[a-z_]+)'/gu)].map((match) => match[1])
check('thirteen tools are advertised', toolNames.length === 13, `${toolNames.length}: ${toolNames.join(', ')}`)
check('tool names are unique', new Set(toolNames).size === toolNames.length)
check('the deprecated eval tool is gone', !toolNames.includes('chrome_eval'))

// 导航不是“页面自己变了”：指针要先滑到中心、按下、涟漪，然后才放行。
check(
  'the pointer acts before the page leaves',
  /const departCursor = async \(tabId\) =>/u.test(host)
    && host.includes('await departCursor(tabId)')
    && host.includes('await departCursor(currentTabId)'),
  'chrome_open must give the pointer a departure',
)

// 预览：画面只走本地回环，路径三处（页面、升级、客户端）必须一致。
check(
  'the preview page and its socket share one path',
  preview.includes("export const PREVIEW_PATH") && host.includes('path: PREVIEW_PATH'),
  'preview.html is served from PREVIEW_PATH and the stream upgrades on it',
)
check('the preview socket uses the host upgrade hook', /server\.registerUpgrade\(/u.test(host))
check(
  'the extension acks each frame without waiting for the ui',
  extension.indexOf("'Page.screencastFrameAck'") > 0
    && extension.indexOf("'Page.screencastFrameAck'") < extension.indexOf("event: 'screencast.frame'"),
  'ack before forwarding, so a slow viewer cannot stall the renderer',
)
check(
  'frames never become tool output',
  !host.includes('screencast.frame') && !host.includes("'screencast'"),
  'the model sees chrome_screenshot only',
)
check(
  'the preview ships with the package',
  Array.isArray(manifest.files) && manifest.files.includes('preview.js') && manifest.files.includes('preview.html'),
  JSON.stringify(manifest.files),
)
check(
  'the client registers the preview as a sidebar tab',
  clientHalf.includes('sidebarRightTabs.register') && clientHalf.includes("'sidebar.right.pane.tab'"),
  'one body per tab kind, keyed by the tab id',
)
check(
  'picking a tab floats the preview out',
  /const remember = \(tabId\) => \{[\s\S]{0,400}?openPreview\(true\)/u.test(clientHalf)
    && /const openPreview = \(force\) => \{[\s\S]{0,300}?showFloat\(\)/u.test(clientHalf),
  'the user should not have to hunt for the panel entry',
)
check(
  'the preview is a floating window, not a sidebar takeover',
  clientHalf.includes("const FLOAT_ID = 'dsh-chrome-tab-float'")
    && clientHalf.includes("position: 'fixed'")
    && !clientHalf.includes('sidebarNavigator.openTab'),
  'a right-hand overlay keeps the conversation on screen',
)
check(
  'the float has a close button and can come back',
  clientHalf.includes("copy('float.close')")
    && /close\.addEventListener\('click', \(\) => hide\(\)\)/u.test(clientHalf),
  'closing hides it; picking a tab brings it back',
)
check(
  'the panel follows the host target on its own',
  clientHalf.includes("const STATUS_PATH = '/dsh-chrome-tab/status'")
    && /setInterval\(watchTarget, 3000\)/u.test(clientHalf)
    && host.includes("const STATUS_PATH = '/dsh-chrome-tab/status'"),
  'no push channel: poll, and only open the panel where it can be opened',
)
check(
  'the panel explains a frozen background tab',
  preview.includes('TAB_POLL_MS') && clientHalf.includes('tab.background'),
  'Chrome stops compositing a tab that is not current; say so instead of looking broken',
)
check(
  'the panel asks the host where the socket lives',
  // 桌面版的页面跑在 dsh-app://app 上：origin 是字符串 "null"、host 是 "app"，
  // 照它们拼出来的地址一律不可解析。相对路径由主进程转发，绝对地址由 /status 给。
  !/fetch\(`\$\{location\./u.test(clientHalf)
    && clientHalf.includes('info?.preview?.wsUrl')
    && host.includes('wsUrl: previewWsUrl()'),
  'an origin-relative guess cannot survive the desktop protocol',
)
check(
  'the host refuses tools while the user holds control',
  host.includes("controlOwner === 'user'") && host.includes('用户正在接管'),
  'the model must let go of the page, not fight for it',
)

check(
  'the preview records only while a tool runs',
  /preview\.beginActivity\(\)\s*\n\s*try \{[\s\S]{0,300}?finally \{\s*\n\s*preview\.endActivity\(\)/u.test(host)
    && preview.includes('const shouldStream = () => clients.size > 0')
    && preview.includes("void stopStream('idle')"),
  'idle pages cost nothing: a still page is a screenshot nobody asked for',
)
check(
  'a pause says why it paused',
  preview.includes("type: 'stream', running: false, tabId, reason: why")
    && clientHalf.includes("message.reason === 'idle'")
    && clientHalf.includes("'hint.frozen'"),
  'the panel must not show "waiting for the ai" as a failure',
)

const failed = results.filter((ok) => ok !== true).length
console.log('')
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
