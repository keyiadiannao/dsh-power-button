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
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { RestartButton } from './RestartButton.tsx'
import { RestartNotice } from './RestartNotice.tsx'
import { RestartOverlay } from './RestartOverlay.tsx'
import { RestartPreparing } from './RestartPreparing.tsx'
import { ShutdownConfirmDialog } from './ShutdownConfirmDialog.tsx'
import { en, zh } from './locales.ts'

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
 * Mirrors the declarations the host rc.8 packages actually make for these
 * additive slots. See dsh-queue-merge/src/client/index.ts for the same pattern.
 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Sidebar footer actions — additive list (this plugin's power button).
     *  Owner is the sidebar geometry (`wide` = expanded vs 56px rail), which
     *  the framework injects (mirror of rc.8 SidebarFooterActionOwnerProps). */
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

/** Locale service shape this plugin relies on (rc.6-era client surface). */
interface LocaleServiceLike {
  register(ns: string, dicts: unknown): () => void
  snapshot?: { active?: string }
}

/** Loose view of the client context services we touch (iterate-over-host drift). */
type ClientServices = {
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

/** Surface an error, unless the flow has already moved past the point of no return. */
function fail(msg: string): void {
  if (phase === 'error' || phase === 'recovering') return
  phase = 'error'
  errorMsg = msg
  emit()
}

/** Monotonic operation id: each beginPower() bumps it; stale timers from a
 * previous operation check it and stop. Prevents an old health poll from
 * overwriting a newer flow's phase (e.g. error → waiting on retry). */
let operationId = 0

/** Kick a restart or shutdown. Opens the overlay and drives the flow.
 * Restart goes through a brief `preparing` stage first (a small corner hint,
 * no full-screen veil) so the user is not slammed by a modal in the first
 * hundreds of milliseconds — the POST is still in flight and the page is
 * alive; the full-screen overlay only appears once the connection is about to
 * actually drop. */
export function beginPower(next: PowerAction): void {
  const myOperation = ++operationId
  const active = (): boolean => myOperation === operationId
  action = next
  errorMsg = null

  const endpoint = next === 'shutdown' ? '/api/dsh-power-button/shutdown' : '/api/dsh-power-button/restart'

  if (next === 'restart') {
    // Stage 1: corner hint, page stays fully usable.
    phase = 'preparing'
    emit()
    // Stage 2: after a short beat (POST delivered, flush underway) switch to
    // the full-screen lifecycle overlay. Bound: never skip to the overlay if
    // a newer operation superseded this one.
    setTimeout(() => {
      if (!active() || phase !== 'preparing') return
      phase = 'shutting'
      emit()
    }, 800)
  } else {
    // Shutdown already has its own confirm dialog; go straight to the veil.
    phase = 'shutting'
    emit()
  }

  // Shutdown: fire-and-forget the POST (keepalive survives the page/process
  // lifecycle), then poll health. The process exits and never comes back —
  // once we observe repeated DOWNs, settle on the final "已关机" screen. No
  // reload: the page must not bounce back to a dead server.
  if (next === 'shutdown') {
    void fetch(endpoint, { method: 'POST', keepalive: true })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!active()) return
        if (!r.ok || (j as { ok?: boolean })?.ok === false) {
          fail((j as { error?: string })?.error ?? tl('opFailedHttp').replace('{0}', String(r.status)))
        }
      })
      .catch(() => { /* polls observe the outage */ })
    const SHUTDOWN_POLL_MS = 500
    const SHUTDOWN_TIMEOUT_MS = 40_000
    const MAX_ATTEMPTS = SHUTDOWN_TIMEOUT_MS / SHUTDOWN_POLL_MS
    let attempts = 0
    let downStreak = 0
    const timer = setInterval(async () => {
      if (!active()) { clearInterval(timer); return }
      attempts += 1
      // Timeout: never claim success without observing the process actually
      // go down — that would be a false "已关机".
      if (attempts >= MAX_ATTEMPTS) {
        clearInterval(timer)
        phase = 'error'
        errorMsg = tl('shutdownNoEffect')
        emit()
        return
      }
      let up = false
      try {
        const r = await fetch('/api/dsh-power-button/health', { cache: 'no-store' })
        up = r.ok
      } catch { up = false }
      if (!up) {
        // Require a short streak of DOWNs (a single transient blip must not
        // declare "已关机").
        downStreak += 1
        if (downStreak >= 3) {
          clearInterval(timer)
          phase = 'off'
          emit()
        }
      } else {
        downStreak = 0
      }
    }, SHUTDOWN_POLL_MS)
    return
  }

  // Brief beat on the closing caption, then move to waiting.
  setTimeout(() => {
    if (!active()) return
    if (phase === 'shutting') {
      phase = 'waiting'
      emit()
    }
  }, 600)

  // Restart: capture THIS operation's baseline instanceId FIRST (not the
  // page-load one — the server may have been restarted manually since, which
  // would make the old baseline a false "already changed"), then POST, then
  // poll. Success is authoritative when the instanceId changes from the
  // operation baseline (old A → new B). A captured baseline makes seenDown
  // alone insufficient (a transient network blip on the still-old instance
  // must not fake success); seenDown is only the fallback when NO baseline
  // could be captured at all.
  void (async () => {
    let baseline: string | null = null
    try {
      const r = await fetch('/api/dsh-power-button/health', { cache: 'no-store' })
      if (r.ok) {
        const j = await r.json().catch(() => ({})) as { instanceId?: string }
        if (typeof j.instanceId === 'string') baseline = j.instanceId
      }
    } catch { /* baseline stays null → seenDown fallback */ }

    if (!active()) return

    // Fire the restart POST now that the baseline is captured.
    void fetch('/api/dsh-power-button/restart', { method: 'POST', keepalive: true })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}))
        if (!active()) return
        if (!r.ok || (j as { ok?: boolean })?.ok === false) {
          fail((j as { error?: string })?.error ?? tl('opFailedHttp').replace('{0}', String(r.status)))
        }
      })
      .catch(() => { /* polls observe the outage */ })

    // Serial (single-flight) polling: each round awaits the fetch before the
    // next timer is scheduled, so overlapping polls cannot race the state.
    let seenDown = false
    let upTicks = 0
    let attempts = 0
    const POLL_MS = 1000
    const MAX_ATTEMPTS = 90

    const poll = async (): Promise<void> => {
      if (!active()) return
      attempts += 1
      if (attempts > MAX_ATTEMPTS) {
        phase = 'error'
        errorMsg = tl('restartTimeout')
        emit()
        return
      }
      let up = false
      let instanceChanged = false
      try {
        const r = await fetch('/api/dsh-power-button/health', { cache: 'no-store' })
        up = r.ok
        if (r.ok) {
          const j = await r.json().catch(() => ({})) as { instanceId?: string }
          instanceChanged = baseline !== null
            && typeof j.instanceId === 'string'
            && j.instanceId !== baseline
        }
      } catch { up = false }
      if (!active()) return

      if (!up) {
        seenDown = true
        upTicks = 0
        if (phase !== 'waiting') {
          phase = 'waiting'
          emit()
        }
      } else {
        const confirmed = baseline !== null
          ? instanceChanged // authoritative: a different process answered
          : (seenDown && up) // fallback: real down followed by an up
        if (confirmed) {
          phase = 'recovering'
          emit()
          // Let the ring transition to 100% (1.1s) before reloading.
          setTimeout(() => { if (active()) window.location.reload() }, 1300)
          return
        }
        // Up without confirmation: allow ~20s for the POST to be delivered
        // (it can queue behind the app's streams) before declaring failure.
        upTicks += 1
        if (upTicks >= 20) {
          phase = 'error'
          errorMsg = tl('restartNoEffect')
          emit()
          return
        }
      }
      setTimeout(poll, POLL_MS)
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
  phase = 'idle'
  errorMsg = null
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
// The host `/shutdown` handler never shuts down directly: it signals
// `SHUTDOWN_CONFIRM_PENDING` (a command/executed error text), and this client
// shows the SAME confirm dialog as the power button. Confirm → beginPower
// ('shutdown') POSTs the real shutdown; cancel just dismisses.
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

/** Sentinel the host `/shutdown` handler returns to request the GUI dialog. */
const SHUTDOWN_CONFIRM_PENDING = 'SHUTDOWN_CONFIRM_PENDING'

export function apply(ctx: ClientContext & ClientServices): void {
  // Register UI strings so the button/overlay follow the DSH interface language.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-power-button: dictionaries')

  // Capture the locale service for module-scope (non-component) error strings.
  localeSvc = ctx.locale as { snapshot: { active: string } }

  // Self-contained layout fix: this plugin's footer button is full-width
  // (width: calc(100% + 8px)), so it needs the sidebar's footer-actions
  // container to wrap — one full-width occupant per row. The stock DSH css
  // uses `display: flex` without `flex-wrap`, which squeezes a second
  // full-width button (e.g. the suite-panel button) beside the first. Inject
  // the wrap here so the plugin works on unmodified official DSH builds too.
  // Scope the host-container workaround to the footerActions instance that
  // contains this plugin. Sibling actions in that SAME container will also
  // participate in wrapping; other footer containers are untouched. An id
  // prevents duplicate <style> on hot reload.
  const STYLE_ID = 'dsh-power-button-style'
  let styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (styleEl === null) {
    styleEl = document.createElement('style')
    styleEl.id = STYLE_ID
    styleEl.textContent = '[class$="_footerActions"]:has(.dsh-power-button) { flex-wrap: wrap; }'
    document.head.appendChild(styleEl)
  }

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

  // /shutdown confirm dialog: the host handler signals SHUTDOWN_CONFIRM_PENDING
  // through command/executed; this listener pops the same GUI dialog as the
  // power button, and only a confirmed click actually shuts down.
  ctx.effect(() => ctx.on?.('command/executed', (...args: unknown[]) => {
    const name = typeof args[1] === 'string' ? args[1] : ''
    if (name !== 'shutdown') return
    const result = args[2] as { text?: unknown } | undefined
    const text = typeof result?.text === 'string' ? result.text : ''
    if (text === SHUTDOWN_CONFIRM_PENDING) requestShutdownConfirm()
  }) ?? (() => {}), 'dsh-power-button: shutdown command confirm')

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({
      name: 'shell.overlay',
      id: 'dsh-restart-shutdown-confirm',
      locale: NS,
    }, ShutdownConfirmDialog))
}
