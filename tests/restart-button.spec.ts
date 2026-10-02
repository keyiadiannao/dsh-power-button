import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

// DSH_HOME is set by tests/setup.ts BEFORE this module is imported, so
// RUNTIME_DIR (captured at module load) points at an isolated temp dir.
const testHome = process.env.DSH_HOME as string

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  consumeRestartConfirmation, writeMarker, markerPath,
  redactCommandLine, clampModelDelayMs, pruneOldRestartLogs, requestAppExit,
  APP_EXIT_WATCHDOG_MS, PRE_EXIT_FLUSH_CAP_MS, preExitBudgetMs, helperOldPidWaitMs, flushSessionsBounded,
  queueRestartNotice, deliverPendingNotices, restartStatus, Config,
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

  it('carries the recorded restart origin back to the relaunched instance', () => {
    writeMarker({
      schemaVersion: 2,
      restartId: 'restart-1',
      fromInstanceId: 'instance-A',
      origin: { kind: 'model-tool', sessionId: 'session-7' },
      requestedAt: new Date().toISOString(),
    })
    process.env.DSH_POWER_RESTART_ID = 'restart-1'
    expect(consumeRestartConfirmation()).toEqual({
      fromInstanceId: 'instance-A',
      restartId: 'restart-1',
      origin: { kind: 'model-tool', sessionId: 'session-7' },
    })
  })

  it('drops a malformed origin rather than trusting it as an attribution', () => {
    // The marker is durable input written by a previous process, so an
    // unrecognized producer must not be reported as the restart's origin.
    writeMarker({
      schemaVersion: 2,
      restartId: 'restart-1',
      fromInstanceId: 'instance-A',
      origin: { kind: 'something-else', sessionId: 'session-7' },
      requestedAt: new Date().toISOString(),
    })
    process.env.DSH_POWER_RESTART_ID = 'restart-1'
    expect(consumeRestartConfirmation()).toEqual({
      fromInstanceId: 'instance-A',
      restartId: 'restart-1',
    })
  })

  it('keeps an origin without a session id, for a caller that has no causal agent', () => {
    writeMarker({
      schemaVersion: 2,
      restartId: 'restart-1',
      fromInstanceId: 'instance-A',
      origin: { kind: 'http' },
      requestedAt: new Date().toISOString(),
    })
    process.env.DSH_POWER_RESTART_ID = 'restart-1'
    expect(consumeRestartConfirmation()?.origin).toEqual({ kind: 'http' })
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

  it('removes a stale restart notice whose session never came back', () => {
    const dir = join(testHome, 'power-notice')
    mkdirSync(dir, { recursive: true })
    const stale = join(dir, 'r-stale.json')
    const fresh = join(dir, 'r-fresh.json')
    writeFileSync(stale, '{}', 'utf8')
    writeFileSync(fresh, '{}', 'utf8')
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

describe('restart awareness', () => {
  const noticeDir = join(testHome, 'power-notice')

  // Each case owns the queue: a leftover notice from an earlier case would be
  // delivered by a later one and make its count meaningless.
  beforeEach(() => { rmSync(noticeDir, { recursive: true, force: true }) })

  const agentFor = (sessionId: string, injected: unknown[], woken: unknown[] = []) => ({
    agents: {
      get: (id: string) => (id === sessionId
        ? {
          inject: (m: unknown) => { injected.push(m) },
          followup: (m: unknown) => { woken.push(m) },
        }
        : undefined),
    },
  })

  it('queues nothing for a restart whose caller had no causal session', () => {
    queueRestartNotice({
      fromInstanceId: 'instance-A', restartId: 'r-http', origin: { kind: 'http' },
    })
    expect(existsSync(join(noticeDir, 'r-http.json'))).toBe(false)
  })

  it('delivers into the live session and consumes the notice', () => {
    queueRestartNotice({
      fromInstanceId: 'instance-A', restartId: 'r-1', origin: { kind: 'model-tool', sessionId: 'session-7' },
    })
    const injected: unknown[] = []
    const ctx = agentFor('session-7', injected)

    expect(deliverPendingNotices(ctx)).toBe(1)
    expect(injected).toHaveLength(1)
    expect((injected[0] as { role: string }).role).toBe('user')
    expect(existsSync(join(noticeDir, 'r-1.json'))).toBe(false)

    // Idempotent: nothing is left to replay on a later pass or boot.
    expect(deliverPendingNotices(ctx)).toBe(0)
    expect(injected).toHaveLength(1)
  })

  it('keeps the notice queued while its session is not live, and never reassigns it', () => {
    queueRestartNotice({
      fromInstanceId: 'instance-A', restartId: 'r-2', origin: { kind: 'model-tool', sessionId: 'session-9' },
    })
    const injected: unknown[] = []

    // A different session being live must not receive this restart's notice.
    expect(deliverPendingNotices(agentFor('session-other', injected))).toBe(0)
    expect(injected).toHaveLength(0)
    expect(existsSync(join(noticeDir, 'r-2.json'))).toBe(true)

    // When the right session goes live, it is delivered.
    expect(deliverPendingNotices(agentFor('session-9', injected))).toBe(1)
    expect(injected).toHaveLength(1)
  })

  it('drops a malformed record rather than attributing it to anyone', () => {
    mkdirSync(noticeDir, { recursive: true })
    writeFileSync(join(noticeDir, 'broken.json'), '{ not json', 'utf8')
    expect(deliverPendingNotices(agentFor('session-7', []))).toBe(0)
    expect(existsSync(join(noticeDir, 'broken.json'))).toBe(false)
  })

  it('keeps the notice when the inject is rejected, so a later attempt can retry', () => {
    queueRestartNotice({
      fromInstanceId: 'instance-A', restartId: 'r-3', origin: { kind: 'model-tool', sessionId: 'session-7' },
    })
    const rejecting = { agents: { get: () => ({ inject: () => { throw new Error('disposed') } }) } }
    expect(deliverPendingNotices(rejecting)).toBe(0)
    expect(existsSync(join(noticeDir, 'r-3.json'))).toBe(true)
  })

  it('coalesces to the newest notice for a session, so a closed session gets one not a backlog', () => {
    queueRestartNotice({
      fromInstanceId: 'instance-A', restartId: 'r-old', origin: { kind: 'model-tool', sessionId: 'session-7' },
    })
    queueRestartNotice({
      fromInstanceId: 'instance-B', restartId: 'r-new', origin: { kind: 'model-tool', sessionId: 'session-7' },
    })
    expect(readdirSync(noticeDir)).toEqual(['r-new.json'])

    const injected: unknown[] = []
    expect(deliverPendingNotices(agentFor('session-7', injected))).toBe(1)
    // What arrives describes the newest restart, not the superseded one.
    expect(JSON.stringify(injected[0])).toContain('instance-B')
    expect(JSON.stringify(injected[0])).not.toContain('instance-A')
  })

  it('coalescing one session leaves another session\'s notice queued', () => {
    queueRestartNotice({
      fromInstanceId: 'instance-A', restartId: 'r-a', origin: { kind: 'model-tool', sessionId: 'session-1' },
    })
    queueRestartNotice({
      fromInstanceId: 'instance-B', restartId: 'r-b', origin: { kind: 'model-tool', sessionId: 'session-2' },
    })
    expect(readdirSync(noticeDir).sort()).toEqual(['r-a.json', 'r-b.json'])
  })

  it('drops a notice with no one-line account rather than inventing one', () => {
    mkdirSync(noticeDir, { recursive: true })
    writeFileSync(join(noticeDir, 'r-nosummary.json'), JSON.stringify({ sessionId: 'session-7', text: 'x' }), 'utf8')
    expect(deliverPendingNotices(agentFor('session-7', []))).toBe(0)
    expect(existsSync(join(noticeDir, 'r-nosummary.json'))).toBe(false)
  })

  it('wakes the session exactly once in notify mode', () => {
    queueRestartNotice({
      fromInstanceId: 'instance-A', restartId: 'r-wake', origin: { kind: 'model-tool', sessionId: 'session-7' },
    }, 'notify')
    const injected: unknown[] = []
    const woken: unknown[] = []
    const ctx = agentFor('session-7', injected, woken)

    expect(deliverPendingNotices(ctx)).toBe(1)
    expect(woken).toHaveLength(1)
    // `followup` opens a turn; `inject` would only stage context. They must not
    // both fire for one notice.
    expect(injected).toHaveLength(0)

    // At most once: a later boot finds nothing left to replay.
    expect(deliverPendingNotices(ctx)).toBe(0)
    expect(woken).toHaveLength(1)
  })

  it('leaves a notify notice queued until its session is live, then wakes it', () => {
    queueRestartNotice({
      fromInstanceId: 'instance-A', restartId: 'r-later', origin: { kind: 'model-tool', sessionId: 'session-9' },
    }, 'notify')
    const injected: unknown[] = []
    const woken: unknown[] = []

    // Not live yet: nothing happens and the notice waits.
    expect(deliverPendingNotices(agentFor('session-other', injected, woken))).toBe(0)
    expect(woken).toHaveLength(0)
    expect(existsSync(join(noticeDir, 'r-later.json'))).toBe(true)

    // `session.follow` promotes the cold session into a live Agent, which is
    // what makes it deliverable.
    expect(deliverPendingNotices(agentFor('session-9', injected, woken))).toBe(1)
    expect(woken).toHaveLength(1)
    expect(injected).toHaveLength(0)
  })

  it('quiet mode stages context without waking, even when the session is live', () => {
    queueRestartNotice({
      fromInstanceId: 'instance-A', restartId: 'r-quiet', origin: { kind: 'model-tool', sessionId: 'session-7' },
    }, 'quiet')
    const injected: unknown[] = []
    const woken: unknown[] = []
    expect(deliverPendingNotices(agentFor('session-7', injected, woken))).toBe(1)
    expect(injected).toHaveLength(1)
    expect(woken).toHaveLength(0)
  })
})

describe('restartWakeMode config', () => {
  // Waking a session without a user turn is the behaviour that needs consent,
  // so the default is asserted rather than assumed.
  it('defaults to quiet', () => {
    expect(Config({} as never).restartWakeMode).toBe('quiet')
  })

  it('accepts notify and rejects anything else', () => {
    expect(Config({ restartWakeMode: 'notify' } as never).restartWakeMode).toBe('notify')
    expect(() => Config({ restartWakeMode: 'resume' } as never)).toThrow()
  })
})

describe('restartStatus', () => {
  const recordFile = (port: number): string => join(testHome, `dsh-power-restart-last-${port}.json`)
  const ctxForPort = (port: number) => ({ webServer: { server: { address: () => ({ port }) } } })

  it('reports nothing when no restart has been recorded', () => {
    expect(restartStatus(ctxForPort(31_997))).toEqual({ found: false })
  })

  it('reports the last restart: stage, timings, origin and whether this is its instance', () => {
    const port = 31_996
    writeFileSync(recordFile(port), JSON.stringify({
      schemaVersion: 2,
      restartId: 'r-1',
      port,
      oldPid: 1,
      fromInstanceId: 'instance-A',
      requestedAt: '2026-10-02T00:00:00.000Z',
      stage: 'ready',
      newPid: 2,
      toInstanceId: 'instance-B',
      readyAt: '2026-10-02T00:00:04.000Z',
      origin: { kind: 'model-tool', sessionId: 'session-7' },
      sessionQuiescent: true,
    }), 'utf8')

    expect(restartStatus(ctxForPort(port))).toMatchObject({
      found: true,
      restartId: 'r-1',
      stage: 'ready',
      fromInstanceId: 'instance-A',
      toInstanceId: 'instance-B',
      elapsedMs: 4_000,
      sessionQuiescent: true,
      origin: { kind: 'model-tool', sessionId: 'session-7' },
    })
    // This process consumed no marker, so it is not the instance that restart
    // produced — the field must not claim otherwise.
    expect(restartStatus(ctxForPort(port)).isCurrentBoot).toBe(false)
  })

  it('surfaces a failed restart with its reason instead of hiding it', () => {
    const port = 31_995
    writeFileSync(recordFile(port), JSON.stringify({
      schemaVersion: 2,
      restartId: 'r-2',
      fromInstanceId: 'instance-A',
      stage: 'failed',
      failure: { code: 'health-timeout', message: 'new process did not answer /health' },
    }), 'utf8')
    expect(restartStatus(ctxForPort(port))).toMatchObject({
      found: true,
      stage: 'failed',
      failure: { code: 'health-timeout' },
    })
  })
})
