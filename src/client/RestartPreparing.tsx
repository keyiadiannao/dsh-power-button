/**
 * Corner "preparing to restart" hint — shown in the brief window between
 * clicking Restart and the connection actually dropping. The page stays fully
 * usable (no full-screen veil): the restart POST is still in flight and the
 * old process is only preparing to exit. Once `beginPower` advances the flow
 * to `shutting`, this hint disappears and the full-screen overlay takes over.
 */
import { useSyncExternalStore } from 'react'
import {
  getPowerAction, getRestartPhase, NS, onRestartChange, tl,
} from './index.ts'

/** Corner hint visible only during the 'preparing' phase of a restart. */
export function RestartPreparing(): JSX.Element | null {
  const phase = useSyncExternalStore(onRestartChange, getRestartPhase)
  const action = useSyncExternalStore(onRestartChange, getPowerAction)
  if (phase !== 'preparing' || action !== 'restart') return null

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 32,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1700,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 16px',
        borderRadius: 12,
        background: 'var(--dsw-alias-toast-bg, rgba(24,28,38,0.95))',
        border: '1px solid var(--dsw-alias-border-l3, rgba(196,211,232,0.25))',
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.4)',
        color: 'var(--dsw-alias-label-primary, #eef2f9)',
        fontFamily: 'var(--dsw-font-family, ui-sans-serif, system-ui, sans-serif)',
        fontSize: 13,
        userSelect: 'none',
        animation: 'dsh-restart-toast-in 0.25s cubic-bezier(0.21, 1.02, 0.45, 1)',
      }}
    >
      <style>{`
        @keyframes dsh-restart-toast-in {
          from { opacity: 0; transform: translateX(-50%) translateY(10px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        @keyframes dsh-restart-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
      <span
        aria-hidden="true"
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          border: '2px solid var(--dsw-alias-state-business-tertiary, rgba(65,118,230,0.3))',
          borderTopColor: 'var(--dsw-alias-state-business-primary, #4176e6)',
          animation: 'dsh-restart-spin 0.9s linear infinite',
          flexShrink: 0,
        }}
      />
      <span>{tl('restartPreparing')}</span>
    </div>
  )
}
