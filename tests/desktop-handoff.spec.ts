import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  advertisedDesktopRestartProtocol, consumeRestartConfirmation, desktopShellRestartAvailable, writeMarker, markerPath,
} from '../src/index.ts'

const testHome = process.env.DSH_HOME as string

describe('desktop restart capability', () => {
  // The shell advertises the protocol on every Host it starts. Guessing the surface from
  // argv or a profile name would exit a Host that nothing is waiting to relaunch.
  afterEach(() => {
    delete process.env.DSH_DESKTOP_RESTART_PROTOCOL
    delete process.env.DSH_DESKTOP_RESTART_ID
  })

  it('is unavailable without the advertised protocol', () => {
    expect(desktopShellRestartAvailable()).toBe(false)
  })

  it('rejects a malformed advertisement instead of reading it as support', () => {
    // Number('yes') is NaN, and NaN compares false against every bound.
    expect(advertisedDesktopRestartProtocol(undefined)).toBeUndefined()
    expect(advertisedDesktopRestartProtocol('')).toBeUndefined()
    expect(advertisedDesktopRestartProtocol('yes')).toBeUndefined()
    expect(advertisedDesktopRestartProtocol('0')).toBeUndefined()
    expect(advertisedDesktopRestartProtocol('-1')).toBeUndefined()
    expect(advertisedDesktopRestartProtocol('1.5')).toBeUndefined()
    expect(advertisedDesktopRestartProtocol('1')).toBe(1)
    expect(advertisedDesktopRestartProtocol('3')).toBe(3)
  })
})

describe('restart claim by the desktop launch identity', () => {
  const clearMarkers = (): void => {
    for (const name of readdirSync(testHome)) {
      if (/^dsh-power-marker-.*\.json$/u.test(name)) rmSync(join(testHome, name), { force: true })
    }
  }

  beforeEach(() => {
    clearMarkers()
  })

  afterEach(() => {
    delete process.env.DSH_POWER_RESTART_ID
    delete process.env.DSH_DESKTOP_RESTART_ID
    clearMarkers()
  })

  it('claims a marker written under another port, because the shell respawns on a new one', () => {
    // The Desktop Host binds --port 0, so the successor's own port never matches the one
    // the marker was keyed by. The launch identity is the binding.
    const markerFile = join(testHome, 'dsh-power-marker-55442.json')
    writeFileSync(markerFile, JSON.stringify({
      schemaVersion: 2,
      restartId: 'shell-restart',
      fromInstanceId: 'old-instance',
      requestedAt: new Date().toISOString(),
    }), 'utf8')

    process.env.DSH_DESKTOP_RESTART_ID = 'shell-restart'
    const claimed = consumeRestartConfirmation()

    expect(claimed?.restartId).toBe('shell-restart')
    expect(claimed?.fromInstanceId).toBe('old-instance')
    expect(existsSync(markerFile)).toBe(false)
    // The token belongs to this boot's judgment only and must not leak onward.
    expect(process.env.DSH_DESKTOP_RESTART_ID).toBeUndefined()
  })

  it('does not claim a marker for a different restart', () => {
    writeFileSync(join(testHome, 'dsh-power-marker-55443.json'), JSON.stringify({
      schemaVersion: 2,
      restartId: 'other-restart',
      fromInstanceId: 'old-instance',
      requestedAt: new Date().toISOString(),
    }), 'utf8')

    process.env.DSH_DESKTOP_RESTART_ID = 'my-restart'
    expect(consumeRestartConfirmation()).toBeNull()
  })

  it('still claims on the Web surface with the helper token', () => {
    mkdirSync(testHome, { recursive: true })
    writeMarker({ fromInstanceId: 'old-instance', requestedAt: new Date().toISOString() })
    const file = markerPath()
    const record = JSON.parse(String(readFileSync(file, 'utf8'))) as Record<string, string>
    writeFileSync(file, JSON.stringify({
      schemaVersion: 2,
      restartId: 'helper-restart',
      fromInstanceId: record['fromInstanceId'],
      requestedAt: record['requestedAt'],
    }), 'utf8')

    process.env.DSH_POWER_RESTART_ID = 'helper-restart'
    expect(consumeRestartConfirmation()?.restartId).toBe('helper-restart')
  })
})
