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
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-restart-button'
export const inject = ['webServer', 'tools', 'commands']

/** Plugin configuration (editable via the profile's cordis config / settings). */
export interface Config {
  /** Register the `restart_harness` model tool. On by default: the owner uses
   * this plugin with the agent, and the restart is a graceful `ctx.appExit`
   * (tree dispose), not a hard kill. Set false to disable the model tool and
   * keep restart exclusively on the GUI power button. */
  enableModelTool: boolean
  /** Upper bound (ms) for the model tool's delayMs argument. */
  maxDelayMs: number
}

/** Schemastery schema; cordis validates and provides it as apply(ctx, config). */
export const Config: z<Config> = z.object({
  enableModelTool: z.boolean().default(true),
  maxDelayMs: z.number().default(5000),
})

const BASE = '/api/dsh-restart-button'

/** DSH home per the official contract: explicit $DSH_HOME, else ~/.dsh. */
function dshHome(): string {
  const env = process.env.DSH_HOME?.trim()
  if (env !== undefined && env !== '') return path.resolve(env)
  return path.join(os.homedir(), '.dsh')
}
const RUNTIME_DIR = dshHome()

/** Per-process identity: fixed for this instance's lifetime. The client can
 * compare it across a restart to confirm a NEW process answered (stronger
 * than "saw a down, then an up" — works even if the down was missed). */
const INSTANCE_ID = randomUUID()

/** Set at apply time when this process is the freshly-restarted instance:
 * health reports `restarted: true, fromInstanceId: <old>` so a /restart
 * command, the model tool, or a UI click can be confirmed after the fact. */
let restartConfirmation: { fromInstanceId: string } | null = null

/** Unique helper file + per-pid log so concurrent DSH instances (e.g. a
 * profile on :3080 and the test copy on :3081) cannot overwrite each other's
 * restart helper, and logs are attributable per instance. */
const HELPER_FILE = path.join(RUNTIME_DIR, `dsh-restart-helper-${process.pid}-${Date.now()}.cjs`)
const LOG_FILE = path.join(RUNTIME_DIR, `restart-helper-${process.pid}.log`)

/** Restart marker: durable evidence that a restart happened and the current
 * process is the NEW instance. Written by restartDsh (intent), updated by the
 * helper (relaunch confirmation), read by the new process at apply time.
 * Lets a /restart command, the model tool, or a UI click answer the question
 * "did it really restart?" — the new instance reports
 * `restarted: true, fromInstanceId: <old>` on /health. */
const MARKER_FILE = path.join(RUNTIME_DIR, 'dsh-restart-marker.json')

function readMarker(): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function writeMarker(data: Record<string, unknown>): void {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true })
    fs.writeFileSync(MARKER_FILE, JSON.stringify(data), 'utf8')
  } catch { /* best-effort */ }
}

/** Whether THIS process is the freshly-restarted instance. */
function consumeRestartConfirmation(): { fromInstanceId: string } | null {
  const marker = readMarker()
  if (marker === null) return null
  const oldId = marker.fromInstanceId
  if (typeof oldId !== 'string' || oldId === INSTANCE_ID) {
    // Stale or self-referential marker: clear it and report nothing.
    try { fs.unlinkSync(MARKER_FILE) } catch { /* ignore */ }
    return null
  }
  // This is a NEW process that was launched by the restart helper.
  return { fromInstanceId: oldId }
}

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

/** Append to a log file, rotating (truncating) once it exceeds 1MB so an
 * 长期运行的实例不会无限增长。Best-effort: never throws. */
const LOG_MAX_BYTES = 1024 * 1024
function appendLog(file: string, line: string): void {
  try {
    const { size } = fs.statSync(file)
    if (size > LOG_MAX_BYTES) fs.writeFileSync(file, '', 'utf8')
  } catch { /* first write or missing file */ }
  try { fs.appendFileSync(file, line, 'utf8') } catch { /* ignore */ }
}

