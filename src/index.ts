/**
 * dsh-restart-button — host half.
 *
 * Fully self-contained restart & shutdown engine for DeepSeek Harness — no
 * dependency on any other plugin (the earlier revision delegated to
 * anweat/dsh-restart; this one reimplements the engine here so the plugin is
 * an independent repo that works standalone).
 *
 * Endpoints:
 *   POST /api/dsh-restart-button/restart   — relaunch DSH (detached helper)
 *   POST /api/dsh-restart-button/shutdown  — stop DSH (graceful exit, no relaunch)
 *   GET  /api/dsh-restart-button/health    — liveness probe for the client flow
 *
 * Model tool:
 *   restart_harness — registers the SAME tool name as anweat/dsh-restart so
 *   this plugin can stand in for it. If that plugin already registered the
 *   name (both installed), the registration is skipped to avoid the
 *   "already registered" collision; if only this plugin is installed, the
 *   model gets OUR restart tool backed by this host's own engine.
 *
 * Restart mechanism (Node-native, verified reliable):
 *   - The helper MUST run outside this process tree, otherwise killing the
 *     dsh web process (which owns this plugin) also kills the helper
 *     mid-flight. So the helper is written to a real .cjs FILE under
 *     $USERPROFILE\.dsh and spawned as `node <file>` (detached + windowsHide,
 *     no console window). A `node -e` one-liner with a multiline script gets
 *     mangled on Windows (CreateProcess command line) and dies with a silent
 *     SyntaxError — the button then "restarts" into a dead instance.
 *   - The helper waits for the listen port to free, then relaunches DSH with
 *     the SAME execPath/execArgv/argv/cwd as the current process. The old
 *     process self-exits after a short delay so the HTTP response flushes.
 *   - No taskkill /T /F (it walks the parent-child chain and kills the helper),
 *     no PowerShell (window popup + quoting traps).
 *
 * Shutdown: a plain `process.exit(0)` after the response flushes — nothing
 * relaunches, so DSH stays down until the user starts it again.
 *
 * Design note (license): the detached-helper relaunch idea is the same
 * approach used by anweat/dsh-restart (MIT); the implementation here is
 * original — the helper is written to a real .cjs file rather than a `node
 * -e` one-liner, which avoids a Windows CreateProcess mangling failure. See
 * README for the full attribution note.
 * @module dsh-restart-button
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-restart-button'
export const inject = ['webServer', 'tools']

const BASE = '/api/dsh-restart-button'
const RUNTIME_DIR = path.join(os.homedir(), '.dsh')

/** Per-process identity: fixed for this instance's lifetime. The client can
 * compare it across a restart to confirm a NEW process answered (stronger
 * than "saw a down, then an up" — works even if the down was missed). */
const INSTANCE_ID = randomUUID()

/** Unique helper file + per-pid log so concurrent DSH instances (e.g. a
 * profile on :3080 and the test copy on :3081) cannot overwrite each other's
 * restart helper, and logs are attributable per instance. */
const HELPER_FILE = path.join(RUNTIME_DIR, `dsh-restart-helper-${process.pid}-${Date.now()}.cjs`)
const LOG_FILE = path.join(RUNTIME_DIR, `restart-helper-${process.pid}.log`)

/**
 * Resolve the port the current web server listens on. Prefer the actual
 * `--port` argument (the CLI accepts `--port 0` for an OS-assigned port, in
 * which case the real port is only known after listen — fall back to the
 * webServer service's bound address when available). The helper must wait for
 * THIS port to free; a hardcoded 3080 breaks restart on any other port
 * (e.g. the test copy on 3081).
 */
