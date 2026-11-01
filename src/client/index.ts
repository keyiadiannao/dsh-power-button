/**
 * dsh-power-button browser half.
 *
 * Standalone plugin: adds a power button to the sidebar footer
 * (`sidebar.footer.action`) that opens an upward menu with two actions —
 * 重启 (restart) and 关机 (shutdown) — plus a full-screen
 * Windows-shutdown-style overlay (`shell.overlay`) with ring progress and
 * stage captions. Fully self-contained: the restart/shutdown ENGINE lives in
 * this plugin's host half (POST /api/dsh-power-button/{restart,shutdown}),
 * so it works standalone with no dependency on any other plugin.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { RESTART_FLOW_WAIT_MS, SHUTDOWN_FLOW_WAIT_MS, SHUTDOWN_CONFIRM_REQUEST, SHUTDOWN_CONFIRM_REQUEST_LEGACY } from '../protocol.ts'
import { RestartButton } from './RestartButton.tsx'
import { RestartNotice } from './RestartNotice.tsx'
import { RestartOverlay } from './RestartOverlay.tsx'
import { RestartPreparing } from './RestartPreparing.tsx'
import { ShutdownConfirmDialog } from './ShutdownConfirmDialog.tsx'
import { en, zh } from './locales.ts'
import { objectValue, requestJson } from './request.ts'

/** Required services. */
export const inject = ['slots', 'locale']

/** Locale namespace for this plugin's UI strings. */
export const NS = 'power.button'

/** Register the plugin's dictionary keys with the typed locale map. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'power.button': keyof typeof zh
  }
}

/**
 * Self-contained view of the DSH slot contracts this plugin registers into, so
 * the standalone typecheck (which cannot see the host DSH SlotMap extension —
 * only the default `'root'` slot exists in the empty SlotMap) still typechecks.
 * Mirrors the declarations the host UI packages actually make for these
 * additive slots. See dsh-queue-merge/src/client/index.ts for the same pattern.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Sidebar footer actions — additive list (this plugin's power button).
     *  Owner is the sidebar geometry (`wide` = expanded vs 56px rail), which
     *  the framework injects (mirror of SidebarFooterActionOwnerProps). */
    'sidebar.footer.action': {
      kind: 'list'
      scope: 'root'
      owner: { wide: boolean }
    }
    /** Frame-wide floating layer above every column (toasts, modals, overlays). */
    'shell.overlay': {
      kind: 'list'
      scope: 'root'
      owner: Record<string, unknown>
    }
  }
}

/** Locale service shape this plugin relies on. */
interface LocaleServiceLike {
  register(ns: string, dicts: unknown): () => void
  snapshot?: { active?: string }
}

/** Slot registration options this plugin sets on its two entries. */
interface SlotRegistrationOptions {
  name: string
  id: string
  order?: number
  locale?: string
  label?: () => string
}

/** Slot registry service shape this plugin relies on. */
interface SlotsServiceLike {
  inject(key: string, declaration: () => unknown): unknown
  register(options: SlotRegistrationOptions, component: unknown): unknown
}

/** Loose view of the client context services we touch (iterate-over-host drift). */
type ClientServices = {
  slots: SlotsServiceLike
  locale: LocaleServiceLike
  on?: (name: string, handler: (...args: unknown[]) => void) => () => void
}

/** What the power flow is doing: restarting or shutting down. */
export type PowerAction = 'restart' | 'shutdown'

/** Global power-flow state shared between the button, menu, and overlay. */
export type RestartPhase = 'idle' | 'preparing' | 'shutting' | 'waiting' | 'recovering' | 'off' | 'error'

let phase: RestartPhase = 'idle'
let action: PowerAction = 'restart'
let errorMsg: string | null = null
let errorRetryable = false
const listeners = new Set<() => void>()

/** Locale service captured at apply time; used to translate module-scope
 * (non-component) error strings according to the DSH UI language. */
let localeSvc: { snapshot: { active: string } } | undefined

/** Translate a key in the current UI language (module scope; components use props.t). */
export function tl(key: keyof typeof zh): string {
  const dict = localeSvc?.snapshot.active === 'en' ? en : zh
  return dict[key]
}

function emit(): void {
  for (const fn of listeners) fn()
}

