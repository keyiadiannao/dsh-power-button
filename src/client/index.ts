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

/** Kick a restart or shutdown. Opens the overlay and drives the flow. */
export function beginPower(next: PowerAction): void {
  const myOperation = ++operationId
  const active = (): boolean => myOperation === operationId
  action = next
  phase = 'shutting'
  errorMsg = null
  emit()

  const endpoint = next === 'shutdown' ? '/api/dsh-restart-button/shutdown' : '/api/dsh-restart-button/restart'

  // Fire-and-forget with `keepalive`: the request rides the browser's
  // separate keepalive connection pool, so it is not stuck behind DSH's
  // long-lived SSE streams (HTTP/1.1 allows only 6 in-flight requests per
  // origin — without this the POST can sit queued for many seconds while the
  // overlay freezes on the closing caption). The overlay flow is driven
  // entirely by the health polls below, never by this POST's response.
  void fetch(endpoint, { method: 'POST', keepalive: true })
    .then(async (r) => {
      const j = await r.json().catch(() => ({}))
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
    if (phase === 'shutting') {
      phase = 'waiting'
      emit()
    }
  }, 600)

  // Restart: poll health from the START, requiring at least one observed
  // DOWN (connection refused — the old process is gone) before accepting an
  // UP as the new instance. A delayed POST or a failed restart otherwise
  // fakes success and reloads into an un-restarted app.
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
    try {
      const r = await fetch('/api/dsh-restart-button/health', { cache: 'no-store' })
      up = r.ok
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

    // Server is up again after a confirmed down: the new instance is ready.
    if (seenDown) {
      clearInterval(timer)
      phase = 'recovering'
      emit()
      // Let the ring transition to 100% (1.1s) before reloading.
      setTimeout(() => window.location.reload(), 1300)
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

  // Self-contained layout fix: this plugin's footer button is full-width
  // (width: calc(100% + 8px)), so it needs the sidebar's footer-actions
  // container to wrap — one full-width occupant per row. The stock DSH css
  // uses `display: flex` without `flex-wrap`, which squeezes a second
  // full-width button (e.g. the suite-panel button) beside the first. Inject
  // the wrap here so the plugin works on unmodified official DSH builds too.
  // Selector: CSS-module class names end in `_footerActions` (e.g.
  // `NwAuyq_footerActions`); the hash prefix is build-specific so match the
  // stable suffix. The `:has()` guard limits the change to footer rows that
  // actually contain this plugin's button, so other plugins' rows are
  // untouched; an id prevents duplicate <style> on hot reload.
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
