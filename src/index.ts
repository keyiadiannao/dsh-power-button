/**
 * dsh-power-button — host half.
 *
 * Fully self-contained restart & shutdown engine for DeepSeek Harness — no
 * dependency on any other plugin (the earlier revision delegated to
 * anweat/dsh-restart; this one reimplements the engine here so the plugin is
 * an independent repo that works standalone).
 *
 * Endpoints:
 *   POST /api/dsh-power-button/restart   — relaunch DSH (detached helper)
 *   POST /api/dsh-power-button/shutdown  — stop DSH (graceful exit, no relaunch)
 *   GET  /api/dsh-power-button/health    — liveness probe for the client flow
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
 * Shutdown: prefers DSH's `ctx.appExit` graceful tree dispose (with
 * `process.exit(0)` as fallback for non-standard embeddings); nothing
 * relaunches, so DSH stays down until the user starts it again.
 *
 * Design note (license): the detached-helper relaunch idea is the same
 * approach used by anweat/dsh-restart (MIT); the implementation here is
 * original — the helper is written to a real .cjs file rather than a `node
 * -e` one-liner, which avoids a Windows CreateProcess mangling failure. See
 * README for the full attribution note.
 * @module dsh-power-button
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { SHUTDOWN_CONFIRM_REQUEST } from './protocol.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Restart lifecycle notices this plugin queues for the originating session. */
    'dsh-power-button': { kind: 'dsh-power-button' } & ContextFormed
  }
}

/** Plugin version, read from package.json so /health can report it. */
const require = createRequire(import.meta.url)
const PLUGIN_VERSION = (require('../package.json') as { version?: string }).version ?? '0.0.0'

export const name = 'dsh-power-button'
export const inject = ['webServer', 'tools', 'commands', 'sessions', 'settings', 'agents']

/** Plugin configuration (editable via the profile's cordis config / settings). */
export interface Config {
  /** Register the `restart_harness` model tool. On by default: the owner uses
   * this plugin with the agent, and the restart is a graceful `ctx.appExit`
   * (tree dispose), not a hard kill. Set false to disable the model tool and
   * keep restart exclusively on the GUI power button. */
  enableModelTool: boolean
  /** Upper bound (ms) for the model tool's delayMs argument. */
  maxDelayMs: number
  /**
   * What the session that asked for a restart is told afterwards.
   *
   * `quiet` persists a notice and injects it the next time that session is
   * live, without waking anything. `notify` additionally wakes that session
   * once it is live, so the model reports the restart without the user sending
   * a message. Waking is the only difference; neither mode ever restarts again
   * on its own.
   */
  restartWakeMode: 'quiet' | 'notify'
}

/**
 * Message text for a restart notice, used by both wake modes.
 *
 * The closing constraint is not decoration: waking a session makes the model
 * act without a user turn, so the notice has to bound that action to reporting
 * the restart it is about.
 */
export function restartNoticeText(restart: { fromInstanceId: string, restartId?: string }): string {
  return [
    'DeepSeek Harness lifecycle notice: this process restarted successfully.',
    restart.restartId !== undefined ? `Restart id: ${restart.restartId}.` : '',
    `It replaced instance ${restart.fromInstanceId}; port, profile and working directory are unchanged.`,
    'This restart was requested by this session, and it has already happened — do not repeat it unless something is still wrong.',
    'Report the restart result and continue only what the user asks for next; do not resume other side-effecting work on your own.',
  ].filter((line) => line !== '').join(' ')
}

/** Schemastery schema; cordis validates and provides it as apply(ctx, config). */
export const Config: z<Config> = z.object({
  enableModelTool: z.boolean().default(true),
  // The model delay floor (MIN_MODEL_DELAY_MS) is only meaningful while the
  // configured ceiling is at least that floor — clampModelDelayMs then always
  // lands in [1000, maxDelayMs]. A ceiling below the floor would let a config
  // value silently defeat the 1000ms floor (e.g. maxDelayMs: 200 → clamp
  // returns 200), so reject it at schema validation time.
  maxDelayMs: z.number().default(5000).min(1000),
  restartWakeMode: z.union([z.const('quiet'), z.const('notify')]).default('quiet'),
})

const BASE = '/api/dsh-power-button'

/** DSH home per the official contract: explicit $DSH_HOME, else ~/.dsh. */
function dshHome(): string {
  const env = process.env.DSH_HOME?.trim()
  if (env !== undefined && env !== '') return path.resolve(env)
  return path.join(os.homedir(), '.dsh')
}
const RUNTIME_DIR = dshHome()

/** Port this instance serves, resolved at apply time. Markers are keyed by
 * port so concurrent instances (e.g. :3080 and :3081) never read each other's
 * restart markers — otherwise instance B would consume instance A's marker
 * and wrongly report "restarted from A". */
let CURRENT_PORT = 3080

/** Per-port marker path. Exported for tests (isolated via DSH_HOME). */
export function markerPath(): string {
  return path.join(RUNTIME_DIR, `dsh-power-marker-${CURRENT_PORT}.json`)
}

/** Per-process identity: fixed for this instance's lifetime. The client can
 * compare it across a restart to confirm a NEW process answered (stronger
 * than "saw a down, then an up" — works even if the down was missed). */
const INSTANCE_ID = randomUUID()

/**
 * Who asked for a restart.
 *
 * `sessionId` is only ever recorded from a caller that actually has a causal
 * agent: the model tool's `exec.agent` or the command's `invocation.agent`. A
 * plain HTTP POST has none, and guessing one would attribute the restart — and
 * any notice derived from it — to an unrelated conversation.
 */
export interface RestartOrigin {
  kind: 'model-tool' | 'command' | 'http'
  /** The session that asked, when the caller has one. Never guessed. */
  sessionId?: string
}

/** Set at apply time when this process is the freshly-restarted instance.
 * Split from the toast acknowledgement: `bootRestart` is this process's
 * restart IDENTITY — immutable for its lifetime, reported on /health as
 * `restart` forever, so the helper (and future diagnostics) can always tell a
 * relaunched instance from a fresh boot. `restartNoticePending` is only the
 * UI toast state; ACKing it (/notice-shown) must not erase the identity. */
let bootRestart: { fromInstanceId: string, restartId?: string, origin?: RestartOrigin } | null = null
let restartNoticePending = false

/** Unique helper file + per-pid log so concurrent DSH instances (e.g. a
 * profile on :3080 and the test copy on :3081) cannot overwrite each other's
 * restart helper, and logs are attributable per instance. */
const HELPER_FILE = path.join(RUNTIME_DIR, `dsh-restart-helper-${process.pid}-${Date.now()}.cjs`)
const LOG_FILE = path.join(RUNTIME_DIR, `restart-helper-${process.pid}.log`)

/** Restart marker: durable evidence that a restart happened and the current
 * process is the NEW instance. Written by restartDsh (intent), rewritten by
 * the helper as a v2 marker bound to a launch env token BEFORE it spawns the
 * new process, read by the new process at apply time.
 * Lets a /restart command, the model tool, or a UI click answer the question
 * "did it really restart?" — the new instance reports
 * `restarted: true, fromInstanceId: <old>` on /health. Keyed by port. */
function readMarker(): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(markerPath(), 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Record restart intent. Exported for tests (isolated via DSH_HOME). */
export function writeMarker(data: Record<string, unknown>): void {
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 })
    fs.writeFileSync(markerPath(), JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
  } catch { /* best-effort */ }
}

/**
 * Read a recorded restart origin, discarding anything malformed. The marker is
 * durable input that outlives the process that wrote it, so an unrecognized
 * kind is dropped rather than trusted as an attribution.
 */
