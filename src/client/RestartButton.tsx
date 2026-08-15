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
import { beginPower } from './index.ts'

export type RestartButtonProps = { wide: boolean }

const MENU_W = 220

export function RestartButton(props: RestartButtonProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
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
    beginPower(action)
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
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="电源（重启 / 关机）"
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
        {props.wide && <span>电源</span>}
      </button>

      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="电源"
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
            label="重启"
            title="重新启动 DeepSeek Harness"
            onClick={() => pick('restart')}
            glyph={
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ flex: '0 0 auto' }}>
                <path d="M20 12a8 8 0 1 1-2.34-5.66" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                <path d="M20 3v4h-4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
          />
          <MenuItem
            label="关机"
            title="停止 DeepSeek Harness，之后需手动启动"
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
