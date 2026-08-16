/**
 * Restart-complete toast — the UI-only replacement for the old "已重启"
 * assistant message that used to be written into the session event log.
 *
 * After a restart the page reloads; this component asks /health once, and when
 * the new instance reports `restarted: true` (the restart marker was consumed
 * at boot), it shows a confirmation toast with a check-draw animation that
 * fades out on its own (or can be dismissed). It then ACKs via /notice-shown
 * so a later refresh does not re-show it.
 *
 * Styling: every color comes from DSH's design tokens (`--dsw-alias-*`,
 * defined on `body` / `body[data-ds-dark-theme]` by ui-theme), so the toast
 * follows the active theme (light/dark) automatically — including the
 * official `--dsw-alias-toast-bg` background and success-state tokens.
 *
 * Why UI-only: writing an `assistant/message` into the durable session log
 * tripped the token-meter's step-pairing invariant (every assistant/message
 * needs a bracketing step/start + step/end), which made `/compact` fail and
 * eventually bricked large sessions. Nothing here touches any session file.
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useRef, useState } from 'react'
import { NS } from './index.ts'

export type RestartNoticeProps = PropsRuntime<'shell.overlay'> & PropsLocale<typeof NS>

/** How long the toast stays visible before fading out. */
const TOAST_MS = 4500
/** Health endpoint the toast consults once at mount. */
const HEALTH = '/api/dsh-power-button/health'
/** ACK endpoint that clears the in-memory restart confirmation. */
const ACK = '/api/dsh-power-button/notice-shown'

/** Static styles. All colors reference the ui-theme design tokens on `body`,
 * so light/dark and any future palette changes are picked up automatically.
 * React.CSSProperties accepts `var(--x)` strings for color-ish properties. */
const WRAP: React.CSSProperties = {
  position: 'fixed',
  bottom: 32,
  left: '50%',
  zIndex: 1800,
  /* The wrapper does NOT own translateX: the keyframes below must run on the
     same transform chain as the layout offset, so the final translate is
     baked into every keyframe (in/out would otherwise jump horizontally). */
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '12px 16px 12px 12px',
  borderRadius: 12,
  background: 'var(--dsw-alias-toast-bg, #1c2433)',
  border: '1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))',
  boxShadow: '0 12px 40px rgba(0, 0, 0, 0.4), 0 1px 0 rgba(255,255,255,0.06) inset',
  color: 'var(--dsw-alias-label-primary, #eef2f9)',
  fontFamily: 'var(--dsw-font-family, ui-sans-serif, system-ui, sans-serif)',
  fontSize: 13,
  userSelect: 'none',
  animation: 'dsh-restart-toast-in 0.35s cubic-bezier(0.21, 1.02, 0.45, 1)',
}

const BADGE: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: '50%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  background: 'var(--dsw-alias-state-business-tertiary, rgba(65, 118, 230, 0.16))',
  border: '1px solid var(--dsw-alias-state-business-primary, rgba(65, 118, 230, 0.4))',
}

const BODY: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
}

const CAPTION: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 14,
  letterSpacing: 0.2,
  lineHeight: 1.3,
}

const SUB: React.CSSProperties = {
  color: 'var(--dsw-alias-label-secondary, rgba(238,242,249,0.6))',
  fontSize: 12,
  lineHeight: 1.4,
}

const CLOSE: React.CSSProperties = {
  alignSelf: 'flex-start',
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-caption, rgba(238,242,249,0.45))',
  fontSize: 14,
  lineHeight: 1,
  padding: '2px 4px',
  cursor: 'pointer',
  borderRadius: 6,
  transition: 'color 0.15s ease, background 0.15s ease',
}

/** Fade the toast out in place (no movement), then unmount. */
const OUT: React.CSSProperties = {
  animation: 'dsh-restart-toast-out 0.25s ease forwards',
}

/** A self-contained toast: queries /health once, renders while visible,
 * ACKs when dismissed. No module-level state — the component owns its whole
 * lifecycle, so hot reload and re-mounts behave predictably. */
export function RestartNotice(props: RestartNoticeProps): JSX.Element | null {
  const { t } = props
  const [visible, setVisible] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const acked = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const ack = (): void => {
    if (acked.current) return
    acked.current = true
    // Best-effort ACK: clears the host's in-memory confirmation so a page
    // refresh does not re-show the toast. Fire-and-forget.
    void fetch(ACK, { method: 'POST', keepalive: true }).catch(() => {})
  }

  const dismiss = (): void => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current)
    ack()
    setLeaving(true)
    // Unmount after the fade-out completes.
    setTimeout(() => setVisible(false), 280)
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      let restarted = false
      try {
        const r = await fetch(HEALTH, { cache: 'no-store' })
        if (r.ok) {
          const j = await r.json().catch(() => ({})) as { restarted?: boolean }
          restarted = j.restarted === true
        }
      } catch { /* server unreachable → stay hidden */ }
      if (cancelled || !restarted) return
      setVisible(true)
      timerRef.current = setTimeout(dismiss, TOAST_MS)
    })()
    return () => {
      cancelled = true
      if (timerRef.current !== undefined) clearTimeout(timerRef.current)
      ack() // unmount mid-flight: still consume the notice so it is not re-shown
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!visible) return null

  return (
    <div
      role="status"
      aria-live="polite"
      style={leaving ? { ...WRAP, ...OUT } : WRAP}
    >
      <style>{`
        @keyframes dsh-restart-toast-in {
          from { opacity: 0; transform: translateX(-50%) translateY(14px) scale(0.96); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
        }
        @keyframes dsh-restart-toast-out {
          /* translateX(-50%) must persist: the wrapper's static style has no
             transform, so centering lives entirely in these keyframes — dropping
             it here would make the toast jump right by half its width. */
          from { opacity: 1; transform: translateX(-50%); }
          to   { opacity: 0; transform: translateX(-50%); }
        }
        @keyframes dsh-restart-check {
          from { stroke-dashoffset: 24; }
          to   { stroke-dashoffset: 0; }
        }
      `}</style>
      <span style={BADGE}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M3.5 8.5 L6.5 11.5 L12.5 4.5"
            stroke="var(--dsw-alias-state-business-primary, #4176e6)"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="24"
            strokeDashoffset="24"
            style={{ animation: 'dsh-restart-check 0.4s ease 0.15s forwards' }}
          />
        </svg>
      </span>
      <span style={BODY}>
        <span style={CAPTION}>{t('restartedToast')}</span>
        <span style={SUB}>{t('restartedToastSub')}</span>
      </span>
      <button
        type="button"
        aria-label={t('close')}
        style={CLOSE}
        onClick={dismiss}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--dsw-alias-label-primary, #eef2f9)'
          e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08))'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--dsw-alias-label-caption, rgba(238,242,249,0.45))'
          e.currentTarget.style.background = 'transparent'
        }}
      >
        ✕
      </button>
    </div>
  )
}