function readRestartOrigin(value: unknown): RestartOrigin | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const kind = record.kind
  if (kind !== 'model-tool' && kind !== 'command' && kind !== 'http') return undefined
  const sessionId = record.sessionId
  return typeof sessionId === 'string' && sessionId.length > 0 ? { kind, sessionId } : { kind }
}

/**
 * Whether THIS process is the freshly-restarted instance. Exported for tests.
 *
 * Two marker generations are accepted:
 *  - **v2** (current): the helper writes the marker BEFORE spawning the new
 *    process and binds it to that boot with a `DSH_POWER_RESTART_ID` token in
 *    the child's environment. A marker only counts when the env token matches,
 *    so a manual boot can never claim a restart — and because the marker
 *    already exists when the child starts, the new instance can never read
 *    "no marker yet" (the v1 race, where the helper confirmed the relaunch
 *    only after the child had spawned).
 *  - **v1** (plugin 0.2.2 helpers): the helper confirmed the relaunch AFTER
 *    spawning by recording the exact child pid. Still accepted so the first
 *    restart performed by a pre-upgrade detached helper still reports.
 */
export function consumeRestartConfirmation(): { fromInstanceId: string, restartId?: string, origin?: RestartOrigin } | null {
  // Read-and-delete the launch token FIRST: it belongs to this boot's judgment
  // only, and must not leak to MCP children or survive into a later decision.
  const envRestartId = process.env.DSH_POWER_RESTART_ID
  delete process.env.DSH_POWER_RESTART_ID
  const marker = readMarker()
  if (marker === null) return null
  const oldId = marker.fromInstanceId
  if (typeof oldId !== 'string' || oldId === INSTANCE_ID) {
    // Stale or self-referential marker: clear it and report nothing.
    try { fs.unlinkSync(markerPath()) } catch { /* ignore */ }
    return null
  }
  const origin = readRestartOrigin(marker.origin)
  if (marker.schemaVersion === 2 && typeof marker.restartId === 'string') {
    try { fs.unlinkSync(markerPath()) } catch { /* ignore */ }
    // Without the matching launch token this is an unrelaunched intent (the
    // helper died before spawning) or a MANUAL boot: neither may claim the
    // restart, and the leftover marker is cleared so it cannot linger.
    if (envRestartId !== undefined && marker.restartId === envRestartId) {
      return { fromInstanceId: oldId, restartId: marker.restartId, ...(origin !== undefined ? { origin } : {}) }
    }
    return null
  }
  // v1: only the exact process the helper spawned may claim the restart.
  const relaunched = typeof marker.relaunchedAt === 'string'
    && Number.isInteger(marker.newPid)
    && (marker.newPid as number) === process.pid
  try { fs.unlinkSync(markerPath()) } catch { /* ignore */ }
  if (!relaunched) return null
  return { fromInstanceId: oldId, ...(origin !== undefined ? { origin } : {}) }
}

// ---------------------------------------------------------------------------
// Restart awareness (non-waking)
// ---------------------------------------------------------------------------
// A restarted harness knows something the conversation that asked for it does
// not: the restart finished. `agent.inject()` queues model-facing context for
// the next pre-step WITHOUT waking the driver — an idle agent leaves it pending
// until a follow-up or steering wakes it — so the notice is already waiting the
// next time that session runs, and the user never has to explain what happened.
//
// Nothing here wakes an agent, opens a turn, or appends a model-visible message
// itself. Delivery goes through `Agent.inject()`, which durably stages an
// `agent/inbox/spliced` record and lets the next legitimate step claim it. That
// distinction is the point: this plugin never forges a turn, a user message, or
// a crash tail — every model-visible channel that is not step-scoped would
// require exactly that.

/** Directory of notices awaiting a live agent, at most one per session. */
function noticeDir(): string {
  return path.join(RUNTIME_DIR, 'power-notice')
}

function noticePath(restartId: string): string {
  return path.join(noticeDir(), `${restartId}.json`)
}

/** The one-line account the `notice` context form carries. */
export function restartNoticeSummary(restart: { fromInstanceId: string }): string {
  return `DeepSeek Harness restarted (replacing instance ${restart.fromInstanceId})`
}

/**
 * Drop every queued notice already addressed to one session.
 *
 * A notice says "here is what happened while you were away, do not repeat it",
 * so only the newest one for a session is true. Without this, a session that
 * stays closed across several restarts would collect the whole backlog and
 * receive it in one burst, in directory order, when it finally reopens.
 * @param sessionId - the session whose queued notices are superseded.
 */
function dropNoticesForSession(sessionId: string): void {
  let names: string[]
  try { names = fs.readdirSync(noticeDir()) } catch { return }
  for (const fileName of names) {
    if (!fileName.endsWith('.json')) continue
    const file = path.join(noticeDir(), fileName)
    const record = readJsonFile(file)
    if (record?.sessionId !== sessionId) continue
    try { fs.unlinkSync(file) } catch { /* superseded; a stale copy is harmless */ }
  }
}

/**
 * Persist one restart's notice, replacing any notice already queued for the
 * same session.
 *
 * Written to disk rather than held in memory so a session that is not live yet
 * still receives it after the next boot. A restart whose caller had no causal
 * session queues nothing: an origin-less restart must never be attributed to
 * whichever conversation happens to be open.
 * @param restart - the restart being reported.
 * @param mode - whether the notice may wake the session once it is live.
 */
export function queueRestartNotice(
  restart: { fromInstanceId: string, restartId?: string, origin?: RestartOrigin },
  mode: 'quiet' | 'notify' = 'quiet',
): void {
  const sessionId = restart.origin?.sessionId
  if (sessionId === undefined || sessionId.length === 0) return
  const restartId = restart.restartId ?? `legacy-${String(Date.now())}`
  try {
    dropNoticesForSession(sessionId)
    writeJsonAtomic(noticePath(restartId), {
      schemaVersion: 1,
      restartId,
      sessionId,
      summary: restartNoticeSummary(restart),
      text: restartNoticeText(restart),
      mode,
      queuedAt: new Date().toISOString(),
    })
  } catch { /* best-effort: a missing notice beats a failed boot */ }
}

/**
 * Deliver every queued notice whose session is live; keep the rest queued.
 *
 * Idempotent by construction: a delivered notice is deleted, so a later boot
 * cannot replay it. A notice whose session is not live is never reassigned to a
 * different session and never wakes one — it simply waits. At most one notice
 * per session exists, so a reconnecting session receives at most one.
 *
 * A `notify` notice wakes its session with `followup` once it is live, which is
 * the only difference from `quiet`: both carry the same text, and neither ever
 * restarts again on its own. The session is woken at most once — the notice is
 * deleted after a successful delivery, so a later boot finds nothing to replay.
 * @param ctx - host context carrying the agent registry.
 * @returns the number of notices delivered.
 */
export function deliverPendingNotices(ctx: any): number {
  let names: string[]
  try { names = fs.readdirSync(noticeDir()) } catch { return 0 }
  let delivered = 0
  for (const fileName of names) {
    if (!fileName.endsWith('.json')) continue
    const file = path.join(noticeDir(), fileName)
    const record = readJsonFile(file)
    if (record === null
      || typeof record.sessionId !== 'string'
      || typeof record.text !== 'string'
      || typeof record.summary !== 'string') {
      // An unreadable, incomplete or malformed record cannot be attributed to
      // anyone, and has no one-line account to present.
      try { fs.unlinkSync(file) } catch { /* ignore */ }
      continue
    }
    const agent = ctx.agents?.get?.(record.sessionId)
    if (agent === undefined || agent === null) continue
    const message = createUserMessage({
      content: [{ type: 'text', text: record.text }],
      source: {
        kind: 'dsh-power-button',
        form: 'notice',
        summary: record.summary,
      },
    })
    try {
      // `followup` wakes the driver and opens a turn; `inject` only stages the
      // context for the next legitimate step. Both are the sanctioned paths —
      // neither forges a message.
      if (record.mode === 'notify') agent.followup(message)
      else agent.inject(message)
    } catch {
      // A rejected delivery (disposed agent, closed inbox) keeps the record for a
      // later attempt rather than dropping the only evidence of the restart.
      continue
    }
    delivered += 1
    try {
      appendLog(LOG_FILE, `${new Date().toISOString()} restart notice delivered to session=${record.sessionId}`
        + ` restartId=${typeof record.restartId === 'string' ? record.restartId : 'unknown'}`
        + ` mode=${record.mode === 'notify' ? 'notify' : 'quiet'}\n`)
    } catch { /* ignore */ }
    try { fs.unlinkSync(file) } catch { /* delivered; a stale copy is harmless */ }
  }
  return delivered
}

