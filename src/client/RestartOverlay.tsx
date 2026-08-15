/**
 * Full-screen restart/shutdown overlay — Windows shutdown/restart aesthetic.
 *
 * Dark veil over the whole app, centered ring with a power glyph, an SVG
 * progress ring, and stage captions that fade between states:
 *   shutting   → 「正在关闭 DeepSeek Harness…」
 *   waiting    → 「正在重启…」（等待旧进程退出）
 *   recovering → 「正在恢复…」（新实例已就绪）
 *   error      → error message + 重试/关闭 buttons
 *
 * The captions adapt to the active action (restart vs shutdown): a shutdown
 * flow stops at the final caption because the process exits and never comes
 * back. Fully self-contained: own styles, own state (via the module store in
 * index.ts). Nothing is imported from any other plugin.
 */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { useSyncExternalStore } from 'react'
import {
  getRestartPhase, getPowerAction, getRestartError, onRestartChange, beginPower,
} from './index.ts'

export type RestartOverlayProps = PropsRuntime<'shell.overlay'>

const RING_R = 52
const RING_C = 2 * Math.PI * RING_R

// ---- static styles (self-contained; no external classes) ----
const VEIL: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 2000,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 28,
  background: 'rgba(8, 12, 20, 0.82)',
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
  color: '#eef2f9',
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
  userSelect: 'none',
}

const RING_WRAP: React.CSSProperties = {
  position: 'relative',
  width: 148,
  height: 148,
  /* NOT flex: the ring svg layers and the power button must all stack
     absolute on the same center point. A flex row would lay the two 148px
     svgs side by side, squash them (measured h=74!) and push the ring
     up-left of the icon — the misalignment the user caught. */
}

/** Every ring layer (track, progress, sweep) pins to the 148×148 box. */
const RING_LAYER: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
}

const POWER_BTN: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  borderRadius: '50%',
  border: '1px solid rgba(255,255,255,0.14)',
  background: 'rgba(255,255,255,0.04)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'background 0.2s ease, border-color 0.2s ease',
}

const CAPTION: React.CSSProperties = {
  fontSize: 17,
  fontWeight: 500,
  letterSpacing: 0.3,
  color: '#eef2f9',
  textAlign: 'center',
  minHeight: 26,
}

const SUB: React.CSSProperties = {
  fontSize: 13,
  color: 'rgba(238,242,249,0.55)',
  textAlign: 'center',
  maxWidth: 360,
  lineHeight: 1.6,
}

const ACTION_ROW: React.CSSProperties = {
  display: 'flex',
  gap: 12,
}

function ActionButton({ label, danger, onClick, disabled }: {
  label: string; danger?: boolean; onClick: () => void; disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '9px 26px',
        borderRadius: 8,
        border: danger ? '1px solid rgba(255,133,146,0.5)' : '1px solid rgba(255,255,255,0.18)',
        background: danger ? 'rgba(255,133,146,0.12)' : 'rgba(255,255,255,0.06)',
        color: danger ? '#ff8592' : '#eef2f9',
        fontSize: 14,
        fontWeight: 600,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 0.2s ease',
      }}
    >
      {label}
    </button>
  )
}

