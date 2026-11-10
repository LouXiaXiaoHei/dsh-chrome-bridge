/**
 * Browser-half dry run: `client.js` is evaluated in a VM that stands in for the
 * Web UI module loader, so the registration path is exercised without a browser.
 *
 * The source it registers is then driven the way the @ menu drives it: list
 * candidates, pick one, serialize the resulting mention.
 */

import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const results = []
const check = (name, ok, detail) => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// A tab listing is the only thing the client fetches from the host.
const fetchCalls = []
const tabsPayload = {
  connected: true,
  currentTabId: 777,
  tabs: [
    { id: 777, windowId: 1, title: '哔哩哔哩 (゜-゜)つロ 干杯~-bilibili', url: 'https://www.bilibili.com/', active: true, injectable: true },
    { id: 778, windowId: 1, title: 'DeepSeek', url: 'https://chat.deepseek.com/sign_in', active: false, injectable: true },
    { id: 779, windowId: 1, title: 'chrome://settings', url: 'chrome://settings', active: false, injectable: false },
  ],
}

const registered = []
let localeRegister
let source

const locale = {
  register: (namespace, dictionaries) => {
    localeRegister = { namespace, dictionaries }
    return () => {}
  },
  getLocale: () => 'zh',
  subscribe: () => () => {},
}

const ctx = {
  effect: (factory) => {
    factory()
    return () => {}
  },
  on: () => () => {},
  get: (name) => (name === 'inputTriggers' ? { registerSource: (s) => { source = s; registered.push(s); return () => {} } } : undefined),
  locale,
}

const sandbox = {
  console,
  location: { origin: 'http://127.0.0.1:55271' },
  fetch: async (url, init) => {
    fetchCalls.push({ url, method: init?.method ?? 'GET' })
    if (String(url).includes('/dsh-chrome-tab/tabs')) {
      return { ok: true, json: async () => tabsPayload }
    }
    return { ok: true, json: async () => ({ ok: true }) }
  },
  AbortSignal,
  window: {},
}
sandbox.window.__ModuleLoader__ = {
  load: ({ id, factory }) => {
    sandbox.__loaded = { id, module: factory((name) => {
      if (name !== 'react') throw new Error(`unexpected require ${name}`)
      return {}
    }) }
  },
}
sandbox.globalThis = sandbox

const context = createContext(sandbox)
runInContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), context, { filename: 'client.js' })

const loaded = sandbox.__loaded
check('module loader received the package id', loaded?.id === 'dsh-chrome-tab', loaded?.id)
check('exports apply()', typeof loaded?.module?.apply === 'function')
check('declares its cordis inject list', Array.isArray(loaded?.module?.inject)
  && loaded.module.inject.includes('inputTriggers'), JSON.stringify(loaded?.module?.inject))

loaded.module.apply(ctx)
check('locale dictionaries registered under meta namespace', localeRegister?.namespace === 'dsh-chrome-tab'
  && typeof localeRegister.dictionaries.zh === 'object' && typeof localeRegister.dictionaries.en === 'object')
check('one @ source registered', registered.length === 1)
check('source triggers on @', source?.trigger === '@', source?.trigger)
check('source has a unique name', source?.name === 'chrome-tab', source?.name)
check('source implements the pick codec', typeof source?.codec?.serialize === 'function'
  && typeof source?.codec?.clipboardText === 'function')

const rows = await source.candidates({ sessionId: 's1' }, { query: '', signal: new AbortController().signal })
check('candidate list skips undrivable tabs', rows.length === 2, `${rows.length} rows`)
check('candidate rows carry the required fields',
  rows.every((row) => typeof row.name === 'string' && typeof row.icon === 'string'
    && typeof row.section === 'string' && typeof row.value === 'string'))
check('the controlled tab is marked', rows[0].description.includes('当前目标'), rows[0].description)

const filtered = await source.candidates({ sessionId: 's1' }, { query: 'deepseek', signal: new AbortController().signal })
check('query narrows the list', filtered.length === 1 && filtered[0].name === 'DeepSeek', JSON.stringify(filtered.map((row) => row.name)))

const picked = source.onPick({ candidate: rows[0], action: 'pick' })
check('pick returns an atomic insert', typeof picked?.insert?.ref === 'string' && picked.insert.ref === 'chrome-tab:777', JSON.stringify(picked?.insert?.ref))
check('pick uses an existing appearance', ['session', 'file', 'folder'].includes(picked?.insert?.appearance), picked?.insert?.appearance)
check('pick labels the mention', typeof picked.insert.label === 'string' && picked.insert.label.length > 0, picked.insert.label)
check('pick hands the url to the clipboard', picked.insert.clipboardText === 'https://www.bilibili.com/')

// The host learns which tab the model will drive from this POST.
await new Promise((resolve) => setTimeout(resolve, 20))
check('pick tells the host which tab was chosen', fetchCalls.some((call) => call.method === 'POST'
  && String(call.url).endsWith('/dsh-chrome-tab/select')), JSON.stringify(fetchCalls.map((call) => call.method)))

const serialized = await source.codec.serialize(picked.insert.ref)
check('serialize carries the tab id to the model', serialized.includes('777') && serialized.includes('bilibili.com'), serialized.slice(0, 100))
check('serialize names the tools to use', serialized.includes('chrome_snapshot'))

// Flip the same host into its disconnected state; the source must degrade to a
// single row that explains how to connect rather than fall silent.
tabsPayload.connected = false
tabsPayload.tabs = []
const offlineRows = await source.candidates({ sessionId: 's1' }, { query: '', signal: new AbortController().signal })
check('a disconnected host yields one hint row', offlineRows.length === 1 && offlineRows[0].name.includes('未连接'), JSON.stringify(offlineRows.map((row) => row.name)))
const offlinePick = source.onPick({ candidate: offlineRows[0], action: 'pick' })
check('the hint row explains how to connect', typeof offlinePick?.text === 'string' && offlinePick.text.includes('chrome://extensions'), String(offlinePick?.text).slice(0, 60))

// A tab bridge other than the current one holding the extension is the cause
// users actually hit after a plugin reload, and "load the extension" is wrong
// advice there: it is loaded, it is just talking to a listener nothing drives.
tabsPayload.reason = { kind: 'stale', port: 30795, message: 'stale' }
const staleRows = await source.candidates({ sessionId: 's1' }, { query: '', signal: new AbortController().signal })
check('a stale holder is named instead of a missing extension',
  staleRows.length === 1 && staleRows[0].name.includes('旧实例'),
  JSON.stringify(staleRows.map((row) => row.name)))
const stalePick = source.onPick({ candidate: staleRows[0], action: 'pick' })
check('the stale hint names the port and the fix',
  typeof stalePick?.text === 'string' && stalePick.text.includes('30795') && stalePick.text.includes('重启'),
  String(stalePick?.text).slice(0, 70))

tabsPayload.reason = { kind: 'elsewhere', port: 30796, message: 'elsewhere' }
const elsewhereRows = await source.candidates({ sessionId: 's1' }, { query: '', signal: new AbortController().signal })
check('a second harness window is named as such',
  elsewhereRows.length === 1 && elsewhereRows[0].name.includes('另一个'),
  JSON.stringify(elsewhereRows.map((row) => row.name)))

const failed = results.filter((ok) => ok !== true).length
console.log('')
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