// ---------------------------------------------------------------------------
// Restart diagnostics
// ---------------------------------------------------------------------------

/** Whether the newest restart record describes THIS process. */
function recordDescribesThisBoot(record: Record<string, unknown>): boolean {
  if (bootRestart === null) return false
  // A record without a restartId comes from a marker generation that predates
  // them, so the instance it replaced is the only field both sides share.
  if (typeof record.restartId !== 'string' || typeof bootRestart.restartId !== 'string') {
    return record.fromInstanceId === bootRestart.fromInstanceId
  }
  return record.restartId === bootRestart.restartId
}

/**
 * Read-only view of the most recent restart: the durable record the helper
 * wrote, plus whether this process is the instance that restart produced.
 *
 * This is the authoritative half of restart awareness. A notice reaches the
 * session that asked; this answers the question for anyone else — including a
 * restart started from the GUI or the command bar, which has no session to
 * notify and would otherwise be invisible to a model.
 * @param ctx - host context, used to resolve the port the record is keyed by.
 * @returns the record, or `{ found: false }` when no restart has happened.
 */
export function restartStatus(ctx: any): Record<string, unknown> {
  const record = readJsonFile(lastRestartPath(resolvePort(ctx)))
  if (record === null && bootRestart === null) return { found: false }
  const requestedAt = record?.requestedAt
  const readyAt = record?.readyAt
  const elapsedMs = typeof requestedAt === 'string' && typeof readyAt === 'string'
    ? Date.parse(readyAt) - Date.parse(requestedAt)
    : undefined
  // Absent fields are OMITTED, never set to undefined. Tool output must survive
  // a JSON round trip (`JSON.stringify` drops undefined-valued keys, so an
  // object carrying one is not lossless), and DSH rejects a tool result that
  // fails that check.
  const optional: Record<string, unknown> = {
    restartId: record?.restartId ?? bootRestart?.restartId,
    stage: record?.stage,
    fromInstanceId: record?.fromInstanceId ?? bootRestart?.fromInstanceId,
    toInstanceId: record?.toInstanceId,
    requestedAt,
    readyAt,
    elapsedMs: elapsedMs !== undefined && Number.isFinite(elapsedMs) ? elapsedMs : undefined,
    origin: record?.origin ?? bootRestart?.origin,
    sessionQuiescent: record?.sessionQuiescent,
    failure: record?.failure,
  }
  const status: Record<string, unknown> = {
    found: true,
    // True only when this running process is the one that restart produced.
    isCurrentBoot: record === null ? bootRestart !== null : recordDescribesThisBoot(record),
    thisInstanceId: INSTANCE_ID,
  }
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) status[key] = value
  }
  return status
}

/**
 * Resolve the port the current web server listens on. Prefer the actual
 * `--port` argument (the CLI accepts `--port 0` for an OS-assigned port, in
 * which case the real port is only known after listen — fall back to the
 * webServer service's bound address when available). The helper must wait for
 * THIS port to free; a hardcoded 3080 breaks restart on any other port
 * (e.g. the test copy on 3081).
 */
function resolvePort(ctx: any): number {
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

function json(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
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

/**
 * Redact credential-shaped content from a command line before logging.
 * Handles both shapes:
 *   --api-key=sk-xxx          (inline key=value → value redacted)
 *   --api-key sk-xxx          (separate key token → next value redacted)
 * Long bare tokens that look like secrets are redacted as a whole so a
 * plugin CLI arg that passes a raw credential value cannot leak. Ordinary
 * long words ("description", a repo path) would be over-redacted, so the
 * bare-token rule only fires when the previous token is a credential key
 * OR the token itself looks secret-shaped (starts with a known secret
 * prefix such as `sk-`, `ghp_`, `xox`).
 */
export function redactCommandLine(parts: readonly string[]): string {
  const KEY = /^(--?[a-z0-9_-]*)?(api[_-]?key|token|secret|password|passwd|auth|bearer)$/i
  const INLINE = /((?:api[_-]?key|token|secret|password|passwd|auth|bearer)[=:]\s*)([\w-]{8,})/i
  const BARE_SECRET = /^(sk-|ghp_|gho_|xox[bap]-|AKIA|-----BEGIN)[\w-]+/i
  return parts.map((part, index) => {
    // The value following a credential KEY token is the secret.
    if (index > 0 && KEY.test(parts[index - 1] ?? '')) return '***'
    return part
      .replace(INLINE, '$1***')
      .replace(BARE_SECRET, '***')
  }).join(' ')
}

/** Floor/clamp the model-visible restart delay: the model must never be able
 * to kill the process before its own tool/result and turn boundary settle.
 * The floor applies whenever a numeric positive delay is given; the ceiling
 * (config.maxDelayMs, schema-validated >= 1000) caps every outcome INCLUDING
 * the non-numeric fallback, so clamp(anything, maxDelayMs) ∈ [1000, maxDelayMs]. */
export function clampModelDelayMs(raw: number, maxDelayMs: number): number {
  const MIN_MODEL_DELAY_MS = 1000
  const desired = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2000
  return Math.min(Math.max(desired, MIN_MODEL_DELAY_MS), maxDelayMs)
}

/** Last-resort exit for embeddings that never provided the launcher channel. */
function hardExit(): void {
  try { process.exit(0) } catch { /* ignore */ }
}

/**
 * Bounded grace after the launcher has been asked to exit: DSH disposes the
 * application tree with its own 5s cap, but that cap only force-exits while
 * disposal is still running — a disposal that resolves early leaves the
 * process to end on its own, and one lingering handle (background job, MCP
 * child, plugin-owned listener) then keeps the loop alive. The restart helper
 * waits 30s for the old pid and gives up WITHOUT relaunching, so an unbounded
 * graceful exit can leave the user with no server at all. 15s clears DSH's own
 * 5s grace and still lands well inside the helper's patience.
 */
export const APP_EXIT_WATCHDOG_MS = 15_000

/**
 * Request the launcher's bounded process exit, falling back to
 * {@link hardExit} when the host never provided the channel (non-standard
 * embedding) or when the graceful exit has not landed by
 * {@link APP_EXIT_WATCHDOG_MS}.
 *
 * Reads through the global service store (`ctx.get`), NOT the property proxy:
 * `appExit` is an optional launcher-provided host value this plugin does not
 * declare in `inject`, so `ctx.appExit` is undefined and the graceful branch
 * would never run — every restart/shutdown silently took the `process.exit`
 * fallback, skipping tree disposal, storage flush, and port release. Official
 * readers (dsh-cmdline, dsh-headless) read it through `ctx.get` for the same
 * reason.
 *
 * @param ctx - plugin context; a host without the Cordis store also falls back.
 * @param fallbackExit - seam for tests; defaults to the real `process.exit`.
 * @param watchdogMs - seam for tests; defaults to {@link APP_EXIT_WATCHDOG_MS}.
 */
export function requestAppExit(
  ctx: any,
  fallbackExit: () => void = hardExit,
  watchdogMs = APP_EXIT_WATCHDOG_MS,
): void {
  const appExit = ctx?.get?.('appExit')
  if (typeof appExit !== 'function') {
    fallbackExit()
    return
  }
  appExit(0)
  // Unref'd: a watchdog must never be the reason the process stays alive.
  const watchdog = setTimeout(fallbackExit, watchdogMs)
  watchdog.unref?.()
}

/** Startup housekeeping: prune old restart-helper logs and handshake records so
 * ~/.dsh does not accumulate one file per restart forever.
 *
 * The helper SCRIPT is pruned too, and deliberately: it embeds the full
 * relaunch argv (which can carry an --api-key), and its self-delete only runs
 * on a path the helper reaches itself. A helper that is killed instead of
 * finishing — the Host kills a half-armed one when the handshake fails — never
 * reaches cleanup(), so the argv-bearing file would otherwise stay forever.
 *
 * Queued restart notices are pruned on the same window: one whose session never
 * comes back must not describe a restart that has long stopped mattering.
 * Best-effort, never throws. */
export function pruneOldRestartLogs(maxAgeDays = 7): void {
  const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000

  const prune = (dir: string, claims: (name: string) => boolean): void => {
    let names: string[]
    try { names = fs.readdirSync(dir) } catch { return }
    for (const name of names) {
      if (!claims(name)) continue
      const full = path.join(dir, name)
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full)
      } catch { /* ignore */ }
    }
  }

  prune(RUNTIME_DIR, (name) =>
    (name.startsWith('restart-helper-') && name.endsWith('.log'))
    || (name.startsWith('dsh-restart-helper-') && name.endsWith('.cjs')))
  prune(restartDir(), (name) => name.endsWith('.status.json') || name.endsWith('.commit.json'))
  // A notice whose session never comes back would otherwise wait forever and
  // then describe a restart that is long irrelevant.
  prune(noticeDir(), (name) => name.endsWith('.json'))
}

