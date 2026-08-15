import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate DSH_HOME BEFORE importing the module: RUNTIME_DIR is captured at
// module load, so the marker tests never touch the real ~/.dsh.
const testHome = mkdtempSync(join(tmpdir(), 'dsh-restart-test-'))
process.env.DSH_HOME = testHome

import { afterAll, describe, expect, it } from 'vitest'
import {
  consumeRestartConfirmation, writeMarker, markerPath,
  redactCommandLine, clampModelDelayMs,
} from '../src/index.ts'

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true })
})

describe('restart marker lifecycle', () => {
  it('consumeRestartConfirmation returns the old instance and deletes the marker', () => {
    writeMarker({ fromInstanceId: 'instance-A', requestedAt: new Date().toISOString() })
    expect(existsSync(markerPath())).toBe(true)
    const result = consumeRestartConfirmation()
    expect(result).toEqual({ fromInstanceId: 'instance-A' })
    // Consumed: the file is gone, so a LATER ordinary boot cannot misreport.
    expect(existsSync(markerPath())).toBe(false)
  })

  it('a later ordinary boot with no marker does not report restarted', () => {
    // The previous test consumed the marker. A fresh process (different
    // instance id) starting with no marker must NOT claim a restart.
    const result = consumeRestartConfirmation()
    expect(result).toBeNull()
    expect(existsSync(markerPath())).toBe(false)
  })
})

describe('clampModelDelayMs', () => {
  it('floors sub-second delays so the tool cannot kill its own turn', () => {
    expect(clampModelDelayMs(1, 5000)).toBe(1000)
    expect(clampModelDelayMs(0, 5000)).toBe(2000)
    expect(clampModelDelayMs(Number.NaN, 5000)).toBe(2000)
  })
  it('clamps to the configured max and keeps valid mid-range values', () => {
    expect(clampModelDelayMs(3000, 5000)).toBe(3000)
    expect(clampModelDelayMs(6000, 5000)).toBe(5000)
    expect(clampModelDelayMs(2000, 5000)).toBe(2000)
  })
})

describe('redactCommandLine', () => {
  it('redacts inline key=value secrets', () => {
    const out = redactCommandLine(['dsh', '--api-key=sk-abc12345'])
    expect(out).not.toContain('sk-abc12345')
    expect(out).toContain('***')
  })
  it('redacts a value following a credential key token', () => {
    const out = redactCommandLine(['dsh', '--api-key', 'sk-abc12345'])
    expect(out).not.toContain('sk-abc12345')
  })
  it('keeps ordinary arguments intact', () => {
    const out = redactCommandLine(['node', 'bin.ts', '--profile', 'web', '--port', '3080'])
    expect(out).toBe('node bin.ts --profile web --port 3080')
  })
  it('redacts bare secret-shaped tokens (no key prefix)', () => {
    const out = redactCommandLine(['dsh', 'sk-proj-1234567890abcdef'])
    expect(out).not.toContain('sk-proj-1234567890abcdef')
  })
})