export function getRestartPhase(): RestartPhase { return phase }
export function getPowerAction(): PowerAction { return action }
export function getRestartError(): string | null { return errorMsg }
export function getRestartRetryable(): boolean { return errorRetryable }

/** Surface an error, unless the flow has already moved past the point of no return. */
function fail(msg: string, retryable = false): void {
  if (phase === 'error' || phase === 'recovering') return
  operationId += 1
  stopCurrentOperation?.()
  stopCurrentOperation = undefined
  phase = 'error'
  errorMsg = msg
  errorRetryable = retryable
  emit()
}

/** Locale key for each trust-fence refusal reason the server reports. */
const TRUST_REASON_KEYS = {
  'socket-not-loopback': 'trustSocketNotLoopback',
  'host-missing': 'trustHostMissing',
  'host-unparseable': 'trustHostUnparseable',
  'host-untrusted': 'trustHostUntrusted',
  'cross-site': 'trustCrossSite',
  'origin-null': 'trustOriginNull',
  'origin-mismatch': 'trustOriginMismatch',
} as const satisfies Record<string, keyof typeof zh>

/**
 * Compose the message a failed power request shows.
 *
 * The trust fence answers a refusal with a stable reason code; without it the
 * user sees only "forbidden", which is what the first reporter of this fence
 * had to report — an issue with no content. The code is appended verbatim so it
 * can be quoted, and the localized sentence explains it. An unknown code still
 * shows the code rather than swallowing it: a newer server naming a rule this
 * build does not know is exactly when the raw code matters most.
 * @param body - the parsed response body, if any.
 * @param status - the HTTP status, used when the body carries no message.
 * @returns the user-facing failure text.
 */
function describeFailure(body: unknown, status: number): string {
  const j = body as { error?: unknown, reason?: unknown } | null | undefined
  const base = typeof j?.error === 'string' ? j.error : tl('opFailedHttp').replace('{0}', String(status))
  if (typeof j?.reason !== 'string') return base
  const key = (TRUST_REASON_KEYS as Record<string, keyof typeof zh | undefined>)[j.reason]
  return key === undefined ? `${base} [${j.reason}]` : `${base} [${j.reason}] — ${tl(key)}`
}

/** Monotonic operation id: each beginPower() bumps it; stale timers from a
 * previous operation check it and stop. Prevents an old health poll from
 * overwriting a newer flow's phase (e.g. error → waiting on retry). */
let operationId = 0
let stopCurrentOperation: (() => void) | undefined

/** Kick a restart or shutdown. Opens the overlay and drives the flow.
 * Restart goes through a brief `preparing` stage first (a small corner hint,
 * no full-screen veil) so the user is not slammed by a modal in the first
 * hundreds of milliseconds — the POST is still in flight and the page is
 * alive; the full-screen overlay only appears once the connection is about to
 * actually drop. */
