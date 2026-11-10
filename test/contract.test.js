/**
 * Contract test between the two halves that only meet at runtime.
 *
 * The host asks for methods by name and the extension answers by name; a typo in
 * either file would only surface as a failed tool call in Chrome. Both lists are
 * read from source and compared here instead.
 */

import { readFileSync } from 'node:fs'

const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const extension = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8')
const bridge = readFileSync(new URL('../bridge.js', import.meta.url), 'utf8')

const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** `call('page.snapshot', ...)` in the host, plus the direct bridge.call spots. */
const hostMethods = new Set(
  [...host.matchAll(/\bcall\('([a-z]+\.[a-zA-Z]+)'/gu)].map((match) => match[1]),
)
for (const match of host.matchAll(/bridge\.call\('([a-z]+\.[a-zA-Z]+)'/gu)) hostMethods.add(match[1])

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

const failed = results.filter((ok) => ok !== true).length
console.log('')
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