/** Redact credential-shaped substrings from a command line before logging. */
function redactCommandLine(parts: readonly string[]): string {
  const REDACT = /((?:api[_-]?key|token|secret|password|passwd|auth|bearer)[=:]\s*)?[\w-]{8,}/i
  return parts.map((p) => p.replace(REDACT, (_m, prefix) => (prefix ? `${prefix}***` : p))).join(' ')
}

// Boot-time breadcrumb: record how THIS process was invoked so the relaunch
// derivation can be verified against reality (execArgv vs argv split).
try {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  appendLog(LOG_FILE,
    `${new Date().toISOString()} loaded execArgv=${JSON.stringify(process.execArgv)} argv=${JSON.stringify(process.argv)} cwd=${process.cwd()}\n`)
} catch { /* ignore */ }

/**
 * Relaunch DSH. Returns immediately; the actual restart happens in a helper
 * that is fully detached from this process tree.
 */
function restartDsh(ctx, delayMs = 1500) {
  try {
    const port = resolvePort(ctx)
    // Record restart intent: the new process reads this to confirm it IS the
    // restarted instance (its own instanceId differs from the recorded old).
    writeMarker({ fromInstanceId: INSTANCE_ID, requestedAt: new Date().toISOString() })
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
const OLD_INSTANCE = ${JSON.stringify(INSTANCE_ID)};
const MARKER = ${JSON.stringify(MARKER_FILE)};
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
  log('relaunching: ' + relaunch.join(' ').replace(/((?:api[_-]?key|token|secret|password|auth)=?)[^\s]+/ig, '$1***'));
  const out = fs.openSync(SERVER_LOG, 'a');
  // spawn() reports many failures asynchronously ('error'), not synchronously;
  // wait for 'spawn' to confirm the new process is actually up, retry with
  // short backoff, and only then clean up the helper.
  const RELAUNCH_RETRIES = 3;
  async function tryRelaunch(attempt) {
    if (attempt > RELAUNCH_RETRIES) {
      log('relaunch failed after ' + RELAUNCH_RETRIES + ' attempts - giving up');
      cleanup();
      return;
    }
    const child = spawn(relaunch[0], relaunch.slice(1), {
      cwd, detached: true, stdio: ['ignore', out, out], windowsHide: true,
    });
    const spawned = await new Promise((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    });
    if (spawned) {
      child.unref();
      log('spawned pid ' + child.pid + ' (attempt ' + attempt + ')');
      // Confirm the relaunch in the marker so the new process can prove it
      // is the restarted instance.
      try {
        fs.writeFileSync(MARKER, JSON.stringify({
          fromInstanceId: OLD_INSTANCE,
          requestedAt: new Date().toISOString(),
          newPid: child.pid,
          relaunchedAt: new Date().toISOString(),
        }), 'utf8');
      } catch {}
      cleanup();
    } else {
      log('spawn error on attempt ' + attempt + ', retrying in ' + (attempt * 800) + 'ms');
      await new Promise((r) => setTimeout(r, attempt * 800));
      tryRelaunch(attempt + 1);
    }
  }
  await tryRelaunch(1);
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
    // Schedule the old process to exit AFTER the HTTP response flushes.
    // Prefer DSH's `ctx.appExit` (graceful tree dispose); fall back to
    // process.exit in non-standard embeddings.
    setTimeout(() => {
      const appExit = ctx.appExit
      if (typeof appExit === 'function') {
        appExit(0)
      } else {
        try { process.exit(0) } catch { /* ignore */ }
      }
    }, delayMs)
    return { ok: true, action: 'restart', note: 'DeepSeek Harness 正在重启，约 10 秒后恢复。重启完成后 GET /api/dsh-restart-button/health 会返回 restarted:true 与 fromInstanceId 以确认新实例。' }
  } catch (e) {
    return { ok: false, action: 'restart', error: e.message }
  }
}

