'use strict'
// Minimal stand-in for a restarted DSH instance: serves the ONE endpoint the
// restart helper polls (/api/dsh-power-button/health) with a fixed instanceId.
// The runtime E2E drives the REAL generated helper against two of these
// processes (old → killed → new) so the whole chain — pid exit, port release,
// session quiescence, env-token relaunch, health confirmation — runs against
// real processes, real PIDs and a real TCP port without needing a real DSH.
const http = require('node:http')

const args = process.argv.slice(2)
function argOf(name) {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}
const PORT = Number(argOf('--port'))
const INSTANCE_ID = argOf('--instance-id') ?? 'unknown-instance'
if (!Number.isInteger(PORT) || PORT <= 0) {
  console.error('usage: node restart-target.cjs --port <n> --instance-id <id>')
  process.exit(2)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (req.method === 'GET' && url.pathname === '/api/dsh-power-button/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, instanceId: INSTANCE_ID }))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: 'not the health endpoint' }))
})
server.listen(PORT, '127.0.0.1', () => {
  console.log(`target ${INSTANCE_ID} listening on ${PORT}`)
})