function PowerGlyph({ size = 40 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {/* power icon: circle arc + vertical bar */}
      <path
        d="M12 3v8"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M7.5 5.6a8 8 0 1 0 9 0"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function RestartOverlay(_props: RestartOverlayProps): JSX.Element | null {
  const phase = useSyncExternalStore(onRestartChange, getRestartPhase)
  const action = useSyncExternalStore(onRestartChange, getPowerAction)
  const error = useSyncExternalStore(onRestartChange, getRestartError)

  if (phase === 'idle') return null

  const busy = phase === 'shutting' || phase === 'waiting' || phase === 'recovering'
  const shuttingDown = action === 'shutdown'

  // Stage-driven progress: each phase advances the ring smoothly via CSS
  // transition (no infinite spin — it felt like jumping to 1/4 then hanging).
  const progressByPhase: Record<string, number> = {
    shutting: 0.22,
    waiting: 0.58,
    recovering: 1,
    off: 1,
    error: 0.9,
  }
  const progress = progressByPhase[phase] ?? 0
  const ringDash = RING_C * (1 - progress)

  // A small arc sweeps around the ring while busy (macOS-style), independent
  // of the progress fill, giving continuous motion between stage transitions.
  const ringStyle: React.CSSProperties = {
    transform: 'rotate(-90deg)',
    transformOrigin: 'center',
  }
  if (busy) {
    ringStyle.animation = 'dsh-restart-sweep 1.8s linear infinite'
  }

  const captions: Record<string, string> = shuttingDown
    ? {
        shutting: '正在关机 DeepSeek Harness…',
        waiting: '正在关机…',
        recovering: '正在恢复…',
        off: '已关机',
        error: '关机出现问题',
      }
    : {
        shutting: '正在关闭 DeepSeek Harness…',
        waiting: '正在重启…',
        recovering: '正在恢复…',
        error: '重启出现问题',
      }

  const subs: Record<string, string> = shuttingDown
    ? {
        shutting: '正在结束进程，即将断开连接',
        waiting: '等待进程退出',
        recovering: '正在恢复…',
        off: '可以关闭此页面了；需要时请手动重新启动 DSH',
        error: error ?? '未知错误',
      }
    : {
        shutting: '正在结束进程，即将断开连接',
        waiting: '等待旧进程退出，新实例即将启动',
        recovering: '新实例已就绪，正在刷新页面',
        error: error ?? '未知错误',
      }

  return (
    <div style={VEIL} role="dialog" aria-label={shuttingDown ? '关机 DeepSeek Harness' : '重启 DeepSeek Harness'} aria-busy={busy}>
      {/* keyframes: sweeping arc + progress fill transition + caption fade */}
      <style>{`
        @keyframes dsh-restart-sweep {
          0%   { transform: rotate(-90deg); }
          100% { transform: rotate(270deg); }
        }
        @keyframes dsh-restart-fade {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes dsh-restart-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.45; }
        }
      `}</style>

      <div style={RING_WRAP}>
        {/* base track */}
        <svg width={148} height={148} style={{ ...RING_LAYER, transform: 'rotate(-90deg)', transformOrigin: 'center' }}>
          <circle
            cx="74" cy="74" r={RING_R}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth="5"
          />
          {/* progress fill: smooth transition between stage targets */}
          <circle
            cx="74" cy="74" r={RING_R}
            fill="none"
            stroke={phase === 'error' ? '#ff8592' : '#4f8cff'}
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={RING_C}
            strokeDashoffset={ringDash}
            style={{ transition: 'stroke-dashoffset 1.1s cubic-bezier(0.4, 0, 0.2, 1)' }}
          />
        </svg>
        {/* sweeping arc while busy */}
        {busy ? (
          <svg width={148} height={148} style={{ ...RING_LAYER, ...ringStyle }} aria-hidden="true">
            <circle
              cx="74" cy="74" r={RING_R}
              fill="none"
              stroke="rgba(79,140,255,0.5)"
              strokeWidth="5"
              strokeLinecap="round"
              strokeDasharray={`${RING_C * 0.18} ${RING_C * 0.82}`}
            />
          </svg>
        ) : null}
        {/* power button */}
        <button
          type="button"
          style={POWER_BTN}
          tabIndex={-1}
          aria-hidden={!busy}
        >
          <span
            style={{
              color: phase === 'error' ? '#ff8592' : '#eef2f9',
              animation: busy ? 'dsh-restart-pulse 2s ease-in-out infinite' : undefined,
            }}
          >
            <PowerGlyph />
          </span>
        </button>
      </div>

      <div key={phase} style={{ ...CAPTION, animation: 'dsh-restart-fade 0.35s ease' }}>
        {captions[phase]}
      </div>
      <div key={`sub-${phase}`} style={{ ...SUB, animation: 'dsh-restart-fade 0.35s ease 0.08s both' }}>
        {subs[phase]}
      </div>

      {phase === 'error' ? (
        <div style={{ ...ACTION_ROW, animation: 'dsh-restart-fade 0.35s ease 0.15s both' }}>
          <ActionButton label="重试" onClick={() => beginPower(action)} />
          <ActionButton label="关闭" danger onClick={() => window.location.reload()} />
        </div>
      ) : null}
    </div>
  )
}
