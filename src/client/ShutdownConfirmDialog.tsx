/**
 * /shutdown command → GUI confirm dialog.
 *
 * The host `/shutdown` handler never shuts down directly: it signals
 * `SHUTDOWN_CONFIRM_PENDING` through the command/executed event, and this
 * dialog (rendered in shell.overlay) shows the SAME confirmation UI as the
 * power button. Confirm → beginPower('shutdown') POSTs the real shutdown;
 * cancel just dismisses.
 */
import { useSyncExternalStore } from 'react'
import {
  beginPower, cancelShutdownConfirm, isShutdownConfirmVisible, NS, onShutdownConfirmChange, tl,
} from './index.ts'
import { ShutdownConfirm } from './ShutdownConfirm.tsx'

/** Dialog rendered in shell.overlay while the /shutdown confirm is pending. */
export function ShutdownConfirmDialog(): JSX.Element | null {
  const visible = useSyncExternalStore(onShutdownConfirmChange, isShutdownConfirmVisible)
  if (!visible) return null
  return (
    <ShutdownConfirm
      title={tl('shutdownConfirmTitle')}
      body={tl('shutdownConfirmBody')}
      confirmLabel={tl('confirmShutdown')}
      cancelLabel={tl('cancel')}
      onConfirm={() => {
        cancelShutdownConfirm()
        beginPower('shutdown')
      }}
      onCancel={cancelShutdownConfirm}
    />
  )
}
