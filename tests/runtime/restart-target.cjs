'use strict'
// Minimal stand-in for a restarted DSH instance: serves the ONE endpoint the
// restart helper polls (/api/dsh-power-button/health) with a fixed instanceId.
// The runtime E2E drives the REAL generated helper against two of these
// processes (old → killed → new) so the whole chain — pid exit, port release,
// session quiescence, env-token relaunch, health confirmation — runs against
// real processes, real PIDs and a real TCP port without needing a real DSH.
const http = require('node:http')
const fs = require('node:fs')

const args = process.argv.slice(2)
function argOf(name) {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}
// `--port 0` is the case this stand-in has to cover as well as a fixed port:
// the OS picks the real one, and the test needs to learn it before it can tell
// the helper which port to wait for.
const PORT = Number(argOf('--port'))
const PORT_FILE = argOf('--port-file')
const INSTANCE_ID = argOf('--instance-id') ?? 'unknown-instance'
const FORGET_RESTART = args.includes('--forget-restart')
if (!Number.isInteger(PORT) || PORT < 0) {
  console.error('usage: node restart-target.cjs --port <n> [--port-file <path>] --instance-id <id>')
  process.exit(2)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (req.method === 'GET' && url.pathname === '/api/dsh-power-button/health') {
    // Mirror the real plugin: a process relaunched by the helper inherits
    // DSH_POWER_RESTART_ID and reports the restart identity on /health —
    // unless the test passes --forget-restart to simulate an instance that
    // cannot prove its restart (manual boot, foreign instance).
    const body = { ok: true, instanceId: INSTANCE_ID }
    if (process.env.DSH_POWER_RESTART_ID && !FORGET_RESTART) {
      body.restart = { restartId: process.env.DSH_POWER_RESTART_ID }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: 'not the health endpoint' }))
})
server.listen(PORT, '127.0.0.1', () => {
  const bound = server.address().port
  // Report the port the OS actually granted, so a --port 0 run is observable.
  if (PORT_FILE !== undefined) {
    try { fs.writeFileSync(PORT_FILE, String(bound), 'utf8') } catch { /* best-effort */ }
  }
  console.log(`target ${INSTANCE_ID} listening on ${bound}`)
})