/** Boot breadcrumb with an ALLOWLIST of diagnostic fields only. The full
 * argv is never logged: plugin CLI args can carry credentials (--api-key
 * sk-xxx etc), and even a good redactor is one regex away from leaking a
 * value. Keep execPath/script/port/profile/pid/cwd-basename only. */
function bootBreadcrumb(): string {
  const argv = process.argv
  const portIndex = argv.indexOf('--port')
  const profileIndex = argv.indexOf('--profile')
  const script = argv.find(a => /(^|[\\/])bin\.(ts|js)$/.test(a)) ?? argv[1] ?? ''
  return [
    `pid=${process.pid}`,
    `execPath=${process.execPath}`,
    `script=${script}`,
    profileIndex > 0 ? `profile=${argv[profileIndex + 1] ?? ''}` : '',
    portIndex > 0 ? `port=${argv[portIndex + 1] ?? ''}` : '',
    `cwd=${path.basename(process.cwd())}`,
  ].filter(Boolean).join(' ')
}

// Boot-time breadcrumb: record the invocation allowlist so relaunch
// derivation can be checked against reality, without ever logging argv.
try {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 })
  appendLog(LOG_FILE, `${new Date().toISOString()} loaded ${bootBreadcrumb()}\n`)
} catch { /* ignore */ }

// ---------------------------------------------------------------------------
// Restart v2 handshake
// ---------------------------------------------------------------------------
// This process may not schedule its own exit until the helper has proved, in
// order, that (1) the OS created it, (2) it ran far enough to take the job, and
// (3) it read the Host's COMMIT and acknowledged the handoff. An exit with
// nobody left to relaunch is the one outcome the UI cannot recover from, so
// every failure before (3) leaves this process running.

/** How long the Host waits for the helper to be created, then to ARM. */
const HELPER_ARM_TIMEOUT_MS = 5_000
/** How long the Host waits for the helper to acknowledge the COMMIT. */
const HELPER_COMMIT_TIMEOUT_MS = 5_000
/** How long the generated helper waits for the Host's COMMIT before abandoning. */
const HELPER_COMMIT_WAIT_MS = 30_000
/** How long the generated helper waits for the relaunched DSH to answer /health. */
const HELPER_READY_WAIT_MS = 60_000
/** Schema version of the handshake status records (not the marker's). */
const RESTART_SCHEMA_VERSION = 2

/**
 * Upper bound on the best-effort pre-exit session flush.
 *
 * The flush is a durability nicety — `ctx.appExit` disposal is the authority —
 * but an unbounded one is a safety hole, not just a slow path. The session
 * flush sits between the helper's COMMIT and this process's exit, and the
 * helper only waits so long before abandoning a process it believes is stuck.
 * A flush that never settles would therefore produce exactly the outcome the
 * handshake exists to prevent: nobody left to relaunch.
 */
export const PRE_EXIT_FLUSH_CAP_MS = 5_000
/**
 * Extra margin the helper keeps beyond the Host's worst-case exit budget, so
 * ordinary scheduling jitter cannot make it abandon a process that is still
 * shutting down.
 */
const HELPER_OLD_PID_MARGIN_MS = 15_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * This process's worst-case time from the helper's COMMIT to actually exiting:
 * the capped flush, the delay before the exit is requested, and the graceful
 * `ctx.appExit` watchdog that falls back to a hard exit.
 * @param delayMs - the delay this restart was asked to observe before exiting.
 * @returns milliseconds; the helper's patience is derived from this.
 */
export function preExitBudgetMs(delayMs: number): number {
  return PRE_EXIT_FLUSH_CAP_MS + Math.max(0, delayMs) + APP_EXIT_WATCHDOG_MS
}

/**
 * How long the generated helper waits for this process to exit.
 *
 * Derived from {@link preExitBudgetMs} on purpose. A helper that gives up
 * before this process finishes exiting abandons a restart that is still
 * completing, and nothing is left to relaunch — the one outcome the handshake
 * exists to prevent. Two independently-maintained constants would silently
 * re-open that window the next time either side is tuned.
 * @param delayMs - the delay this restart was asked to observe before exiting.
 * @returns milliseconds, strictly greater than the Host's own budget.
 */
export function helperOldPidWaitMs(delayMs: number): number {
  return preExitBudgetMs(delayMs) + HELPER_OLD_PID_MARGIN_MS
}

/**
 * Flush every live session, bounded. Returning late is never worth blocking the
 * exit on: the helper is already waiting, and a flush that never settles would
 * strand the restart with no process left to relaunch it.
 * @param ctx - host context carrying the session service.
 * @param capMs - hard upper bound on the wait.
 */
export async function flushSessionsBounded(ctx: any, capMs: number): Promise<void> {
  try {
    const live = typeof ctx.sessions?.list === 'function' ? ctx.sessions.list() : []
    if (live.length === 0) return
    const flushing = Promise.allSettled(live.map((session: unknown) => ctx.sessions.flush(session)))
    await Promise.race([flushing, sleep(capMs)])
  } catch {
    // A throwing flush is not a reason to hold the exit either.
  }
}

/** Directory holding per-restart handshake files. */
function restartDir(): string {
  return path.join(RUNTIME_DIR, 'power-restart')
}

function statusPathFor(restartId: string): string {
  return path.join(restartDir(), `${restartId}.status.json`)
}

function commitPathFor(restartId: string): string {
  return path.join(restartDir(), `${restartId}.commit.json`)
}

/** Rolling record of the most recent restart's outcome. Keyed by port. */
function lastRestartPath(port: number): string {
  return path.join(RUNTIME_DIR, `dsh-power-restart-last-${port}.json`)
}

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/** Write JSON through a temp file + rename so a reader never observes a partial record. */
function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
  try {
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* the rename already failed; the temp file is the lesser problem */ }
    throw error
  }
}

