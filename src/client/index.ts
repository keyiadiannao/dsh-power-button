/**
 * dsh-restart-button browser half.
 *
 * Standalone plugin: adds a power button to the sidebar footer
 * (`sidebar.footer.action`) that opens an upward menu with two actions —
 * 重启 (restart) and 关机 (shutdown) — plus a full-screen
 * Windows-shutdown-style overlay (`shell.overlay`) with ring progress and
 * stage captions. Fully self-contained: the restart/shutdown ENGINE lives in
 * this plugin's host half (POST /api/dsh-restart-button/{restart,shutdown}),
 * so it works standalone with no dependency on any other plugin.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { RestartButton } from './RestartButton.tsx'
import { RestartOverlay } from './RestartOverlay.tsx'
import { en, zh } from './locales.ts'

/** Required services. */
export const inject = ['slots', 'locale']

/** Locale namespace for this plugin's UI strings. */
export const NS = 'restart.button'

/** Register the plugin's dictionary keys with the typed locale map. */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'restart.button': keyof typeof zh
  }
}

/** What the power flow is doing: restarting or shutting down. */
export type PowerAction = 'restart' | 'shutdown'

/** Global power-flow state shared between the button, menu, and overlay. */
export type RestartPhase = 'idle' | 'shutting' | 'waiting' | 'recovering' | 'off' | 'error'

let phase: RestartPhase = 'idle'
let action: PowerAction = 'restart'
let errorMsg: string | null = null
const listeners = new Set<() => void>()

/** Locale service captured at apply time; used to translate module-scope
 * (non-component) error strings according to the DSH UI language. */
let localeSvc: { snapshot: { active: string } } | undefined

/** Translate a key in the current UI language (module scope; components use props.t). */
function tl(key: keyof typeof zh): string {
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

/** The instanceId of the DSH process this page loaded against. A restart is
 * confirmed when health later reports a DIFFERENT id (new process), even if
 * the brief down window was never observed. */
let baselineInstanceId: string | null = null

/** Capture the current process's instanceId once at plugin load. */
async function captureInstanceId(): Promise<void> {
  try {
    const r = await fetch('/api/dsh-restart-button/health', { cache: 'no-store' })
    if (!r.ok) return
    const j = await r.json().catch(() => ({})) as { instanceId?: string }
    if (typeof j.instanceId === 'string') baselineInstanceId = j.instanceId
  } catch { /* offline at load; seenDown fallback covers it */ }
}

/** Kick a restart or shutdown. Opens the overlay and drives the flow. */
export function beginPower(next: PowerAction): void {
  const myOperation = ++operationId
  const active = (): boolean => myOperation === operationId
  action = next
  phase = 'shutting'
  errorMsg = null
  emit()

  const endpoint = next === 'shutdown' ? '/api/dsh-restart-button/shutdown' : '/api/dsh-restart-button/restart'

  // Fire-and-forget with `keepalive`: keepalive helps the power request
  // survive page/document lifecycle changes (e.g. the old instance exiting).
  // Do NOT rely on it as a guarantee of a separate HTTP connection pool.
  // The overlay flow is driven entirely by the health polls below, never by
  // this POST's response.
  void fetch(endpoint, { method: 'POST', keepalive: true })
    .then(async (r) => {
      const j = await r.json().catch(() => ({}))
      if (!active()) return // stale operation; a newer flow owns the state
      if (!r.ok || (j as { ok?: boolean })?.ok === false) {
        fail((j as { error?: string })?.error ?? tl('opFailedHttp').replace('{0}', String(r.status)))
      }
    })
    .catch(() => { /* restart: the polls observe the outage; shutdown: nothing more to do */ })

  // Shutdown: the process exits and never comes back. Poll health until we
  // observe the DOWN (connection refused — the process is gone), then settle
  // on the final "已关机" screen. No reload: the page must not bounce back
  // to a dead server; it just tells the user it is safe to close.
  if (next === 'shutdown') {
    const SHUTDOWN_POLL_MS = 500
    const SHUTDOWN_TIMEOUT_MS = 40_000
    const MAX_ATTEMPTS = SHUTDOWN_TIMEOUT_MS / SHUTDOWN_POLL_MS
    let attempts = 0
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
        const r = await fetch('/api/dsh-restart-button/health', { cache: 'no-store' })
        up = r.ok
      } catch { up = false }
      if (!up) {
        clearInterval(timer)
        phase = 'off'
        emit()
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

  // Restart: poll health from the START. Success is confirmed by EITHER:
  //   (a) observing a real DOWN (connection refused — old process gone), or
  //   (b) the per-process instanceId changing (old A → new B), which works
  //       even if the brief down window was missed.
  let seenDown = false
  let upTicks = 0
  let attempts = 0
  const timer = setInterval(async () => {
    if (!active()) { clearInterval(timer); return }
    attempts += 1
    if (attempts >= 90) { // ~90s cap: went down but never came back
      clearInterval(timer)
      phase = 'error'
      errorMsg = tl('restartTimeout')
      emit()
      return
    }
    let up = false
    let instanceChanged = false
    try {
      const r = await fetch('/api/dsh-restart-button/health', { cache: 'no-store' })
      up = r.ok
      if (r.ok) {
        const j = await r.json().catch(() => ({})) as { instanceId?: string }
        instanceChanged = baselineInstanceId !== null
          && typeof j.instanceId === 'string'
          && j.instanceId !== baselineInstanceId
      }
    } catch { up = false }

    if (!up) {
      seenDown = true
      upTicks = 0
      if (phase !== 'waiting') {
        phase = 'waiting'
        emit()
      }
      return
    }

    // Server is up again: confirmed restart if we saw a down OR the instance
    // id changed (new process answered).
    if (seenDown || instanceChanged) {
      clearInterval(timer)
      phase = 'recovering'
      emit()
      // Let the ring transition to 100% (1.1s) before reloading.
      setTimeout(() => { if (active()) window.location.reload() }, 1300)
      return
    }

    // Up without ever going down: the restart hasn't taken effect. Allow
    // ~20s for the POST to be delivered (it can queue behind the app's
    // streams) and the old process to exit before declaring failure.
    upTicks += 1
    if (upTicks >= 20) {
      clearInterval(timer)
      phase = 'error'
      errorMsg = tl('restartNoEffect')
      emit()
    }
  }, 1000)
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

export function apply(ctx: ClientContext): void {
  // Register UI strings so the button/overlay follow the DSH interface language.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-restart-button: dictionaries')

  // Capture the locale service for module-scope (non-component) error strings.
  localeSvc = ctx.locale

  // Record the current process's instanceId; restart success compares against
  // it (new process → different id).
  void captureInstanceId()

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
  const STYLE_ID = 'dsh-restart-button-style'
  let styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (styleEl === null) {
    styleEl = document.createElement('style')
    styleEl.id = STYLE_ID
    styleEl.textContent = '[class$="_footerActions"]:has(.dsh-restart-button) { flex-wrap: wrap; }'
    document.head.appendChild(styleEl)
  }

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'dsh-restart-button',
      order: -20,
      locale: NS,
      label: (props) => props.t('power'),
    }, RestartButton))

  // Full-screen restart/shutdown overlay (additive list slot; coexists with others).
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({
      name: 'shell.overlay',
      id: 'dsh-restart-overlay',
      locale: NS,
    }, RestartOverlay))
}
