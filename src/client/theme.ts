/**
 * dsh-power-button design tokens — the plugin's own semantic layer, mapped
 * onto the DSH theme (`--dsw-alias-*`) with explicit fallbacks. Keeping one
 * source of truth here means a future visual pass touches one file instead of
 * every component.
 */

/** Motion: duration tiers + one shared easing. */
export const motion = {
  /** hover / micro-interactions */
  fast: '120ms',
  /** menu appear / item hover states */
  menu: '170ms',
  /** modal in */
  modal: '200ms',
  /** full-screen overlay stage transitions */
  overlay: '280ms',
  /** success / check morphs */
  success: '380ms',
  /** shared easing (Linear/Arc-style float, not the default `ease`) */
  ease: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
} as const

/** Radius tiers: small controls 8, floating surfaces 12, large modals 16. */
export const radius = {
  control: 8,
  surface: 12,
  modal: 16,
} as const

/** Shadow tiers (single source, so every surface reads as one family). */
export const shadow = {
  /** small popovers / control hints */
  small: '0 6px 20px rgba(0, 0, 0, 0.22)',
  /** menus / toasts */
  surface: '0 10px 30px rgba(0, 0, 0, 0.28)',
  /** modals */
  modal: '0 18px 56px rgba(0, 0, 0, 0.36)',
} as const

/** Full-screen lifecycle overlay veil: translucent + strong blur — the page is
 * "paused", not "gone" (avoids the crash / system-dead look of a near-black
 * veil). */
export const veil = {
  background: 'rgba(8, 10, 16, 0.68)',
  backdropFilter: 'blur(14px) saturate(0.85)',
} as const

/** Low-saturation danger surface for the irreversible-action affordance. */
export const danger = {
  /** subtle dark-red circular base behind the modal icon */
  iconBase: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff8592) 14%, var(--dsw-alias-bg-layer-2, rgba(24,28,38,0.98)))',
  /** border for the same icon base */
  iconBorder: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #ff8592) 38%, transparent)',
} as const