/**
 * Wait for the helper process to exist. Node reports several launch failures
 * asynchronously on `error` instead of throwing from `spawn()`, so `spawn` is
 * the only positive confirmation that a process was created.
 */
async function waitForHelperSpawn(helper: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    helper.once('spawn', () => { resolve() })
    helper.once('error', (error) => { reject(error) })
  })
}

/**
 * Poll the helper's status record until `predicate` holds. Matching on both
 * restartId and helper pid keeps a stale record from an earlier attempt from
 * satisfying a later handshake, and a helper that died can never advance its
 * own record, so its exit aborts the wait immediately.
 */
async function waitForHelperStatus(
  helper: ChildProcess,
  restartId: string,
  predicate: (status: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const file = statusPathFor(restartId)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = readJsonFile(file)
    if (
      status !== null
      && status.restartId === restartId
      && status.helperPid === helper.pid
      && predicate(status)
    ) return status
    if (helper.exitCode !== null || helper.signalCode !== null) {
      throw new Error(`restart helper exited before completing the handshake (code=${String(helper.exitCode)})`)
    }
    if (Date.now() >= deadline) {
      throw new Error(`restart helper did not complete the handshake within ${String(timeoutMs)}ms`)
    }
    await sleep(50)
  }
}

/** Everything the generated helper needs; every path must be absolute.
 * Exported so the runtime acceptance tests can drive the EXACT shipped helper
 * script against fake target processes instead of a real DSH instance. */
export interface RestartHelperPayload {
  relaunch: readonly string[]
  cwd: string
  port: number
  oldPid: number
  oldInstanceId: string
  restartId: string
  markerFile: string
  statusFile: string
  lastStatusFile: string
  commitFile: string
  logFile: string
  serverLog: string
  sessionsRoot: string
  commitWaitMs: number
  readyWaitMs: number
  /**
   * How long the helper waits for this process to exit before it gives up.
   * Derived by the Host from its own worst-case exit budget
   * ({@link preExitBudgetMs}) rather than written as a second independent
   * constant: if the helper's patience is ever the shorter of the two, it
   * abandons a process that is still on its way out and nobody relaunches.
   */
  oldPidWaitMs: number
  requestedAt: string
  /** Who asked, recorded so the new process can attribute the restart without
   * guessing. Absent when the caller had no causal session. */
  origin?: RestartOrigin
}

/**
 * Generate the detached restart helper. A pure function of the payload: the
 * runtime acceptance tests execute its output directly, so what the E2E
 * drives is byte-for-byte what a real restart runs.
 */
