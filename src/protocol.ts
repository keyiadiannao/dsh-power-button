/**
 * Host→client protocol values shared by both halves of dsh-power-button.
 *
 * Transport constraint: the host has no dedicated plugin→client event channel
 * for UI flows, so the `/shutdown` command carries its confirm request inside
 * the command result (`kind: 'error'` — the result kind that reaches the
 * client's `command/executed` listener). The value is a namespaced, versioned
 * protocol string rather than a bare sentinel: unrelated command errors can
 * never trigger the dialog, and a future revision can negotiate via v2 while
 * the client keeps accepting v1.
 *
 * @module dsh-power-button/protocol
 */

/** The `/shutdown` command result text that asks the client to open the GUI
 * confirm dialog (the same one the power button uses). */
export const SHUTDOWN_CONFIRM_REQUEST = 'dsh-power-button:shutdown-confirm:v1'

/** Sentinel emitted by hosts at ≤0.2.3; still accepted by the client so a
 * page loaded before a host upgrade keeps popping the dialog. */
export const SHUTDOWN_CONFIRM_REQUEST_LEGACY = 'SHUTDOWN_CONFIRM_PENDING'