function resolvePort(ctx): number {
  try {
    const bound = ctx.webServer?.server?.address?.()
    if (bound && typeof bound === 'object' && typeof bound.port === 'number' && bound.port > 0) {
      return bound.port
    }
  } catch { /* webServer shape differs across versions */ }
  const argv = process.argv
  const idx = argv.indexOf('--port')
  if (idx >= 0 && idx + 1 < argv.length) {
    const n = Number(argv[idx + 1])
    if (Number.isFinite(n) && n > 0) return n
  }
  return 3080
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

// Boot-time breadcrumb: record how THIS process was invoked so the relaunch
// derivation can be verified against reality (execArgv vs argv split).
try {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  fs.appendFileSync(LOG_FILE,
    `${new Date().toISOString()} loaded execArgv=${JSON.stringify(process.execArgv)} argv=${JSON.stringify(process.argv)} cwd=${process.cwd()}\n`)
} catch { /* ignore */ }

/**
 * Relaunch DSH. Returns immediately; the actual restart happens in a helper
 * that is fully detached from this process tree.
 */
function restartDsh(ctx, delayMs = 1500) {
  try {
    const port = resolvePort(ctx)
    // Replay the CURRENT invocation, portably (no hard-coded paths):
    // execArgv carries node flags (e.g. --import tsx/esm), argv the entry
    // script + app args. Spawned children inherit env, so any NODE_OPTIONS
    // that launched us is preserved too.
    const relaunch = JSON.stringify([process.execPath, ...process.execArgv, ...process.argv.slice(1)])
    const cwd = process.cwd()
    const serverLog = path.join(RUNTIME_DIR, 'dsh-web.log')
    const helperScript = `'use strict';
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const relaunch = ${relaunch};
const cwd = ${JSON.stringify(cwd)};
const PORT = ${port};
const OLD_PID = ${process.pid};
const LOG = ${JSON.stringify(LOG_FILE)};
const SERVER_LOG = ${JSON.stringify(serverLog)};
function log(m) {
  try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + m + '\\n'); } catch {}
}
function pidGone(pid) {
  try { process.kill(pid, 0); return false; } catch { return true; }
}
function portFree(p) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port: p });
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(true));
  });
}
(async () => {
  log('helper up: old pid ' + OLD_PID + ', waiting for it to exit');
  let gone = false;
  for (let i = 0; i < 60; i++) {
    if (pidGone(OLD_PID)) { gone = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!gone) { log('old process never exited - giving up'); cleanup(); return; }
  log('old pid gone, waiting for port ' + PORT + ' to free');
  let freed = false;
  for (let i = 0; i < 60; i++) {
    if (await portFree(PORT)) { freed = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!freed) { log('port never freed - giving up'); cleanup(); return; }
  await new Promise((r) => setTimeout(r, 500)); // settle: let the socket fully release
  log('relaunching: ' + relaunch.join(' '));
  const out = fs.openSync(SERVER_LOG, 'a');
  const child = spawn(relaunch[0], relaunch.slice(1), {
    cwd, detached: true, stdio: ['ignore', out, out], windowsHide: true,
  });
  child.unref();
  log('spawned pid ' + child.pid);
  cleanup();
  function cleanup() { try { fs.unlinkSync(__filename); } catch {} }
})();
`
    fs.mkdirSync(RUNTIME_DIR, { recursive: true })
    fs.writeFileSync(HELPER_FILE, helperScript, 'utf8')
    const helper = spawn(process.execPath, [HELPER_FILE], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    helper.unref()
    // Schedule the old process to self-exit AFTER the HTTP response flushes.
    setTimeout(() => {
      try { process.exit(0) } catch { /* ignore */ }
    }, delayMs)
    return { ok: true, action: 'restart', note: 'DeepSeek Harness 正在重启，约 10 秒后恢复' }
  } catch (e) {
    return { ok: false, action: 'restart', error: e.message }
  }
}

/**
 * Shut down DSH. Returns immediately; the process exits once the HTTP
 * response has actually finished flushing to the socket (res 'finish'),
 * so the client sees the ack before the connection drops — no fixed delay,
 * no perceived hang. Nothing relaunches — the user must start DSH again
 * manually.
 */
function shutdownDsh(res) {
  try {
    // Arm the exit on THIS response's 'finish' so process.exit runs right
    // after the ack bytes leave the socket. Fallback: 500ms cap in case
    // 'finish' never fires (e.g. client aborted mid-request).
    const exitSoon = (): void => {
      try { process.exit(0) } catch { /* ignore */ }
    }
    res.once('finish', exitSoon)
    setTimeout(exitSoon, 500).unref()
    return { ok: true, action: 'shutdown', note: 'DeepSeek Harness 正在关机' }
  } catch (e) {
    return { ok: false, action: 'shutdown', error: e.message }
  }
}

/**
 * CSRF/same-origin guard for the destructive POST endpoints. These actions
 * kill the DSH process, so a malicious webpage must not be able to trigger
 * them cross-origin (a `fetch(..., { mode: 'no-cors' })` still sends the
 * request even though the response is unreadable). Accept only:
 *   - loopback client, AND
 *   - a same-origin `Origin` header (browser sends it on POST), OR no Origin
 *     at all (non-browser clients like curl — they cannot carry cookies that
 *     a browser would attach anyway).
 * `sec-fetch-site: cross-site` is an extra, non-authoritative hint: reject it
 * when present.
 */
function isTrustedPowerRequest(req): boolean {
  const address = req.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const { origin, host, 'sec-fetch-site': secFetchSite } = req.headers
  if (typeof secFetchSite === 'string' && secFetchSite === 'cross-site') return false
  if (origin === undefined) return true // non-browser client
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

/**
 * At-most-once latch for destructive power transitions. Restart and shutdown
 * both end the current process; a second POST (duplicate tab, model tool +
 * UI race, client retry) must not spawn a second helper or double-exit.
 * Claimed on first POST, released only if the action fails synchronously
 * (the process is exiting on success, so the latch never needs clearing).
 */
let powerTransition: 'restart' | 'shutdown' | null = null

function claimPowerTransition(action: 'restart' | 'shutdown'): boolean {
  if (powerTransition !== null) return false
  powerTransition = action
  return true
}

function releasePowerTransition(): void {
  powerTransition = null
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://x')
      const sub = url.pathname.slice(BASE.length).replace(/\/+$/, '') || '/'
      // Destructive POSTs require the same-origin guard; health stays open.
      const needsGuard = (sub === '/restart' || sub === '/shutdown') && req.method === 'POST'
      if (needsGuard && !isTrustedPowerRequest(req)) {
        return json(res, 403, { ok: false, error: 'forbidden: cross-origin power request' })
      }
      try {
        if (sub === '/restart' && req.method === 'POST') {
          if (!claimPowerTransition('restart')) {
            return json(res, 409, { ok: false, error: `power transition already in progress: ${powerTransition}` })
          }
          const result = restartDsh(ctx)
          if (!result.ok) releasePowerTransition()
          return json(res, result.ok ? 200 : 500, result)
        }
        if (sub === '/shutdown' && req.method === 'POST') {
          if (!claimPowerTransition('shutdown')) {
            return json(res, 409, { ok: false, error: `power transition already in progress: ${powerTransition}` })
          }
          const result = shutdownDsh(res)
          if (!result.ok) releasePowerTransition()
          return json(res, result.ok ? 200 : 500, result)
        }
        if (sub === '/health' && req.method === 'GET') {
          return json(res, 200, { ok: true, instanceId: INSTANCE_ID })
        }
        json(res, 404, { ok: false, error: `no dsh-restart-button endpoint ${sub}` })
      } catch (e) {
        releasePowerTransition()
        json(res, 500, { ok: false, error: e.message })
      }
    },
  }), 'dsh-restart-button: http routes')

  // Model tool: same name as anweat/dsh-restart's `restart_harness` so this
  // plugin stands in for it. Skip silently when another plugin already owns
  // the name (both installed) — the first registrant wins.
  try {
    ctx.tools.register({
      name: 'restart_harness',
      description:
        '重启整个 DeepSeek Harness 进程，用于重新加载插件与配置（profile 的 cordis 组合、settings 等）。'
        + '由 dsh-restart-button 提供（独立实现）：派生一个 detach 的 helper，'
        + '在旧进程退出并释放端口后以原命令行在原目录重新拉起，然后旧进程退出。'
        + '触发后当前会话连接会短暂中断，网页随后自动重连到新进程。'
        + '返回旧进程 pid、cwd、命令行与日志文件路径。',
      parameters: {
        type: 'object',
        properties: {
          delayMs: { type: 'number', description: '旧进程退出前等待的毫秒数（给当前结果留出回传时间），默认 2000。' },
        },
      },
      output: {
        // NOTE: `type: 'json'` is an author-only spec value — raw
        // `ctx.tools.register` feeds the schema straight to
        // assertSupportedJsonSchema, which only knows
        // object/array/string/number/integer/boolean/null and would throw.
        // An empty schema (annotation-only) accepts any JSON value.
        schema: {},
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(args) {
        const a = (args ?? {}) as { delayMs?: number }
        const delayMs = Number(a.delayMs) > 0 ? Math.floor(Number(a.delayMs)) : 2000
        // Same at-most-once latch as the HTTP endpoints: the model tool and a
        // concurrent UI click must not spawn two helpers.
        if (!claimPowerTransition('restart')) {
          return { ok: false, error: `power transition already in progress: ${powerTransition}` }
        }
        const result = restartDsh(ctx, delayMs)
        if (!result.ok) releasePowerTransition()
        return result
      },
    })
  } catch (error) {
    // "already registered" — anweat/dsh-restart owns the name; our UI and
    // endpoints remain, the model uses theirs. Not an error.
    if (String(error).includes('already registered')) {
      try {
        fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} restart_harness already registered by another plugin; skipping our tool\n`)
      } catch { /* ignore */ }
    } else {
      throw error
    }
  }
}
