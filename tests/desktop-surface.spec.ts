import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const testHome = process.env.DSH_HOME as string

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { consumeRestartConfirmation, writeMarker } from '../src/index.ts'

/**
 * The Desktop host launches the web app with a hardcoded `--port 0`, so a
 * successor lands on a fresh OS-chosen port every time. That breaks two things
 * that are keyed by port, and both are covered here:
 *
 *  - the restart marker, which the successor must still find and claim;
 *  - the helper's readiness probe, which must discover the port the successor
 *    actually bound instead of waiting on the old one until it times out.
 *
 * The marker half lives in the host process, so it is unit-testable here; the
 * helper half runs inside the emitted template and is covered by the runtime
 * acceptance suite.
 */
describe('restart marker claimed across port keys', () => {
  const markerFor = (port: number) => join(testHome, `dsh-power-marker-${port}.json`)

  beforeEach(() => {
    for (const name of readdirSync(testHome)) {
      if (/^dsh-power-marker-.*\.json$/u.test(name)) rmSync(join(testHome, name), { force: true })
    }
  })

  afterEach(() => {
    delete process.env.DSH_POWER_RESTART_ID
  })

  it('claims a marker that sits under a DIFFERENT port key than this process', () => {
    // The helper wrote the marker for the OLD port (55441) before spawning; the
    // successor came up somewhere else, so markerPath() here points at a file
    // that does not exist.
    const oldPortMarker = markerFor(55441)
    writeFileSync(oldPortMarker, JSON.stringify({
      schemaVersion: 2,
      restartId: 'cross-port-restart',
      fromInstanceId: 'old-instance',
      origin: { kind: 'http' },
      requestedAt: new Date().toISOString(),
    }), 'utf8')

    process.env.DSH_POWER_RESTART_ID = 'cross-port-restart'
    const claimed = consumeRestartConfirmation()

    expect(claimed).not.toBeNull()
    expect(claimed?.restartId).toBe('cross-port-restart')
    expect(claimed?.fromInstanceId).toBe('old-instance')
    // Consumed, so a later boot cannot claim it again.
    expect(existsSync(oldPortMarker)).toBe(false)
  })

  it('still refuses a marker whose restartId does not match the launch token', () => {
    // A marker from an unrelated restart must never be claimed just because it
    // exists under some port key.
    writeFileSync(markerFor(55441), JSON.stringify({
      schemaVersion: 2,
      restartId: 'someone-elses-restart',
      fromInstanceId: 'old-instance',
      requestedAt: new Date().toISOString(),
    }), 'utf8')

    process.env.DSH_POWER_RESTART_ID = 'my-restart'
    const claimed = consumeRestartConfirmation()

    expect(claimed).toBeNull()
  })

  it('ignores a v1 marker when searching across port keys', () => {
    // The cross-port search only accepts schemaVersion 2: a v1 marker is claimed
    // by child pid, which a differently-ported successor can never satisfy.
    writeFileSync(markerFor(55441), JSON.stringify({
      schemaVersion: 1,
      fromInstanceId: 'old-instance',
      relaunchedAt: new Date().toISOString(),
      newPid: process.pid,
    }), 'utf8')

    process.env.DSH_POWER_RESTART_ID = 'v2-token'
    const claimed = consumeRestartConfirmation()

    // No v2 marker carries this token, so nothing is claimed.
    expect(claimed).toBeNull()
  })

  it('claims the same-port marker without needing the cross-port search', () => {
    // The ordinary (Web) case must keep working: the marker sits under this
    // process's own port key.
    const { markerPath } = require('../src/index.ts')
    writeMarker({ fromInstanceId: 'old-instance', requestedAt: new Date().toISOString() })
    const file = markerPath()
    const record = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({
      schemaVersion: 2,
      restartId: 'same-port-restart',
      fromInstanceId: record.fromInstanceId,
      requestedAt: record.requestedAt,
    }), 'utf8')

    process.env.DSH_POWER_RESTART_ID = 'same-port-restart'
    const claimed = consumeRestartConfirmation()

    expect(claimed?.restartId).toBe('same-port-restart')
    expect(existsSync(file)).toBe(false)
  })
})