export function beginPower(next: PowerAction): void {
  stopCurrentOperation?.()
  const myOperation = ++operationId
  const active = (): boolean => myOperation === operationId
  const controller = new AbortController()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const schedule = (fn: () => void, ms: number): void => {
    const timer = setTimeout(() => { timers.delete(timer); fn() }, ms)
    timers.add(timer)
  }
  const stop = (): void => {
    controller.abort()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }
  stopCurrentOperation = stop
  action = next
  errorMsg = null
  errorRetryable = false

  const endpoint = next === 'shutdown' ? '/api/dsh-power-button/shutdown' : '/api/dsh-power-button/restart'
  const timeout = next === 'shutdown' ? SHUTDOWN_FLOW_WAIT_MS : RESTART_FLOW_WAIT_MS
  schedule(() => fail(tl(next === 'shutdown' ? 'shutdownNoEffect' : 'restartTimeout')), timeout)

  if (next === 'restart') {
    // Stage 1: corner hint, page stays fully usable.
    phase = 'preparing'
    emit()
    // Stage 2: after a short beat (POST delivered, flush underway) switch to
    // the full-screen lifecycle overlay. Bound: never skip to the overlay if
    // a newer operation superseded this one.
    schedule(() => {
      if (!active() || phase !== 'preparing') return
      phase = 'shutting'
      emit()
    }, 800)
  } else {
    // Shutdown already has its own confirm dialog; go straight to the veil.
    phase = 'shutting'
    emit()
  }

  let accepted = false
  let restartId: string | null = null
  const send = (): void => {
    void requestJson(endpoint, { method: 'POST', keepalive: true, signal: controller.signal }, timeout).then((response) => {
      if (!active() || response.kind !== 'response') return
      const body = objectValue(response.body)
      if (!response.ok || body?.ok === false) {
        fail(describeFailure(response.body, response.status), response.status !== 409)
      } else if (body?.ok === true) {
        accepted = true
        restartId = typeof body.restartId === 'string' ? body.restartId : null
      }
    })
  }

  if (next === 'shutdown') {
    send()
    let downStreak = 0
    const poll = async (): Promise<void> => {
      const result = await requestJson('/api/dsh-power-button/health', { cache: 'no-store', signal: controller.signal })
      if (!active()) return
      // A timeout or any HTTP response is not evidence that the Host is down.
      downStreak = result.kind === 'unavailable' ? downStreak + 1 : 0
      if (accepted && downStreak >= 3) {
        stop()
        stopCurrentOperation = undefined
        operationId += 1
        phase = 'off'
        emit()
        return
      }
      schedule(() => { void poll() }, 500)
    }
    schedule(() => { void poll() }, 500)
    return
  }

  // Brief beat on the closing caption, then move to waiting.
  schedule(() => {
    if (!active()) return
    if (phase === 'shutting') {
      phase = 'waiting'
      emit()
    }
  }, 600)

  // Capture the baseline before sending the request. An acknowledged restart
  // ID, when present, identifies the exact successor even without a baseline.
  void (async () => {
    const initial = await requestJson('/api/dsh-power-button/health', { cache: 'no-store', signal: controller.signal })
    if (!active()) return
    const initialBody = initial.kind === 'response' && initial.ok ? objectValue(initial.body) : null
    const baseline = typeof initialBody?.instanceId === 'string' ? initialBody.instanceId : null
    send()
    const poll = async (): Promise<void> => {
      const result = await requestJson('/api/dsh-power-button/health', { cache: 'no-store', signal: controller.signal })
      if (!active()) return
      if (result.kind === 'unavailable') {
        if (phase !== 'waiting') {
          phase = 'waiting'
          emit()
        }
      } else if (result.kind === 'response' && result.ok) {
        const body = objectValue(result.body)
        const claimed = objectValue(body?.restart)
        const confirmed = accepted && (restartId !== null
          ? claimed?.restartId === restartId
          : baseline !== null && typeof body?.instanceId === 'string' && body.instanceId !== baseline)
        if (confirmed) {
          stop()
          phase = 'recovering'
          emit()
          schedule(() => { if (active()) window.location.reload() }, 1300)
          return
        }
      }
      schedule(() => { void poll() }, 1000)
    }
    void poll()
  })()
}

/** Dismiss the error overlay without reloading: cancels any in-flight flow
 * and returns to idle. The restart may have killed the old process without
 * a new one up — reloading here would bounce to a dead page, so just close
 * the dialog and let the user act (refresh manually if they wish). */
export function dismissPower(): void {
  operationId += 1 // invalidate any stale timers
  stopCurrentOperation?.()
  stopCurrentOperation = undefined
  phase = 'idle'
  errorMsg = null
  errorRetryable = false
  emit()
}

/** Subscribe to power-flow changes; returns an unsubscribe. */
export function onRestartChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

// ---------------------------------------------------------------------------
// /shutdown command → GUI confirm dialog
// ---------------------------------------------------------------------------
// The host `/shutdown` handler never shuts down directly: it signals the
// shared SHUTDOWN_CONFIRM_REQUEST protocol value through command/executed, and
// this client shows the SAME confirm dialog as the power button. Confirm →
// beginPower('shutdown') POSTs the real shutdown; cancel just dismisses.
const confirmListeners = new Set<() => void>()
let confirmVisible = false

function emitConfirm(): void {
  for (const fn of confirmListeners) fn()
}

/** Show the shutdown confirm dialog (from the /shutdown command path). */
export function requestShutdownConfirm(): void {
  confirmVisible = true
  emitConfirm()
}