export function buildRestartHelper(p: RestartHelperPayload): string {
  return `
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const nodePath = require('node:path');
const relaunch = ${JSON.stringify(p.relaunch)};
const cwd = ${JSON.stringify(p.cwd)};
const PORT = ${p.port};
const OLD_PID = ${p.oldPid};
const OLD_INSTANCE = ${JSON.stringify(p.oldInstanceId)};
const RESTART_ID = ${JSON.stringify(p.restartId)};
const MARKER = ${JSON.stringify(p.markerFile)};
const STATUS = ${JSON.stringify(p.statusFile)};
const LAST_STATUS = ${JSON.stringify(p.lastStatusFile)};
const COMMIT = ${JSON.stringify(p.commitFile)};
const LOG = ${JSON.stringify(p.logFile)};
const SERVER_LOG = ${JSON.stringify(p.serverLog)};
const SESSIONS_ROOT = ${JSON.stringify(p.sessionsRoot)};
const COMMIT_WAIT_MS = ${p.commitWaitMs};
const READY_WAIT_MS = ${p.readyWaitMs};
const OLD_PID_WAIT_MS = ${p.oldPidWaitMs};
const RELAUNCH_RETRIES = 3;
const REQUESTED_AT = ${JSON.stringify(p.requestedAt)};
const ORIGIN = ${JSON.stringify(p.origin ?? null)};
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
// Durable-write quiescence check: the OLD process may still be draining its
// session write-behind buffer after its main loop exits (a message or a
// tool/result landing just before the exit). Relaunching before that drain
// finishes lets the NEW process read a file the old one is still appending
// to, and its first writes then interleave stale seq numbers onto the same
// log — the corruption that repeatedly broke sessions. So after the old pid
// is gone and the port is free, poll every session log's (size, mtimeMs)
// until two consecutive samples are identical: only then is the disk quiescent.
// Bounded (~15s): never block the restart forever on a stuck writer.
function sessionsQuiescent(maxWaitMs) {
  const walk = (dir, out) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = dir + nodePath.sep + e.name;
      if (e.isDirectory()) walk(p, out);
      else if (/session\.jsonl/.test(e.name)) {
        try {
          const s = fs.statSync(p);
          out.push(p + ':' + s.size + ':' + Math.floor(s.mtimeMs));
        } catch {}
      }
    }
  };
  const stamp = () => { const out = []; walk(SESSIONS_ROOT, out); return out.sort().join('|'); };
  const deadline = Date.now() + maxWaitMs;
  let prev = stamp();
  return new Promise((resolve) => {
    const tick = () => {
      setTimeout(() => {
        if (Date.now() >= deadline) return resolve(false);
        const cur = stamp();
        if (cur === prev) return resolve(true);
        prev = cur;
        tick();
      }, 400);
    };
    tick();
  });
}
(function () {
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function cleanup() { try { fs.unlinkSync(__filename); } catch {} }
  function writeJsonAtomic(file, value) {
    fs.mkdirSync(nodePath.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    try { fs.renameSync(tmp, file); }
    catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  }
  let status = {
    schemaVersion: ${RESTART_SCHEMA_VERSION},
    restartId: RESTART_ID,
    port: PORT,
    oldPid: OLD_PID,
    fromInstanceId: OLD_INSTANCE,
    origin: ORIGIN,
    requestedAt: REQUESTED_AT,
  };
  function patchStatus(patch) {
    status = Object.assign({}, status, patch, { updatedAt: new Date().toISOString() });
    // The status record is the ONLY channel the Host reads, so a failed write
    // must not be silent: without it the Host sees a helper that never armed.
    try { writeJsonAtomic(STATUS, status); } catch (e) { log('status write failed: ' + e); }
    try { writeJsonAtomic(LAST_STATUS, status); } catch {}
  }
  function fail(code, message) {
    patchStatus({ stage: 'failed', failure: { code: code, message: message } });
    log('failed: ' + code + ' - ' + message);
    cleanup();
  }
  // The Host writes COMMIT only after it has confirmed this helper is armed;
  // reading it is what authorises the relaunch. Without it the Host is still
  // alive and still owns the restart, so relaunching would race it for the port.
  async function waitForCommit() {
    const deadline = Date.now() + COMMIT_WAIT_MS;
    while (Date.now() < deadline) {
      let data = null;
      try { data = JSON.parse(fs.readFileSync(COMMIT, 'utf8')); } catch {}
      if (data && data.restartId === RESTART_ID) return true;
      await sleep(50);
    }
    return false;
  }
  function getHealth() {
    return new Promise((resolve) => {
      const req = http.get({
        host: '127.0.0.1', port: PORT, path: '/api/dsh-power-button/health', timeout: 2000,
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }
  // A successful spawn proves an OS process exists, not that DSH started: a
  // bad config crashes the new process long after 'spawn' fired. Require the
  // /health identity block this restart's launch token produces: the process
  // that answers must (a) run a DIFFERENT instanceId and (b) report THIS
  // restartId — so a port squatter, or an instance relaunched by some other
  // restart, can never pass as ours.
  async function waitForReady(child) {
    const deadline = Date.now() + READY_WAIT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) return null;
      const health = await getHealth();
      if (health && health.ok === true
        && typeof health.instanceId === 'string'
        && health.instanceId !== OLD_INSTANCE
        && health.restart && health.restart.restartId === RESTART_ID) return health;
      await sleep(250);
    }
    return null;
  }
  async function trySpawnOnce(attempt) {
    patchStatus({ stage: 'launching', attempt: attempt });
    const out = fs.openSync(SERVER_LOG, 'a');
    const child = spawn(relaunch[0], relaunch.slice(1), {
      cwd, detached: true, stdio: ['ignore', out, out], windowsHide: true,
      env: Object.assign({}, process.env, { DSH_POWER_RESTART_ID: RESTART_ID }),
    });
    const spawned = await new Promise((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    });
    if (!spawned) return null;
    child.unref();
    log('spawned pid ' + child.pid + ' (attempt ' + attempt + ')');
    patchStatus({ stage: 'spawned', newPid: child.pid, spawnedAt: new Date().toISOString() });
    return child;
  }
  (async () => {
    // ARM FIRST. Nothing else happens until the Host has been told this helper
    // is alive and running: the Host refuses to let the old process exit
    // without it, and that is the whole guarantee.
    patchStatus({ stage: 'armed', helperPid: process.pid, armedAt: new Date().toISOString() });
    log('helper up: old pid ' + OLD_PID + ', waiting for COMMIT');
    if (!(await waitForCommit())) {
      fail('commit-timeout', 'host never committed the restart handoff');
      return;
    }
    patchStatus({ stage: 'committed', committedAt: new Date().toISOString() });
    log('handoff committed by host, waiting for old pid to exit');
    patchStatus({ stage: 'waiting-old-exit' });
    let gone = false;
    // Bounded by the Host's own exit budget, not by a fixed count: giving up
    // while the old process is still shutting down would leave nobody to
    // relaunch it, which is the one failure the UI cannot recover from.
    const oldPidDeadline = Date.now() + OLD_PID_WAIT_MS;
    while (Date.now() < oldPidDeadline) {
      if (pidGone(OLD_PID)) { gone = true; break; }
      await sleep(500);
    }
    if (!gone) { fail('old-process-still-alive', 'old process did not exit within ' + OLD_PID_WAIT_MS + 'ms'); return; }
    patchStatus({ stage: 'waiting-port', oldExitedAt: new Date().toISOString() });
    log('old pid gone, waiting for port ' + PORT + ' to free');
    let freed = false;
    for (let i = 0; i < 60; i++) {
      if (await portFree(PORT)) { freed = true; break; }
      await sleep(500);
    }
    if (!freed) { fail('port-never-freed', 'port ' + PORT + ' stayed busy'); return; }
    await sleep(500); // settle: let the socket fully release
    // Wait for the old process's session write-behind to drain completely
    // (durable files stable) before the new process touches them. This closes
    // the restart-time corruption window: the new instance must never read a
    // session file the old one is still appending to.
    patchStatus({ stage: 'quiescing', portFreedAt: new Date().toISOString() });
    const quiescent = await sessionsQuiescent(15000);
    patchStatus({ sessionQuiescent: quiescent });
    log(quiescent ? 'session logs quiescent' : 'session logs still moving after 15s - proceeding anyway');
    // Relaunch breadcrumb with an ALLOWLIST only: the full argv is never logged
    // (plugin CLI args can carry credentials, and even a good redactor is one
    // regex away from leaking a value — same rule as the host boot breadcrumb).
    const relaunchExec = relaunch[0] ?? '';
    const relaunchScript = relaunch.find((a) => /(^|[\\/])bin\.(ts|js)$/.test(a)) ?? '';
    log('relaunching: exec=' + relaunchExec + ' script=' + relaunchScript + ' argc=' + relaunch.length);
    // Bind the relaunch to THIS restart BEFORE any child can exist: the marker
    // carries the restartId and the child inherits it as a launch env token,
    // so the new process can claim the restart no matter how early it boots.
    // (The previous protocol confirmed the relaunch in the marker only AFTER
    // the child spawned — a fast boot could read "no marker yet" and miss it.)
    try {
      fs.writeFileSync(MARKER, JSON.stringify({
        schemaVersion: 2,
        restartId: RESTART_ID,
        fromInstanceId: OLD_INSTANCE,
        origin: ORIGIN,
        requestedAt: REQUESTED_AT,
      }), 'utf8');
    } catch {}
    // Retry only when NO process was created. Once a process exists, starting
    // another one would race the first for the port.
    let child = null;
    for (let attempt = 1; attempt <= RELAUNCH_RETRIES; attempt++) {
      child = await trySpawnOnce(attempt);
      if (child !== null) break;
      log('spawn error on attempt ' + attempt);
      if (attempt < RELAUNCH_RETRIES) await sleep(attempt * 800);
    }
    if (child === null) {
      fail('relaunch-failed', 'no new process after ' + RELAUNCH_RETRIES + ' spawn attempts');
      return;
    }
    const health = await waitForReady(child);
    if (health === null) {
      fail('health-timeout', 'new process did not answer /health within ' + READY_WAIT_MS + 'ms');
      return;
    }
    patchStatus({ stage: 'ready', toInstanceId: health.instanceId, readyAt: new Date().toISOString() });
    log('new process ready: instance ' + health.instanceId);
    cleanup();
  })().catch((e) => { fail('helper-crashed', e && e.message ? e.message : String(e)); });
})();
`
}

/**
 * Relaunch DSH through a detached helper.
 *
 * Resolves only after the helper has taken ownership, at which point this
 * process schedules its own exit. Every failure before that point resolves
 * `ok: false` and leaves this process running: the caller must be able to
 * report a failed restart instead of ending up with no process at all.
 */
