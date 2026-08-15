/**
 * Sidebar footer power button + upward menu (重启 / 关机).
 *
 * The button geometry is a byte-for-byte replica of the adjacent Settings
 * trigger (ui-settings-general SettingsRoot.module.css .trigger): 34px compact
 * row, `calc(100% + 8px)` width with -4px side margins, 8px icon gap, 10px
 * left padding, 22px line-height, 16px icon, radius and theme-token hover.
 * Driven by DSH theme tokens — follows light/dark automatically. Clicking
 * opens an upward menu anchored above the button; picking an action starts
 * the full-screen restart/shutdown overlay.
 */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { beginPower, NS } from './index.ts'

export type RestartButtonProps = { wide: boolean } & PropsLocale<typeof NS>

const MENU_W = 220

export function RestartButton(props: RestartButtonProps): JSX.Element {
  const { t } = props
  const [open, setOpen] = useState(false)
  // Shutdown is irreversible (the process exits and must be started manually),
  // so it always passes through a confirm dialog before beginPower('shutdown').
  const [confirming, setConfirming] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Close on outside click or Escape; move focus into the menu on open and
  // back to the trigger on close (WAI-ARIA menu-button pattern).
  useEffect(() => {
    if (!open) return
    const firstItem = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')
    firstItem?.focus()
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
      btnRef.current?.focus()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false)
        btnRef.current?.focus()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
      const idx = items.indexOf(document.activeElement as HTMLButtonElement)
      const delta = e.key === 'ArrowDown' ? 1 : -1
      if (items.length === 0) return
      const next = items[(idx + delta + items.length) % items.length]
      next?.focus()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (action: 'restart' | 'shutdown'): void => {
    setOpen(false)
    if (action === 'shutdown') {
      // Irreversible — require explicit confirmation in a dialog.
      setConfirming(true)
      return
    }
    beginPower('restart')
  }

  // Anchor the menu above the button, right-aligned to its right edge.
  // Menu height: 6px padding top + 36px item + 36px item + 6px padding bottom
  // = 84px. Offset by the full height so the menu never overlaps the button.
  const MENU_H = 84
  const anchor = (): React.CSSProperties => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return { display: 'none' }
    return {
      position: 'fixed',
      left: Math.max(8, r.right - MENU_W),
      top: Math.max(8, r.top - 8 - MENU_H),
      width: MENU_W,
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="dsh-restart-button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('powerTitle')}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: 'calc(100% + 8px)',
          minWidth: 0,
          height: 34,
          margin: '4px -4px 4px',
          boxSizing: 'border-box',
          padding: '6px 2px 6px 10px',
          flex: 'none',
          border: 'none',
          borderRadius: 12,
          background: open ? 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06))' : 'transparent',
          color: 'var(--dsw-alias-label-primary, #f2f6fc)',
          font: 'inherit',
          fontSize: 14,
          lineHeight: '22px',
          cursor: 'pointer',
          textAlign: 'left',
          overflow: 'hidden',
          transition: 'background 0.15s ease',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06))' }}
        onMouseLeave={(e) => { if (!open) (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
      >
        {/* power glyph, 16px like the settings gear */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flex: '0 0 auto' }}>
          <path d="M12 3v8" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          <path d="M7.5 5.6a8 8 0 1 0 9 0" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
        {props.wide && <span>{t('power')}</span>}
      </button>

      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('power')}
          style={{
            ...anchor(),
            zIndex: 1500,
            boxSizing: 'border-box',
            padding: 6,
            borderRadius: 12,
            background: 'var(--dsw-alias-bg-layer-2, rgba(24,28,38,0.97))',
            border: '1px solid var(--dsw-alias-border-l3, rgba(196,211,232,0.31))',
            boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            fontFamily: 'inherit',
            fontSize: 14,
            color: 'var(--dsw-alias-label-primary, #f2f6fc)',
          }}
        >
          <MenuItem
            label={t('restart')}
            title={t('restartHint')}
            onClick={() => pick('restart')}
            glyph={
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flex: '0 0 auto' }}>
                <path d="M20 12a8 8 0 1 1-2.34-5.66" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                <path d="M20 3v4h-4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
          />
          <MenuItem
            label={t('shutdown')}
            title={t('shutdownHint')}
            onClick={() => pick('shutdown')}
            glyph={
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flex: '0 0 auto' }}>
                <path d="M12 3v8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                <path d="M7.5 5.6a8 8 0 1 0 9 0" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            }
          />
        </div>
      ) : null}

      {/* Shutdown confirm dialog: irreversible action, explicit second step. */}
      {confirming ? (
        <ShutdownConfirm
          title={t('shutdownConfirmTitle')}
          body={t('shutdownConfirmBody')}
          confirmLabel={t('confirmShutdown')}
          cancelLabel={t('cancel')}
          onConfirm={() => {
            setConfirming(false)
            beginPower('shutdown')
          }}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </>
  )
}

function MenuItem({ label, title, onClick, glyph }: {
  label: string
  title?: string
  onClick: () => void
  glyph: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      title={title}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 10px',
        border: 'none',
        borderRadius: 8,
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, #f2f6fc)',
        font: 'inherit',
        fontSize: 14,
        lineHeight: '22px',
        cursor: 'pointer',
        textAlign: 'left',
        whiteSpace: 'nowrap',
        transition: 'background 0.12s ease',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06))' }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
    >
      {glyph}
      <span style={{ display: 'block', lineHeight: '22px', whiteSpace: 'nowrap', flex: 'none' }}>{label}</span>
    </button>
  )
}

/** Modal confirm dialog for the irreversible shutdown action. */
function ShutdownConfirm({ title, body, confirmLabel, cancelLabel, onConfirm, onCancel }: {
  title: string
  body: string
  confirmLabel: string
  cancelLabel: string
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') onCancel()
  }
  useEffect(() => {
    // Focus the confirm button on open; Esc cancels.
    confirmRef.current?.focus()
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
          width: 320,
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