/** Dismiss the dialog without acting. */
export function cancelShutdownConfirm(): void {
  confirmVisible = false
  emitConfirm()
}

/** Whether the /shutdown confirm dialog is currently shown. */
export function isShutdownConfirmVisible(): boolean {
  return confirmVisible
}

/** Subscribe to dialog visibility changes. */
export function onShutdownConfirmChange(fn: () => void): () => void {
  confirmListeners.add(fn)
  return () => { confirmListeners.delete(fn) }
}

export function apply(ctx: ClientContext & ClientServices): void {
  // Register UI strings so the button/overlay follow the DSH interface language.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-power-button: dictionaries')

  // Capture the locale service for module-scope (non-component) error strings.
  localeSvc = ctx.locale as { snapshot: { active: string } }
  ctx.effect(() => () => {
    dismissPower()
    cancelShutdownConfirm()
    localeSvc = undefined
  }, 'dsh-power-button: power flow cleanup')

  // Self-contained layout fix: this plugin's footer button is full-width
  // (width: calc(100% + 8px)), so it needs the sidebar's footer-actions
  // container to wrap — one full-width occupant per row. The stock DSH css
  // uses `display: flex` without `flex-wrap`, which squeezes a second
  // full-width button (e.g. the suite-panel button) beside the first. Inject
  // the wrap here so the plugin works on unmodified official DSH builds too.
  // Scope the host-container workaround to the footerActions instance that
  // contains this plugin. Sibling actions in that SAME container will also
  // participate in wrapping; other footer containers are untouched. The id
  // dedupes against a hot-reload pass whose dispose never ran. (The
  // `[class$="_footerActions"]` selector is coupled to the host's CSS-module
  // output — a stable host hook for this does not exist yet.)
  ctx.effect(() => {
    const STYLE_ID = 'dsh-power-button-style'
    let styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null
    if (styleEl === null) {
      styleEl = document.createElement('style')
      styleEl.id = STYLE_ID
      styleEl.textContent = '[class$="_footerActions"]:has(.dsh-power-button) { flex-wrap: wrap; }'
      document.head.appendChild(styleEl)
    }
    return () => { styleEl.remove() }
  }, 'dsh-power-button: footer wrap style')

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'dsh-power-button',
      order: -20,
      locale: NS,
      label: () => tl('power'),
    }, RestartButton))

  // Full-screen restart/shutdown overlay (additive list slot; coexists with others).
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({
      name: 'shell.overlay',
      id: 'dsh-restart-overlay',
      locale: NS,
    }, RestartOverlay))

  // Corner "preparing to restart" hint — shown during the brief pre-veil
  // window so the full-screen overlay does not slam in the moment the user
  // clicks Restart.
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({
      name: 'shell.overlay',
      id: 'dsh-restart-preparing',
      locale: NS,
    }, RestartPreparing))

  // UI-only "已重启" toast: shown once after a restart via /health's
  // `restarted` flag. Lives in the same additive overlay slot; unlike the
  // old session-injected assistant message it never touches a session file.
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({
      name: 'shell.overlay',
      id: 'dsh-restart-notice',
      locale: NS,
    }, RestartNotice))

  // /shutdown confirm dialog: the host handler signals the shared
  // SHUTDOWN_CONFIRM_REQUEST protocol value through command/executed; this
  // listener pops the same GUI dialog as the power button, and only a
  // confirmed click actually shuts down. The legacy sentinel is still
  // accepted so a page loaded before a host upgrade keeps working.
  ctx.effect(() => ctx.on?.('command/executed', (...args: unknown[]) => {
    const name = typeof args[1] === 'string' ? args[1] : ''
    if (name !== 'shutdown') return
    const result = args[2] as { text?: unknown } | undefined
    const text = typeof result?.text === 'string' ? result.text : ''
    if (text === SHUTDOWN_CONFIRM_REQUEST || text === SHUTDOWN_CONFIRM_REQUEST_LEGACY) requestShutdownConfirm()
  }) ?? (() => {}), 'dsh-power-button: shutdown command confirm')

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({
      name: 'shell.overlay',
      id: 'dsh-restart-shutdown-confirm',
      locale: NS,
    }, ShutdownConfirmDialog))
}