/**
 * Shut down DSH gracefully. Prefers DSH's official `ctx.appExit` channel
 * (launcher-provided), which disposes the plugin tree (sessions, watchers,
 * subprocesses) with a bounded grace period instead of hard-killing via
 * `process.exit`. Falls back to `process.exit` only when the launcher did
 * not provide `appExit` (non-standard embedding).
 *
 * The exit is armed on THIS response's 'finish' so the client sees the ack
 * before the connection drops. Nothing relaunches — the user must start DSH
 * again manually.
 */
function shutdownDsh(ctx, res) {
  try {
    const exitSoon = (): void => {
      const appExit = ctx.appExit
      if (typeof appExit === 'function') {
        appExit(0)
      } else {
        try { process.exit(0) } catch { /* ignore */ }
      }
    }
    if (res !== undefined && typeof res.once === 'function') {
      // HTTP path: exit on THIS response's 'finish' so the client sees the
      // ack before the connection drops. 500ms fallback if 'finish' never
      // fires (e.g. client aborted).
      res.once('finish', exitSoon)
      setTimeout(exitSoon, 500).unref()
    } else {
      // Command path: no response object; exit after a short beat so the
      // command result flushes.
      setTimeout(exitSoon, 300).unref()
    }
    return { ok: true, action: 'shutdown', note: 'DeepSeek Harness 正在关机（进程停止后需手动重新启动）' }
  } catch (e) {
    return { ok: false, action: 'shutdown', error: e.message }
  }
}

/**
 * Trust fence for the destructive POST endpoints. These actions kill the DSH
 * process, so a malicious webpage must not trigger them cross-origin (a
 * `fetch(..., { mode: 'no-cors' })` still sends the request even though the
 * response is unreadable).
 *
 * Defense in depth — mirrors the official DSH browser-trust fence
 * (`isTrustedApiRequest` in dsh-client-connection) without importing the
 * client package:
 *   1. Loopback socket check — the request must arrive on 127.0.0.1/::1.
 *   2. Host-header fence (DNS-rebinding defense): Host must be loopback or a
 *      bare 127.0.0.1 authority — a rebound page carries the attacker's
 *      domain in Host even though the socket lands here.
 *   3. Cross-site fence: an explicit `sec-fetch-site: cross-site` is refused.
 *   4. Origin fence: when a browser attaches Origin it must equal Host
 *      (normalized); absent Origin is fine (curl/non-browser — Host already
 *      bound the request).
 *
 * NOTE: our `/api/dsh-restart-button/*` prefix is LONGER than the official
 * `/api` route, so webServer's longest-prefix-wins matching means these
 * requests never pass through the official fence automatically — this guard
 * is the only line of defense for them.
 */