async function restartDsh(ctx: any, delayMs = 1500, origin?: RestartOrigin): Promise<{ ok: boolean, action: 'restart', restartId: string, note?: string, error?: string }> {
  const restartId = randomUUID()
  let helper: ChildProcess | undefined
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
    const helperScript = buildRestartHelper({
      relaunch: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
      cwd,
      port,
      oldPid: process.pid,
      oldInstanceId: INSTANCE_ID,
      restartId,
      markerFile: markerPath(),
      statusFile: statusPathFor(restartId),
      lastStatusFile: lastRestartPath(port),
      commitFile: commitPathFor(restartId),
      logFile: LOG_FILE,
      serverLog,
      sessionsRoot: path.join(RUNTIME_DIR, 'sessions'),
      commitWaitMs: HELPER_COMMIT_WAIT_MS,
      readyWaitMs: HELPER_READY_WAIT_MS,
      // Derived, never a second constant: the helper must outwait this
      // process's worst-case exit, or it abandons a restart that is still
      // completing and nothing relaunches.
      oldPidWaitMs: helperOldPidWaitMs(delayMs),
      requestedAt: new Date().toISOString(),
      ...(origin !== undefined ? { origin } : {}),
    })
    fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 })
    // 0600: the helper embeds the full relaunch argv, which can carry
    // credentials (e.g. --api-key in a plugin CLI arg).
    fs.writeFileSync(HELPER_FILE, helperScript, { encoding: 'utf8', mode: 0o600 })
    helper = spawn(process.execPath, [HELPER_FILE], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    // A ChildProcess with no 'error' listener throws on an asynchronous spawn
    // failure. waitForHelperSpawn's `once('error')` covers the launch window;
    // this keeps a later error (a failed kill, say) from becoming an uncaught
    // exception that takes this process down outside the exit path.
    helper.on('error', (error: Error) => {
      try { appendLog(LOG_FILE, `${new Date().toISOString()} restart helper error: ${String(error)}\n`) } catch { /* logging is best-effort */ }
    })
    // (1) The OS really created the helper. Node reports many launch failures
    // on 'error' rather than by throwing from spawn(), so this is the only
    // positive proof that a process exists.
    await waitForHelperSpawn(helper)
    // (2) The helper's own JavaScript ran far enough to take the job.
    await waitForHelperStatus(helper, restartId, (s) => typeof s.armedAt === 'string', HELPER_ARM_TIMEOUT_MS)
    // Hand ownership over. Only now may the helper start waiting for our exit.
    writeJsonAtomic(commitPathFor(restartId), {
      schemaVersion: RESTART_SCHEMA_VERSION,
      restartId,
      committedAt: new Date().toISOString(),
    })
    // (3) The helper acknowledged the handoff. Reaching here means a live
    // process has accepted responsibility for relaunching DSH.
    await waitForHelperStatus(helper, restartId, (s) => typeof s.committedAt === 'string', HELPER_COMMIT_TIMEOUT_MS)
    helper.unref()
    // Best-effort pre-exit durability checkpoint: flush every live session
    // before the exit timer starts so the visible write-behind window is
    // small. Events appended after this point (e.g. this tool's own
    // tool/result, or a message landing during the delay) are covered by
    // Harness's `ctx.appExit` disposal final drain on session/disposed —
    // that teardown lifecycle, not this flush, is the durability authority.
    const scheduleExit = (): void => {
      // Schedule the old process to exit AFTER the HTTP response flushes.
      // Prefer DSH's `ctx.appExit` (graceful tree dispose); fall back to
      // process.exit in non-standard embeddings.
      setTimeout(() => {
        requestAppExit(ctx)
      }, delayMs)
    }
    // Fire-and-forget: the tool result must not wait on the flush, and the
    // helper is already waiting for this process to exit. The cap is what keeps
    // a stuck flush from outliving the helper's patience.
    void flushSessionsBounded(ctx, PRE_EXIT_FLUSH_CAP_MS).then(scheduleExit)
    return { ok: true, action: 'restart', restartId, note: isEnglishLocale(ctx) ? 'DeepSeek Harness is restarting' : 'DeepSeek Harness 正在重启' }
  } catch (e) {
    // Nothing before the handshake completed may end this process: an exit
    // with no successor is the one outcome the UI cannot recover from. Stop
    // the helper too, so a half-armed one cannot linger and relaunch later.
    if (helper !== undefined) {
      try { helper.kill() } catch { /* already exited; nothing left to stop */ }
    }
    // A killed helper never reaches its own cleanup(), so remove the script
    // here: it embeds the full relaunch argv. Best-effort — a helper still
    // shutting down also unlinks it, and a missing file is the desired state.
    try { fs.unlinkSync(HELPER_FILE) } catch { /* already gone, or still held */ }
    return { ok: false, action: 'restart', restartId, error: e instanceof Error ? e.message : String(e) }
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
function shutdownDsh(ctx: any, res: import('node:http').ServerResponse | undefined) {
  try {
    const exitNow = (): void => {
      requestAppExit(ctx)
    }
    // Flush every live session before exiting so the write-behind buffer is
    // durably on disk — same durability barrier as the restart path, and
    // bounded for the same reason: a flush that never settles would leave the
    // process alive after the user asked it to stop.
    const exitSoon = (): void => {
      void flushSessionsBounded(ctx, PRE_EXIT_FLUSH_CAP_MS).then(exitNow)
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
    return {
      ok: true,
      action: 'shutdown',
      note: isEnglishLocale(ctx)
        ? 'DeepSeek Harness is shutting down (start it again manually)'
        : 'DeepSeek Harness 正在关机（进程停止后需手动重新启动）',
    }
  } catch (e) {
    return { ok: false, action: 'shutdown', error: e instanceof Error ? e.message : String(e) }
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
 * NOTE: our `/api/dsh-power-button/*` prefix is LONGER than the official
 * `/api` route, so webServer's longest-prefix-wins matching means these
 * requests never pass through the official fence automatically — this guard
 * is the only line of defense for them.
 *
 * Exported for the security regression suite: this fence is self-maintained
 * (a deliberate copy of the official browser-trust fence, adapted to this
 * route), so a matrix test is what keeps it from silently drifting when the
 * upstream fence evolves.
 */
export function isTrustedPowerRequest(req: {
  socket?: { remoteAddress?: string | undefined } | undefined
  headers: Record<string, unknown>
}): boolean {
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

/** Whether the UI language is English (DSH settings `locale.preference`). */
function isEnglishLocale(ctx: any): boolean {
  try {
    const locale = ctx.settings?.get?.('locale') as { preference?: string } | undefined
    const pref = typeof locale?.preference === 'string' ? locale.preference.toLowerCase() : ''
    return pref.startsWith('en')
  } catch { /* settings unavailable */ }
  return false
}

export function apply(ctx: any, config: Config) {
  // Startup housekeeping: prune stale restart-helper logs from previous runs.
  pruneOldRestartLogs()
  // Resolve THIS instance's port first: markers are keyed by port so
  // concurrent instances never read each other's restart markers.
  CURRENT_PORT = resolvePort(ctx)
  // If the restart marker names a DIFFERENT previous instance, this process
  // is the freshly-relaunched one — record the identity for /health, and mark
  // the toast as pending until the client ACKs.
  bootRestart = consumeRestartConfirmation()
  restartNoticePending = bootRestart !== null
  if (bootRestart !== null) {
    try {
      appendLog(LOG_FILE, `${new Date().toISOString()} restart confirmed: fromInstanceId=${bootRestart.fromInstanceId}`
        + (bootRestart.restartId !== undefined ? ` restartId=${bootRestart.restartId}` : '')
        + ` thisInstanceId=${INSTANCE_ID}\n`)
    } catch { /* ignore */ }
    // The confirmation is UI-only on the client side: it shows a "已重启" toast
    // when /health reports `restarted: true` (see src/client/RestartNotice.tsx).
    // The model side of the same fact is the notice below, which goes through
    // Agent.inject()/followup() rather than the plugin appending a message.
    queueRestartNotice(bootRestart, config.restartWakeMode)
  }

  // Deliver any queued restart notice whose session is live, and retry whenever
  // an agent is created — `session.follow` on a cold session promotes it to a
  // live Agent in the background after the snapshot, so a session that is not
  // live yet becomes deliverable the moment it is opened or reconnected to.
  deliverPendingNotices(ctx)
  ctx.effect(() => {
    const off = ctx.on?.('agent/created', () => { deliverPendingNotices(ctx) })
    return () => { if (typeof off === 'function') off() }
  }, 'dsh-power-button: restart notice delivery')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    handler: async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const sub = url.pathname.slice(BASE.length).replace(/\/+$/, '') || '/'
      // Every mutation POST goes through the same-origin guard; health stays open.
      const needsGuard = (sub === '/restart' || sub === '/shutdown' || sub === '/notice-shown') && req.method === 'POST'
      if (needsGuard && !isTrustedPowerRequest(req)) {
        return json(res, 403, { ok: false, error: 'forbidden: cross-origin power request' })
      }
      try {
        if (sub === '/restart' && req.method === 'POST') {
          if (!claimPowerTransition('restart')) {
            return json(res, 409, { ok: false, error: `power transition already in progress: ${powerTransition}` })
          }
          // A plain POST carries no causal session, and one is never guessed.
          const result = await restartDsh(ctx, undefined, { kind: 'http' })
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
          const body: Record<string, unknown> = {
            ok: true,
            instanceId: INSTANCE_ID,
            pluginVersion: PLUGIN_VERSION,
            lifecycle: powerTransition ?? 'ready',
            // Surfaces whether the launcher-provided exit channel resolves, so
            // a host where restarts silently fall back to process.exit is
            // diagnosable from a single request instead of from a 30s stall.
            appExit: typeof ctx.get?.('appExit') === 'function' ? 'available' : 'missing',
          }
          // Restart IDENTITY: permanent for this process's lifetime — the
          // helper (waitForReady) and future diagnostics read it regardless
          // of whether the toast has been acknowledged.
          if (bootRestart !== null) {
            body.restart = { restartId: bootRestart.restartId, fromInstanceId: bootRestart.fromInstanceId }
          }
          // Toast-pending flag: cleared by /notice-shown without touching the
          // identity above. RestartNotice reads exactly this field.
          if (restartNoticePending && bootRestart !== null) {
            body.restarted = true
            body.fromInstanceId = bootRestart.fromInstanceId
          }
          return json(res, 200, body)
        }
        if (sub === '/notice-shown' && req.method === 'POST') {
          // UI-only confirmation lifecycle: the client displays the "已重启"
          // toast once (from /health's `restarted` flag), then ACKs here so
          // a later page refresh does not re-show it. Only the toast flag is
          // cleared — the `restart` identity block stays on /health.
          restartNoticePending = false
          return json(res, 200, { ok: true, action: 'notice-shown' })
        }
        json(res, 404, { ok: false, error: `no dsh-power-button endpoint ${sub}` })
      } catch (e) {
        releasePowerTransition()
        json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    },
  }), 'dsh-power-button: http routes')

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
        description: isEnglishLocale(ctx)
          ? 'Restart the whole DeepSeek Harness process to reload plugins and config (profile cordis layers, settings, etc). '
            + 'Provided by dsh-power-button (standalone): spawns a detached helper that waits for the old process to exit and the port to free, '
            + 'then relaunches with the same command line and cwd, after which the old process exits. '
            + 'The current session connection drops briefly and the page auto-reconnects. Returns ok and a note.'
          : '重启整个 DeepSeek Harness 进程，用于重新加载插件与配置（profile 的 cordis 组合、settings 等）。'
            + '由 dsh-power-button 提供（独立实现）：派生一个 detach 的 helper，'
            + '在旧进程退出并释放端口后以原命令行在原目录重新拉起，然后旧进程退出。'
            + '触发后当前会话连接会短暂中断，网页随后自动重连到新进程。'
            + '返回 ok 与说明文本。',
        parameters: {
          type: 'object',
          properties: {
            delayMs: {
              type: 'number',
              description: isEnglishLocale(ctx)
                ? `ms to wait before the old process exits (gives the current result time to flush), default 2000, max ${cfg.maxDelayMs}.`
                : `旧进程退出前等待的毫秒数（给当前结果留出回传时间），默认 2000，上限 ${cfg.maxDelayMs}。`,
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
          render(_args: unknown, value: unknown) {
            return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
          },
        },
        async execute(args: unknown, exec: { agent?: { session: { id: unknown } } }) {
          const a = (args ?? {}) as { delayMs?: number }
          // Floor the model-visible delay: the restart tool must never be able
          // to kill the process before its own tool/result and turn boundary
          // settle. The delay is a process-control implementation detail; the
          // model only gets a bounded, floored knob.
          const clamped = clampModelDelayMs(Number(a.delayMs), cfg.maxDelayMs)
          // Same at-most-once latch as the HTTP endpoints: the model tool and
          // a concurrent UI click must not spawn two helpers.
          if (!claimPowerTransition('restart')) {
            return { ok: false, error: `power transition already in progress: ${powerTransition}` }
          }
          // The causal agent is the only trustworthy source for "which
          // conversation asked": read it, never infer it.
          const sessionId = exec?.agent?.session?.id
          const origin: RestartOrigin = typeof sessionId === 'string' && sessionId.length > 0
            ? { kind: 'model-tool', sessionId }
            : { kind: 'model-tool' }
          const result = await restartDsh(ctx, clamped, origin)
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

  // Read-only restart diagnostics. Registered regardless of `enableModelTool`:
  // that flag gates the destructive capability, while this is how a model finds
  // out about a restart it did NOT initiate — a GUI click or /restart command
  // has no causal session to notify, so nothing else would tell it.
  ctx.effect(() => ctx.tools.register({
    name: 'restart_status',
    description: isEnglishLocale(ctx)
      ? 'Report the most recent DeepSeek Harness restart: whether one happened, its id, stage, the instance it replaced and the one it produced, '
        + 'timings, who asked for it, and whether THIS process is the instance that restart produced. Read-only; never restarts anything.'
      : '报告最近一次 DeepSeek Harness 重启：是否发生过、restartId、阶段、被替换的实例与新实例、各阶段时间、发起者，'
        + '以及当前进程是否就是这次重启产生的实例。只读，不会触发任何重启。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {},
      render(_args: unknown, value: unknown) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute() {
      return restartStatus(ctx)
    },
  }), 'dsh-power-button: restart_status tool')

  // Command-bar entries, self-contained (no anweat/dsh-restart needed):
  // `/restart` and `/shutdown` share the same at-most-once latch as the UI
  // and the model tool, so a command cannot race a button click.
  // Each registration tolerates a name collision (another plugin may own
  // `restart`): a conflict logs and skips instead of crashing the boot.
  ctx.effect(() => {
    const en = isEnglishLocale(ctx)
    try {
      ctx.commands.register({
        name: 'restart',
        description: en
          ? 'Restart DeepSeek Harness (reload plugins & config)'
          : '重启 DeepSeek Harness（重载插件与配置）',
        recordInput: false,
        async handler(invocation: { agent?: { session: { id: unknown } } }) {
          if (!claimPowerTransition('restart')) {
            return { kind: 'error', text: `power transition already in progress: ${powerTransition}` }
          }
          // The dispatching UI's agent is the causal session for this command.
          const sessionId = invocation?.agent?.session?.id
          const origin: RestartOrigin = typeof sessionId === 'string' && sessionId.length > 0
            ? { kind: 'command', sessionId }
            : { kind: 'command' }
          const result = await restartDsh(ctx, undefined, origin)
          if (!result.ok) releasePowerTransition()
          return result.ok
            ? { kind: 'success', text: result.note }
            : { kind: 'error', text: result.error ?? (en ? 'restart failed' : '重启失败') }
        },
      })
    } catch (error) {
      if (String(error).includes('already registered')) {
        try {
          appendLog(LOG_FILE, `${new Date().toISOString()} command "restart" already registered by another plugin; skipping ours\n`)
        } catch { /* ignore */ }
      } else {
        throw error
      }
    }
    ctx.commands.register({
      name: 'shutdown',
      description: en
        ? 'Shut down DeepSeek Harness (stop process; restart manually). Opens a GUI confirm dialog.'
        : '关机 DeepSeek Harness（停止进程，需手动重新启动）。会弹出确认对话框。',
      // Declared input so `/shutdown <anything>` reaches the handler (the UI's
      // slash matchEnter treats argued lines as commands only when the command
      // declares an input descriptor). The confirm dialog is GUI-side: the
      // handler only signals SHUTDOWN_CONFIRM_PENDING, and the client pops the
      // same dialog as the power button, then POSTs /shutdown on confirm.
      input: { hint: en ? 'opens the shutdown confirm dialog' : '打开关机确认对话框' },
      recordInput: false,
      async handler() {
        // Signal the client to show the GUI confirm dialog (same one the power
        // button uses) via the shared SHUTDOWN_CONFIRM_REQUEST protocol value.
        // The handler does NOT shut down here: shutdown is irreversible, so
        // the actual POST happens only after the user clicks confirm in the
        // dialog. If the client dialog is unavailable (e.g. a non-UI caller),
        // the command reports pending without any side effect.
        return {
          kind: 'error',
          text: SHUTDOWN_CONFIRM_REQUEST,
        }
      },
    })
  }, 'dsh-power-button: commands')
}
