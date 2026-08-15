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

/** Required services. */
export const inject = ['slots']

/** What the power flow is doing: restarting or shutting down. */
export type PowerAction = 'restart' | 'shutdown'

/** Global power-flow state shared between the button, menu, and overlay. */
export type RestartPhase = 'idle' | 'shutting' | 'waiting' | 'recovering' | 'error'

let phase: RestartPhase = 'idle'
let action: PowerAction = 'restart'
let errorMsg: string | null = null
const listeners = new Set<() => void>()

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

/** Kick a restart or shutdown. Opens the overlay and drives the flow. */
export function beginPower(next: PowerAction): void {
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
        fail((j as { error?: string })?.error ?? `操作失败 (HTTP ${r.status})`)
      }
    })
    .catch(() => { /* restart: the polls observe the outage; shutdown: nothing more to do */ })

  // Shutdown: the process exits and never comes back — no polling, no
  // reload. The overlay just sits on the final caption until the connection
  // drops.
  if (next === 'shutdown') return

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
    attempts += 1
    if (attempts >= 90) { // ~90s cap: went down but never came back
      clearInterval(timer)
      phase = 'error'
      errorMsg = '重启超时，请手动刷新'
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
      errorMsg = '重启未生效，请重试'
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
  // Self-contained layout fix: this plugin's footer button is full-width
  // (width: calc(100% + 8px)), so it needs the sidebar's footer-actions
  // container to wrap — one full-width occupant per row. The stock DSH css
  // uses `display: flex` without `flex-wrap`, which squeezes a second
  // full-width button (e.g. the suite-panel button) beside the first. Inject
  // the wrap here so the plugin works on unmodified official DSH builds too.
  // Selector: CSS-module class names end in `_footerActions` (e.g.
  // `NwAuyq_footerActions`); the hash prefix is build-specific so match the
  // stable suffix. Narrow sibling buttons are unaffected — they pack into one
  // row as before.
  const styleEl = document.createElement('style')
  styleEl.textContent = '[class$="_footerActions"] { flex-wrap: wrap; }'
  document.head.appendChild(styleEl)

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'dsh-restart-button',
      order: -20,
      label: () => '电源',
    }, RestartButton))

  // Full-screen restart/shutdown overlay (additive list slot; coexists with others).
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({
      name: 'shell.overlay',
      id: 'dsh-restart-overlay',
    }, RestartOverlay))
}
