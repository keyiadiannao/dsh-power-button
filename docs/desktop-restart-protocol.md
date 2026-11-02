# Desktop restart: the host-side change

Desktop restart cannot be implemented inside this plugin. The Host is a child of the Electron shell, the shell treats every Host exit as a crash, and a helper spawned by the plugin would leave a second Host with no window and no IPC. Making it work requires changing DeepSeek Harness itself, which is outside this plugin's safety boundary. Review the steps below and decide whether to allow an agent to perform them on your installation. Until then this plugin refuses Desktop restart and shutdown with `503 desktop-unsupported`.

**Base.** Written and compiled against DSH `687f282e86` (0.2.1-rc.2) and plugin `d817e15`. On another release compare the interfaces before copying: the constructor parameter list, the Host event union and the profile layout all change between releases. Never replace an existing parameter — append.

## Why the host must change

`apps/desktop/src/host-process.ts` records every Host exit as a failure, exit code 0 included, so a requested exit is indistinguishable from a crash:

```ts
child.once('close', (code) => {
  if (code !== 0 && code !== null) this.fail(new Error(`dsh desktop host exited with …`))
  else this.fail(new Error(`dsh desktop host stopped…`))
  resolve()
})
```

`app.relaunch()` is reachable only from the fatal-recovery dialog.

## Change 1 — one-shot handoff record

New file `apps/desktop/src/restart-handoff.ts`. `app.relaunch()` carries neither arguments nor environment, so the restart identity has to survive on disk.

```ts
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DESKTOP_RESTART_ID_ENV = 'DSH_DESKTOP_RESTART_ID'
export const DESKTOP_RESTART_PROTOCOL_ENV = 'DSH_DESKTOP_RESTART_PROTOCOL'
export const DESKTOP_RESTART_PROTOCOL_VERSION = 1

export function restartHandoffPath(userData: string): string {
  return join(userData, 'restart-handoff.json')
}

export function writeRestartHandoff(path: string, restartId: string, now = new Date()): void {
  // Write beside the target, then rename: a crash mid-write must not leave a half
  // record that the next launch reads as a restart.
  const temporary = `${path}.tmp`
  writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, restartId, requestedAt: now.toISOString(), pid: process.pid }),
    { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

/** Read-and-delete, so an ordinary launch cannot claim a restart it did not request. */
export function consumeRestartHandoff(path: string, now = new Date()): string | undefined {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return undefined }
  // Consuming is only safe once the record is gone: a failed delete would let the next
  // launch claim the same restart again, so report absent and leave it alone.
  try { rmSync(path, { force: true }) } catch { return undefined }
  let parsed: { schemaVersion?: unknown, restartId?: unknown, requestedAt?: unknown } | null
  try { parsed = JSON.parse(text) } catch { return undefined }
  if (parsed === null || parsed.schemaVersion !== 1 || typeof parsed.restartId !== 'string'
    || parsed.restartId.length === 0 || typeof parsed.requestedAt !== 'string') return undefined
  const age = now.getTime() - Date.parse(parsed.requestedAt)
  // Both bounds matter: a future timestamp means the clock moved, not that a restart happened.
  return Number.isFinite(age) && age >= 0 && age <= 60 * 60 * 1000 ? parsed.restartId : undefined
}
```

## Change 2 — accept one restart request

`apps/desktop/src/host-process.ts`: add `{ readonly type: 'desktop-restart-requested'; readonly restartId: string }` to the event union, accept it in the validator (`typeof candidate.restartId === 'string' && candidate.restartId.length > 0`), and handle it before the shutdown branch:

```ts
else if (message.type === 'desktop-restart-requested') {
  // Once, and only before the shell starts stopping: a repeat would relaunch a second app.
  if (this.restartRequest === undefined && !this.stopping) {
    this.restartRequest = message.restartId
    this.onRestartRequested?.(message.restartId)
  } else if (this.restartRequest !== message.restartId) {
    this.fail(new Error('dsh desktop host requested a restart the shell did not ask for'))
  }
}
```

Append `onRestartRequested?: (restartId: string) => void` to the constructor and add the `restartRequest: string | undefined` field it fills.

## Change 3 — record, then relaunch once

`apps/desktop/src/main.ts`:

```ts
const previousRestartId = consumeRestartHandoff(restartHandoffPath(app.getPath('userData')))

// Environment of the Host child process.
{
  ...hostEnvironment,
  // Advertised on every launch, not only after a restart: the plugin gates on it.
  [DESKTOP_RESTART_PROTOCOL_ENV]: String(DESKTOP_RESTART_PROTOCOL_VERSION),
  ...(previousRestartId === undefined ? {} : { [DESKTOP_RESTART_ID_ENV]: previousRestartId }),
}

let relaunchRequested = false
function requestApplicationRestart(restartId: string): void {
  if (relaunchRequested) return
  try {
    writeRestartHandoff(restartHandoffPath(app.getPath('userData')), restartId)
  } catch (error) {
    // Without the record the successor cannot prove itself; keep running instead.
    console.error('desktop restart: could not record the handoff', error)
    return
  }
  relaunchRequested = true
  app.relaunch()
  quitWithoutConfirmation()
}
```

The callback must be wired where the Host is constructed, or the request never reaches the shell. **Append** it after the existing arguments — newer releases already pass `onPluginOperation` as the last parameter, and replacing it breaks plugin diagnostics:

```ts
const host = new DesktopHostProcess(resources.node, resources.dsh, activeProject, hostInspectPort,
  { /* the environment above */ }, onFailure, primaryRuntime, resources,
  (next) => { platformView.setSession(next) },
  (record) => { /* existing onPluginOperation wiring, if this release has one */ },
  (restartId) => { requestApplicationRestart(restartId) })
```

Stopping the Host as part of quitting sets `stopping`, so that exit does not reach the failure path and no recovery dialog appears.

## Plugin side

Nothing to patch: plugin 0.4.32 and later already implement both halves - the capability gate on `DSH_DESKTOP_RESTART_PROTOCOL` (a positive integer, with the IPC channel connected), the claim using `DSH_POWER_RESTART_ID ?? DSH_DESKTOP_RESTART_ID`, marker lookup by `restartId` instead of by port, and the hand-over itself. On an older plugin, update it first; it starts using the shell the moment the advertisement appears, and keeps refusing while it does not.

## Acceptance

Run these in order; any failure means the change is not ready.

1. The Host child process environment contains `DSH_DESKTOP_RESTART_PROTOCOL=1`.
2. A restart request reaches the shell once; sending it twice does not relaunch twice.
3. The `electron` process count is unchanged after a restart and exactly one `dsh-desktop-host` child exists.
4. The new Host reports the request's `restartId` on `/health`, with `fromInstanceId` naming the old instance.
5. No crash report, no recovery dialog, no orphan Host. The new port may differ; the Desktop Host binds `--port 0`.
6. An ordinary launch afterwards reports no restart, and the handoff file is gone after being read.

## Remaining limits

- `process.send` confirms delivery, not acceptance: if the shell cannot record the handoff it keeps running while the requester was told the restart was accepted. An explicit `restart-accepted` reply is not implemented.
- The Desktop surface writes no helper status, so `restartStatus` has no entry there; confirmation is `/health.restart`.
