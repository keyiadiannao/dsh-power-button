import { existsSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

// DSH_HOME is set by tests/setup.ts BEFORE this module is imported, so
// RUNTIME_DIR (captured at module load) points at an isolated temp dir.
const testHome = process.env.DSH_HOME as string

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  consumeRestartConfirmation, writeMarker, markerPath,
  redactCommandLine, clampModelDelayMs, pruneOldRestartLogs, requestAppExit,
  APP_EXIT_WATCHDOG_MS, PRE_EXIT_FLUSH_CAP_MS, preExitBudgetMs, helperOldPidWaitMs, flushSessionsBounded,
} from '../src/index.ts'

describe('requestAppExit', () => {
  it('takes the graceful launcher path when appExit resolves through ctx.get', () => {
    const appExit = vi.fn()
    const fallback = vi.fn()
    requestAppExit({ get: (name: string) => (name === 'appExit' ? appExit : undefined) }, fallback)
    expect(appExit).toHaveBeenCalledWith(0)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('hard-exits when the graceful exit never lands', () => {
    // Regression: an unbounded graceful exit let one lingering handle keep the
    // process alive past the restart helper's 30s patience; the helper then
    // gave up WITHOUT relaunching, so a restart could leave no server at all.
    vi.useFakeTimers()
    try {
      const appExit = vi.fn()
      const fallback = vi.fn()
      requestAppExit({ get: () => appExit }, fallback, 15_000)
      expect(appExit).toHaveBeenCalledWith(0)
      vi.advanceTimersByTime(14_999)
      expect(fallback).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(fallback).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the watchdog after DSH\'s own grace and inside the helper\'s patience', () => {
    // DSH force-exits itself after a 5s disposal grace, so a healthy dispose
    // must get to finish first; the restart helper polls the old pid for
    // 60 x 500ms before giving up, so the watchdog must fire well before that.
    expect(APP_EXIT_WATCHDOG_MS).toBeGreaterThan(5_000)
    expect(APP_EXIT_WATCHDOG_MS).toBeLessThan(30_000)
  })

  it('never reads appExit off the property proxy', () => {
    // Regression: reading `ctx.appExit` returned undefined because appExit is
    // an optional host value the plugin does not inject, so every restart and
    // shutdown silently took the process.exit fallback — skipping tree
    // disposal, the storage flush, and port release. A context that exposes
    // appExit ONLY as a property must still fall back, not call it.
    const propOnly = vi.fn()
    const fallback = vi.fn()
    requestAppExit({ appExit: propOnly, get: () => undefined }, fallback)
    expect(propOnly).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('falls back when the host provides no channel', () => {
    const fallback = vi.fn()
    requestAppExit({ get: () => undefined }, fallback)
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('falls back for a host with no Cordis service store', () => {
    const fallback = vi.fn()
    requestAppExit({}, fallback)
    requestAppExit(undefined, fallback)
    expect(fallback).toHaveBeenCalledTimes(2)
  })

  it('ignores a non-callable appExit value', () => {
    const fallback = vi.fn()
    requestAppExit({ get: () => 'not-a-function' }, fallback)
    expect(fallback).toHaveBeenCalledTimes(1)
  })
})

describe('restart marker lifecycle', () => {
  it('consumeRestartConfirmation returns the old instance for a helper-confirmed relaunch', () => {
    // A REAL helper relaunch writes relaunchedAt + newPid === the new process.
    writeMarker({
      fromInstanceId: 'instance-A',
      requestedAt: new Date().toISOString(),
      newPid: process.pid,
      relaunchedAt: new Date().toISOString(),
    })
    expect(existsSync(markerPath())).toBe(true)
    const result = consumeRestartConfirmation()
    expect(result).toEqual({ fromInstanceId: 'instance-A' })
    // Consumed: the file is gone, so a LATER ordinary boot cannot misreport.
    expect(existsSync(markerPath())).toBe(false)
  })

  it('rejects an intent-only marker (helper died before spawning) as a manual boot', () => {
    // restartDsh writes {fromInstanceId, requestedAt} BEFORE the helper spawns.
    // If the helper dies before confirming a relaunch (no newPid/relaunchedAt),
    // a subsequent MANUAL boot must NOT report "restarted".
    writeMarker({ fromInstanceId: 'instance-A', requestedAt: new Date().toISOString() })
    const result = consumeRestartConfirmation()
    expect(result).toBeNull()
    expect(existsSync(markerPath())).toBe(false)
  })

  it('rejects a marker whose newPid does not match this process', () => {
    // The helper recorded relaunching a DIFFERENT pid (e.g. its first spawn
    // failed and it retried, or the marker is from another instance): only the
    // exact process the helper spawned may claim the restart.
    writeMarker({
      fromInstanceId: 'instance-A',
      requestedAt: new Date().toISOString(),
      newPid: process.pid + 1,
      relaunchedAt: new Date().toISOString(),
    })
    const result = consumeRestartConfirmation()
    expect(result).toBeNull()
    expect(existsSync(markerPath())).toBe(false)
  })

  it('a later ordinary boot with no marker does not report restarted', () => {
    // The previous tests consumed the marker. A fresh process (different
    // instance id) starting with no marker must NOT claim a restart.
    const result = consumeRestartConfirmation()
    expect(result).toBeNull()
    expect(existsSync(markerPath())).toBe(false)
  })
})

describe('restart marker lifecycle v2 (launch token)', () => {
  afterEach(() => {
    delete process.env.DSH_POWER_RESTART_ID
  })

  it('accepts a v2 marker bound to the matching launch env token', () => {
    // A v2 helper writes the marker BEFORE spawning the child and hands it the
    // restartId as a launch env token, so the relaunched process claims the
    // restart even when it boots before any post-spawn write could land.
    writeMarker({
      schemaVersion: 2,
      restartId: 'restart-1',
      fromInstanceId: 'instance-A',
      requestedAt: new Date().toISOString(),
    })
    process.env.DSH_POWER_RESTART_ID = 'restart-1'
    const result = consumeRestartConfirmation()
    expect(result).toEqual({ fromInstanceId: 'instance-A', restartId: 'restart-1' })
    expect(existsSync(markerPath())).toBe(false)
  })

  it('rejects a v2 marker when the launch env token is absent (manual boot)', () => {
    // The helper died before spawning and left its pre-spawn marker behind, or
    // a manual boot starts with the marker still on disk: without the token it
    // must not claim the restart, and the leftover marker is cleared.
    writeMarker({
      schemaVersion: 2,
      restartId: 'restart-1',
      fromInstanceId: 'instance-A',
      requestedAt: new Date().toISOString(),
    })
    const result = consumeRestartConfirmation()
    expect(result).toBeNull()
    expect(existsSync(markerPath())).toBe(false)
  })

  it('rejects a v2 marker whose token does not match this boot', () => {
    writeMarker({
      schemaVersion: 2,
      restartId: 'restart-1',
      fromInstanceId: 'instance-A',
      requestedAt: new Date().toISOString(),
    })
    process.env.DSH_POWER_RESTART_ID = 'restart-OTHER'
    const result = consumeRestartConfirmation()
    expect(result).toBeNull()
    expect(existsSync(markerPath())).toBe(false)
  })

  it('keeps accepting a v1 marker so a pre-upgrade helper still reports', () => {
    // First restart after upgrading the plugin: the detached helper still
    // running is the 0.2.2 one, which confirms the relaunch post-spawn with
    // newPid/relaunchedAt and sets no env token. That generation must keep
    // working — downgrade/upgrade boundaries are exactly where toasts vanish.
    writeMarker({
      fromInstanceId: 'instance-A',
      requestedAt: new Date().toISOString(),
      newPid: process.pid,
      relaunchedAt: new Date().toISOString(),
    })
    const result = consumeRestartConfirmation()
    expect(result).toEqual({ fromInstanceId: 'instance-A' })
    expect(existsSync(markerPath())).toBe(false)
  })

  it('deletes the launch token from the environment after reading it', () => {
    // The token is launch-scoped: leaving it in the environment would leak it
    // to MCP children and let a LATER boot on the same process re-judge it.
    writeMarker({
      schemaVersion: 2,
      restartId: 'restart-1',
      fromInstanceId: 'instance-A',
      requestedAt: new Date().toISOString(),
    })
    process.env.DSH_POWER_RESTART_ID = 'restart-1'
    expect(consumeRestartConfirmation()).not.toBeNull()
    expect(process.env.DSH_POWER_RESTART_ID).toBeUndefined()
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
  it('stays within [floor, max] for every input', () => {
    // Regression: previously clamp(NaN, 500) returned 2000 (escaped the
    // ceiling) and a config maxDelayMs below the floor would have defeated
    // the 1000ms floor. The clamp now never leaves [1000, maxDelayMs]; the
    // schema separately rejects maxDelayMs < 1000 at config time.
    expect(clampModelDelayMs(1, 200)).toBe(200) // ceiling wins over floor
    expect(clampModelDelayMs(6000, 200)).toBe(200)
    expect(clampModelDelayMs(3000, 5000)).toBe(3000)
    expect(clampModelDelayMs(1, 5000)).toBe(1000) // floor applies within valid range
  })
  it('caps the non-numeric fallback at the configured max', () => {
    // Regression: NaN/0 previously escaped the ceiling and returned 2000 even
    // when maxDelayMs was smaller; now every outcome respects the ceiling.
    expect(clampModelDelayMs(Number.NaN, 500)).toBe(500)
    expect(clampModelDelayMs(0, 500)).toBe(500)
    expect(clampModelDelayMs(Number.NaN, 1000)).toBe(1000)
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

describe('pruneOldRestartLogs', () => {
  it('removes stale restart-helper logs and keeps recent ones', () => {
    const oldLog = join(testHome, 'restart-helper-1111.log')
    const freshLog = join(testHome, 'restart-helper-2222.log')
    writeFileSync(oldLog, 'old', 'utf8')
    writeFileSync(freshLog, 'fresh', 'utf8')
    const past = new Date(Date.now() - 10 * 24 * 3600 * 1000)
    utimesSync(oldLog, past, past)

    pruneOldRestartLogs(7)

    expect(existsSync(oldLog)).toBe(false)
    expect(existsSync(freshLog)).toBe(true)
  })

  it('removes a stale argv-bearing helper script a killed helper left behind', () => {
    const stale = join(testHome, 'dsh-restart-helper-4321-1.cjs')
    const fresh = join(testHome, 'dsh-restart-helper-8765-2.cjs')
    writeFileSync(stale, 'const relaunch = ["node"];', 'utf8')
    writeFileSync(fresh, 'const relaunch = ["node"];', 'utf8')
    const past = new Date(Date.now() - 10 * 24 * 3600 * 1000)
    utimesSync(stale, past, past)

    pruneOldRestartLogs(7)

    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })
})

describe('pre-exit durability barrier', () => {
  it('settles when a session flush never settles, instead of holding the exit open', async () => {
    const ctx = { sessions: { list: () => ['a'], flush: () => new Promise(() => {}) } }
    const started = Date.now()
    await flushSessionsBounded(ctx, 50)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  // The invariant that actually matters: the helper's patience is DERIVED from
  // the Host's worst-case exit budget. If either side is ever changed alone and
  // the helper ends up the shorter of the two, it abandons a process that is
  // still shutting down and nothing relaunches the harness.
  it('keeps the helper waiting strictly longer than the host can take to exit', () => {
    for (const delayMs of [0, 1_500, 5_000]) {
      const budget = preExitBudgetMs(delayMs)
      expect(budget).toBeGreaterThanOrEqual(PRE_EXIT_FLUSH_CAP_MS + delayMs + APP_EXIT_WATCHDOG_MS)
      expect(helperOldPidWaitMs(delayMs)).toBeGreaterThan(budget)
    }
  })

  it('tracks the restart delay, so a longer delay cannot shorten the helper bound', () => {
    expect(helperOldPidWaitMs(5_000)).toBeGreaterThan(helperOldPidWaitMs(0))
  })
})
