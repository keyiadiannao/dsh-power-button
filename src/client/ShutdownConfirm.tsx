/**
 * Shared modal confirm dialog for the irreversible shutdown action. Used both
 * by the power-button menu (RestartButton) and by the `/shutdown` command path
 * (client/index.ts listens for the SHUTDOWN_CONFIRM_PENDING signal and shows
 * this same dialog before POSTing /api/dsh-power-button/shutdown).
 */
import { useEffect, useRef } from 'react'
import { danger, motion, radius, shadow } from './theme.ts'

/** Fully self-contained: styled with DSH design tokens, own focus trap and Esc handling. */
export function ShutdownConfirm({ title, body, confirmLabel, cancelLabel, onConfirm, onCancel }: {
  title: string
  body: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      onCancel()
      return
    }
    // Modal focus trap: Tab/Shift+Tab cycle ONLY between the two dialog
    // buttons, so focus can never escape behind the modal.
    if (e.key !== 'Tab') return
    const focusables = [cancelRef.current, confirmRef.current].filter((el): el is HTMLButtonElement => el !== null)
    if (focusables.length === 0) return
    const active = document.activeElement as HTMLElement | null
    const idx = focusables.indexOf(active as HTMLButtonElement)
    if (e.shiftKey) {
      // Shift+Tab from the first button wraps to the last.
      if (idx <= 0) {
        e.preventDefault()
        focusables[focusables.length - 1]?.focus()
      }
    } else {
      // Tab from the last button wraps to the first.
      if (idx >= focusables.length - 1 || idx === -1) {
        e.preventDefault()
        focusables[0]?.focus()
      }
    }
  }
  useEffect(() => {
    // Default focus goes to CANCEL, not confirm: for a destructive action the
    // user must make a deliberate choice to proceed — a stray Enter (or the
    // focus landing on the dangerous button) must never shut down the harness.
    // Esc still cancels as a backup.
    cancelRef.current?.focus()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        // Click on the veil (outside the card) cancels.
        if (e.target === e.currentTarget) onCancel()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1600,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--dsw-alias-bg-mask-2, rgba(0,0,0,0.4))',
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
        fontFamily: 'var(--dsw-font-family, ui-sans-serif, system-ui, sans-serif)',
      }}
    >
      <div
        data-dsh-power-modal
        style={{
          // Responsive: full-width with a small gutter on narrow viewports.
          width: 'min(360px, calc(100vw - 32px))',
          boxSizing: 'border-box',
          padding: '22px 22px 18px',
          borderRadius: radius.modal,
          background: 'var(--dsw-alias-bg-layer-2, rgba(24,28,38,0.98))',
          border: '1px solid var(--dsw-alias-border-l3, rgba(196,211,232,0.31))',
          boxShadow: shadow.modal,
          color: 'var(--dsw-alias-label-primary, #f2f6fc)',
          animation: `dsh-power-modal-in ${motion.modal} ${motion.ease}`,
        }}
      >
        {/* Irreversible-action affordance: a low-saturation dark-red circular
            base with a power glyph — first thing the eye lands on, without the
            shout of a solid red warning. */}
        <div
          aria-hidden="true"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 36,
            height: 36,
            borderRadius: '50%',
            background: danger.iconBase,
            border: `1px solid ${danger.iconBorder}`,
            color: 'var(--dsw-alias-state-error-primary, #ff8592)',
            marginBottom: 14,
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M12 3v8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            <path d="M7.5 5.6a8 8 0 1 0 9 0" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          </svg>
        </div>
        <div style={{ fontSize: 15, fontWeight: 650, lineHeight: 1.4, marginBottom: 8 }}>
          {title}
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, rgba(242,246,252,0.7))', marginBottom: 18 }}>
          {body}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            style={{
              height: 36,
              padding: '0 16px',
              borderRadius: radius.control,
              border: 'none',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary, #f2f6fc)',
              font: 'inherit',
              fontSize: 13,
              cursor: 'pointer',
              transition: `background ${motion.fast} ${motion.ease}`,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.14))' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            style={{
              height: 36,
              padding: '0 16px',
              borderRadius: radius.control,
              border: `1px solid ${danger.iconBorder}`,
              // Danger button fill: mix the error primary at a low ratio into
              // the surface (official DSH pattern) instead of using the solid
              // error-secondary — in dark mode error-primary and
              // error-secondary are the SAME bright red, so a solid secondary
              // background would make the text unreadable.
              background: danger.iconBase,
              color: 'var(--dsw-alias-state-error-primary, #ff8592)',
              font: 'inherit',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              transition: `background ${motion.fast} ${motion.ease}`,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
      <style>{`
        @keyframes dsh-power-modal-in {
          from { opacity: 0; transform: translateY(8px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-dsh-power-modal] { animation: none !important; }
        }
      `}</style>
    </div>
  )
}
