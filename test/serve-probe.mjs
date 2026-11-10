// 只起探针页的 HTTP 服务（不开 Chrome），供 test/native.mjs 用系统 Chrome 访问。
// 页面把每条事件 POST 回来，落在同目录的 probe-events.log，测试据此断言“真的点中了”。

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { createServer } from 'node:http'

const eventsPath = new URL('./probe-events.log', import.meta.url).pathname
const geomPath = new URL('./probe-geometry.json', import.meta.url).pathname
writeFileSync(eventsPath, '')
try { writeFileSync(geomPath, '{}') } catch {}

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/log') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      appendFileSync(eventsPath, `${body}\n`)
      res.writeHead(204, { 'access-control-allow-origin': '*' }).end()
    })
    return
  }
  if (req.method === 'POST' && req.url === '/geom') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      writeFileSync(geomPath, body)
      res.writeHead(204, { 'access-control-allow-origin': '*' }).end()
    })
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(readFileSync(new URL('./probe.html', import.meta.url)))
}).listen(8731, '127.0.0.1')

await new Promise((resolve) => server.once('listening', resolve))
console.log(JSON.stringify({ pageUrl: `http://127.0.0.1:${server.address().port}/`, eventsPath, geomPath }))
