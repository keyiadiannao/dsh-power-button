/**
 * Shared modal confirm dialog for the irreversible shutdown action. Used both
 * by the power-button menu (RestartButton) and by the `/shutdown` command path
 * (client/index.ts listens for the SHUTDOWN_CONFIRM_PENDING signal and shows
 * this same dialog before POSTing /api/dsh-power-button/shutdown).
 */
import { useEffect, useRef } from 'react'

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
        style={{
          // Responsive: full-width with a small gutter on narrow viewports.
          width: 'min(360px, calc(100vw - 32px))',
          boxSizing: 'border-box',
          padding: '20px 22px 18px',
          borderRadius: 14,
          background: 'var(--dsw-alias-bg-layer-2, rgba(24,28,38,0.98))',
          border: '1px solid var(--dsw-alias-border-l3, rgba(196,211,232,0.31))',
          boxShadow: '0 16px 48px rgba(0,0,0,0.45)',
          color: 'var(--dsw-alias-label-primary, #f2f6fc)',
        }}
      >
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
              padding: '7px 16px',
              borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l3, rgba(196,211,232,0.31))',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary, #f2f6fc)',
              font: 'inherit',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            style={{
              padding: '7px 16px',
              borderRadius: 8,
              border: '1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent)',
              // Danger button fill: mix the error primary at a low ratio into
              // the surface (official DSH pattern) instead of using the solid
              // error-secondary — in dark mode error-primary and
              // error-secondary are the SAME bright red, so a solid secondary
              // background would make the text unreadable.
              background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, var(--dsw-alias-bg-layer-2, rgba(24,28,38,0.98)))',
              color: 'var(--dsw-alias-state-error-primary, #ff8592)',
              font: 'inherit',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