function isTrustedPowerRequest(req): boolean {
  const address = req.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const { host, origin, 'sec-fetch-site': secFetchSite } = req.headers
  // Host fence: Host must be a loopback authority (we only serve loopback).
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const hn = hostUrl.hostname
  if (hn !== '127.0.0.1' && hn !== '::1' && hn !== '[::1]' && hn !== 'localhost') return false
  // Cross-site fence.
  if (typeof secFetchSite === 'string' && secFetchSite === 'cross-site') return false
  // Origin fence: present Origin must equal Host; "null" origin refused.
  if (origin === undefined) return true
  if (typeof origin !== 'string' || origin === 'null') return false
  try {
    return new URL(origin).host === hostUrl.host
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

export function apply(ctx, config: Config) {
  // If the restart marker names a DIFFERENT previous instance, this process
  // is the freshly-relaunched one — record it for /health confirmation.
  restartConfirmation = consumeRestartConfirmation()
  if (restartConfirmation !== null) {
    try {
      appendLog(LOG_FILE, `${new Date().toISOString()} restart confirmed: fromInstanceId=${restartConfirmation.fromInstanceId} thisInstanceId=${INSTANCE_ID}\n`)
    } catch { /* ignore */ }
  }
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
          const result = shutdownDsh(ctx, res)
          if (!result.ok) releasePowerTransition()
          return json(res, result.ok ? 200 : 500, result)
        }
        if (sub === '/health' && req.method === 'GET') {
          const body: Record<string, unknown> = { ok: true, instanceId: INSTANCE_ID }
          if (restartConfirmation !== null) {
            body.restarted = true
            body.fromInstanceId = restartConfirmation.fromInstanceId
          }
          return json(res, 200, body)
        }
        json(res, 404, { ok: false, error: `no dsh-restart-button endpoint ${sub}` })
      } catch (e) {
        releasePowerTransition()
        json(res, 500, { ok: false, error: e.message })
      }
    },
  }), 'dsh-restart-button: http routes')

  // Model tool: same name as anweat/dsh-restart's `restart_harness` so this
  // plugin stands in for it. On by default (config.enableModelTool); set
  // false to keep restart exclusively on the GUI button. Skip silently when
  // another plugin already owns the name (both installed) — the first
  // registrant wins.
  const cfg = config
  if (cfg.enableModelTool) {
    try {
      ctx.tools.register({
        name: 'restart_harness',
        description:
          '重启整个 DeepSeek Harness 进程，用于重新加载插件与配置（profile 的 cordis 组合、settings 等）。'
          + '由 dsh-restart-button 提供（独立实现）：派生一个 detach 的 helper，'
          + '在旧进程退出并释放端口后以原命令行在原目录重新拉起，然后旧进程退出。'
          + '触发后当前会话连接会短暂中断，网页随后自动重连到新进程。'
          + '返回 ok 与说明文本。',
        parameters: {
          type: 'object',
          properties: {
            delayMs: {
              type: 'number',
              description: `旧进程退出前等待的毫秒数（给当前结果留出回传时间），默认 2000，上限 ${cfg.maxDelayMs}。`,
            },
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
          const raw = Number(a.delayMs)
          const clamped = Number.isFinite(raw) && raw > 0
            ? Math.min(Math.floor(raw), cfg.maxDelayMs)
            : 2000
          // Same at-most-once latch as the HTTP endpoints: the model tool and
          // a concurrent UI click must not spawn two helpers.
          if (!claimPowerTransition('restart')) {
            return { ok: false, error: `power transition already in progress: ${powerTransition}` }
          }
          const result = restartDsh(ctx, clamped)
          if (!result.ok) releasePowerTransition()
          return result
        },
      })
    } catch (error) {
      // "already registered" — anweat/dsh-restart owns the name; our UI and
      // endpoints remain, the model uses theirs. Not an error.
      if (String(error).includes('already registered')) {
        try {
          appendLog(LOG_FILE, `${new Date().toISOString()} restart_harness already registered by another plugin; skipping our tool\n`)
        } catch { /* ignore */ }
      } else {
        throw error
      }
    }
  }

  // Command-bar entries, self-contained (no anweat/dsh-restart needed):
  // `/restart` and `/shutdown` share the same at-most-once latch as the UI
  // and the model tool, so a command cannot race a button click.
  ctx.effect(() => {
    ctx.commands.register({
      name: 'restart',
      description: '重启 DeepSeek Harness（重载插件与配置）',
      recordInput: false,
      async handler() {
        if (!claimPowerTransition('restart')) {
          return { kind: 'error', text: `power transition already in progress: ${powerTransition}` }
        }
        const result = restartDsh(ctx)
        if (!result.ok) releasePowerTransition()
        return result.ok
          ? { kind: 'success', text: result.note }
          : { kind: 'error', text: result.error ?? '重启失败' }
      },
    })
    ctx.commands.register({
      name: 'shutdown',
      description: '关机 DeepSeek Harness（停止进程，需手动重新启动）',
      recordInput: false,
      async handler() {
        if (!claimPowerTransition('shutdown')) {
          return { kind: 'error', text: `power transition already in progress: ${powerTransition}` }
        }
        const result = shutdownDsh(ctx, undefined)
        if (!result.ok) releasePowerTransition()
        return result.ok
          ? { kind: 'success', text: result.note }
          : { kind: 'error', text: result.error ?? '关机失败' }
      },
    })
  }, 'dsh-restart-button: commands')
}
