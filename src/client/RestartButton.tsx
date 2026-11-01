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
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { beginPower, getRestartPhase, onRestartChange, NS } from './index.ts'
import { ShutdownConfirm } from './ShutdownConfirm.tsx'
import { motion, radius, shadow } from './theme.ts'

export type RestartButtonProps = { wide: boolean } & PropsLocale<typeof NS>

const MENU_W = 212

export function RestartButton(props: RestartButtonProps): JSX.Element {
  const { t } = props
  const [open, setOpen] = useState(false)
  // Shutdown is irreversible (the process exits and must be started manually),
  // so it always passes through a confirm dialog before beginPower('shutdown').
  const [confirming, setConfirming] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  // A lifecycle flow is in flight → the power button must not re-trigger.
  // Subscribed reactively so the button flips to disabled the moment a flow
  // starts (and back once it settles).
  const phase = useSyncExternalStore(onRestartChange, getRestartPhase)
  const busy = phase !== 'idle' && phase !== 'error'

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
  // No hardcoded menu height: measure the rendered menu via menuRef and offset
  // by its ACTUAL height, so it never overlaps the button regardless of item
  // count, wrapping, or font scaling. Width is responsive: at least 16px gutter
  // on narrow viewports, capped at the menu's comfortable width.
  const anchor = (): React.CSSProperties => {
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return { display: 'none' }
    const m = menuRef.current?.getBoundingClientRect()
    const menuW = Math.min(MENU_W, Math.max(0, window.innerWidth - 16))
    const menuH = m?.height ?? 84
    return {
      position: 'fixed',
      left: Math.max(8, r.right - menuW),
      top: Math.max(8, r.top - 8 - menuH),
      width: menuW,
    }
  }

  return (
    <>
      <style>{powerKeyframes}</style>
      <button
        ref={btnRef}
        type="button"
        className="dsh-power-button"
        onClick={() => { if (!busy) setOpen(o => !o) }}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        title={busy ? t('powerBusy') : t('powerTitle')}
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
          borderRadius: radius.surface,
          background: open ? 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06))' : 'transparent',
          // Pressed state: a hairline highlight edge + faint inner shadow reads
          // as physically "pushed" when the menu is open, not just dimmed.
          boxShadow: open ? 'inset 0 1px 0 rgba(255,255,255,0.07), inset 0 0 0 1px rgba(255,255,255,0.05)' : undefined,
          color: 'var(--dsw-alias-label-primary, #f2f6fc)',
          font: 'inherit',
          fontSize: 14,
          lineHeight: '22px',
          cursor: busy ? 'default' : 'pointer',
          opacity: busy ? 0.6 : 1,
          textAlign: 'left',
          overflow: 'hidden',
          transition: `background ${motion.fast} ${motion.ease}, box-shadow ${motion.fast} ${motion.ease}, opacity ${motion.fast} ${motion.ease}`,
        }}
        onMouseEnter={(e) => { if (!busy) (e.currentTarget as HTMLButtonElement).style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06))' }}
        onMouseLeave={(e) => { if (!open) (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
      >
        {/* power glyph, 16px like the settings gear; spinner while a flow runs */}
        {busy ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flex: '0 0 auto', animation: 'dsh-power-btn-spin 0.9s linear infinite' }}>
            <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeDasharray="34 16" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flex: '0 0 auto' }}>
            <path d="M12 3v8" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
            <path d="M7.5 5.6a8 8 0 1 0 9 0" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        )}
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
            borderRadius: radius.surface,
            background: 'var(--dsw-alias-bg-layer-2, rgba(24,28,38,0.97))',
            border: '1px solid var(--dsw-alias-border-l3, rgba(196,211,232,0.31))',
            boxShadow: shadow.surface,
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            fontFamily: 'inherit',
            fontSize: 14,
            color: 'var(--dsw-alias-label-primary, #f2f6fc)',
            animation: `dsh-power-menu-in ${motion.menu} ${motion.ease}`,
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
            hint={t('shutdownStops')}
            danger
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

function MenuItem({ label, title, hint, danger, onClick, glyph }: {
  label: string
  title?: string
  /** Small secondary semantics (e.g. "Stops Harness"), 11px at reduced opacity. */
  hint?: string
  /** Shutdown item: error tint appears on hover only — calm by default. */
  danger?: boolean
  onClick: () => void
  glyph: JSX.Element
}): JSX.Element {
  const dangerHover = danger
    ? 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff8592) 10%, var(--dsw-alias-bg-layer-2, rgba(24,28,38,0.97)))'
    : 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06))'
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
        minHeight: 38,
        padding: '7px 10px',
        border: 'none',
        borderRadius: radius.control,
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, #f2f6fc)',
        font: 'inherit',
        fontSize: 14,
        lineHeight: '22px',
        cursor: 'pointer',
        textAlign: 'left',
        whiteSpace: 'nowrap',
        transition: `background ${motion.fast} ${motion.ease}`,
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = dangerHover }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
    >
      {glyph}
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, lineHeight: '22px', whiteSpace: 'nowrap', flex: '1 1 auto', minWidth: 0 }}>
        <span style={{ display: 'block', flex: 'none' }}>{label}</span>
        {hint !== undefined && (
          <span style={{ display: 'block', flex: 'none', fontSize: 11, opacity: 0.55, color: 'var(--dsw-alias-label-secondary, rgba(242,246,252,0.65))' }}>
            {hint}
          </span>
        )}
      </span>
    </button>
  )
}

/** Plugin-owned keyframes (self-contained; namespaced to avoid collisions). */
export const powerKeyframes = `
  @keyframes dsh-power-menu-in {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes dsh-power-btn-spin {
    to { transform: rotate(360deg); }
  }
`

