import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRestartHelper, pinRelaunchPort } from '../src/index.ts'

// The runtime acceptance suite: the helper script under test is the EXACT
// output the host ships (buildRestartHelper), executed as a real detached
// process against real target processes on a real TCP port. Everything unit
// tests cannot prove — pid exit detection, port release, session quiescence,
// the env-token relaunch, health confirmation — is exercised here.

const TARGET = fileURLToPath(new URL('./runtime/restart-target.cjs', import.meta.url))
const OLD = 'instance-OLD'
const NEW = 'instance-NEW'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => { resolve(port) })
    })
  })
}

function getHealth(port: number): Promise<{
  ok?: boolean
  instanceId?: string
  /** Restart identity, exposed for the process's whole lifetime (schema v2). */
  restart?: { restartId?: string, fromInstanceId?: string }
} | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/dsh-power-button/health', timeout: 1500 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch { resolve(null) }
      })
    })
    req.on('error', () => { resolve(null) })
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

function readStatus(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Poll until `probe` returns non-null; null on timeout. */
async function waitFor<T>(probe: () => Promise<T> | T, timeoutMs: number, stepMs = 100): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== null && value !== undefined) return value
    if (Date.now() >= deadline) return null
    await new Promise((r) => { setTimeout(r, stepMs) })
  }
}

function exitOf(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
    child.once('exit', () => { resolve() })
  })
}

function killPid(pid: number | undefined): void {
  if (typeof pid !== 'number') return
  try { process.kill(pid) } catch { /* already gone */ }
}

/** The port a `--port 0` target was actually granted, once it reports it. */
async function waitForBoundPort(file: string): Promise<number> {
  const bound = await waitFor(async () => {
    try {
      const n = Number(readFileSync(file, 'utf8').trim())
      return Number.isInteger(n) && n > 0 ? n : null
    } catch { return null }
  }, 10_000)
  if (bound === null) throw new Error('target never reported its bound port')
  return bound
}

/** Shared rig: temp home, a live old-instance target, and a generated helper
 * whose every file lands in the temp dir (never the real ~/.dsh). */
async function startRidge(opts: {
  relaunchInstance?: string
  commitWaitMs?: number
  readyWaitMs?: number
  oldPidWaitMs?: number
  relaunchExec?: string
  forgetRestart?: boolean
  /** Play the `--port 0` case: the old target lets the OS choose its port, and
   * the relaunch argv is built through the plugin's own port pin. */
  dynamicPort?: boolean
  /** Point the restart marker at an uncreatable path, so the helper's write
   * fails while the successor still boots. */
  markerWriteFails?: boolean
  /** Shorten the session-quiescence window so a still-moving log is reachable
   * inside a test instead of after fifteen seconds. */
  quiescenceWaitMs?: number
  /** Extra arguments appended to the successor's argv (the environment test
   * passes its dump flags through here). */
  targetArgs?: string[]
} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-power-e2e-'))
  const portFile = join(home, 'port.txt')
  const requestedPort = opts.dynamicPort ? '0' : String(await freePort())
  const oldArgs = [TARGET, '--port', requestedPort, '--instance-id', OLD]
  if (opts.dynamicPort) oldArgs.push('--port-file', portFile)
  const old = spawn(process.execPath, oldArgs, { stdio: 'ignore' })
  const port = opts.dynamicPort ? await waitForBoundPort(portFile) : Number(requestedPort)
  const up = await waitFor(async () => {
    const h = await getHealth(port)
    return h?.instanceId === OLD ? h : null
  }, 10_000)
  if (up === null) throw new Error('fake old target never became healthy')

  const restartId = randomUUID()
  // A file where the marker's parent directory should be makes the helper's
  // writeFileSync fail with ENOTDIR, which is the real failure this models:
  // the write itself breaks, not the process launch.
  const markerFile = opts.markerWriteFails
    ? join(home, 'blocked', 'marker.json')
    : join(home, 'marker.json')
  if (opts.markerWriteFails) writeFileSync(join(home, 'blocked'), 'not a directory', 'utf8')
  const statusFile = join(home, 'status.json')
  const helperFile = join(home, 'helper.cjs')
  const commitFile = join(home, 'commit.json')
  const relaunchExec = opts.relaunchExec ?? process.execPath
  const relaunchInstance = opts.relaunchInstance ?? NEW
  // In the dynamic case the successor's arguments go through the same pin the
  // plugin applies, so this exercises the real fix instead of restating it: a
  // verbatim `--port 0` replay would land on a different port than the helper
  // is waiting for.
  const relaunchArgs = opts.dynamicPort
    ? [relaunchExec, TARGET, ...pinRelaunchPort(['--port', '0', '--instance-id', relaunchInstance], port), '--marker', markerFile]
    : [relaunchExec, TARGET, '--port', String(port), '--instance-id', relaunchInstance, '--marker', markerFile]
  if (opts.forgetRestart) relaunchArgs.push('--forget-restart')
  if (opts.targetArgs !== undefined) relaunchArgs.push(...opts.targetArgs)
  writeFileSync(helperFile, buildRestartHelper({
    relaunch: relaunchArgs,
    cwd: home,
    port,
    oldPid: old.pid as number,
    oldInstanceId: OLD,
    restartId,
    markerFile,
    statusFile,
    lastStatusFile: join(home, 'last.json'),
    commitFile,
    logFile: join(home, 'helper.log'),
    serverLog: join(home, 'server.log'),
    sessionsRoot: join(home, 'sessions'),
    commitWaitMs: opts.commitWaitMs ?? 15_000,
    readyWaitMs: opts.readyWaitMs ?? 30_000,
    // The Host derives this from its own exit budget; the rig plays the Host,
    // so it supplies a short bound that is still comfortably longer than the
    // fake old process needs to die.
    oldPidWaitMs: opts.oldPidWaitMs ?? 10_000,
    // Spread rather than pass-through: the payload field is optional, and
    // `exactOptionalPropertyTypes` rejects an explicit `undefined`.
    ...(opts.quiescenceWaitMs === undefined ? {} : { quiescenceWaitMs: opts.quiescenceWaitMs }),
    requestedAt: new Date().toISOString(),
  }), 'utf8')

  const helper = spawn(process.execPath, [helperFile], { stdio: 'ignore' })
  return { home, port, old, helper, helperFile, restartId, markerFile, statusFile, commitFile }
}

/** Play the Host's handshake: wait for ARMED, write COMMIT, end the old process. */
async function commitAndExitOld(rig: Awaited<ReturnType<typeof startRidge>>): Promise<void> {
  const armed = await waitFor(() => {
    const s = readStatus(rig.statusFile)
    return s !== null && s.restartId === rig.restartId && typeof s.armedAt === 'string' ? s : null
  }, 10_000)
  expect(armed).not.toBeNull()
  writeFileSync(rig.commitFile, JSON.stringify({ schemaVersion: 2, restartId: rig.restartId, committedAt: new Date().toISOString() }), 'utf8')
  rig.old.kill()
  await exitOf(rig.old)
}

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

describe('restart runtime acceptance (real helper, real processes)', () => {
  it('relaunches end to end: armed → commit → old exit → new instance ready', { timeout: 60_000 }, async () => {
    const rig = await startRidge()
    let newPid: number | undefined
    try {
      await commitAndExitOld(rig)
      const done = await waitFor(() => {
        const s = readStatus(rig.statusFile)
        return s !== null && (s.stage === 'ready' || s.stage === 'failed') ? s : null
      }, 45_000)
      expect(done?.stage).toBe('ready')
      expect(done?.toInstanceId).toBe(NEW)
      expect(typeof done?.newPid).toBe('number')
      // The relaunch must not proceed while the old session write-behind could
      // still be draining: with an empty sessions dir quiescence lands fast,
      // but it must be TRUE, not skipped.
      expect(done?.sessionQuiescent).toBe(true)
      // The env-token marker is written BEFORE the child spawns (schema v2).
      const marker = JSON.parse(readFileSync(rig.markerFile, 'utf8')) as Record<string, unknown>
      expect(marker).toMatchObject({ schemaVersion: 2, restartId: rig.restartId, fromInstanceId: OLD })
      // The port now answers from the NEW instance, carrying the restart
      // identity this launch token produced — the same field the helper's
      // ready gate required.
      const health = await getHealth(rig.port)
      expect(health?.instanceId).toBe(NEW)
      expect(health?.restart?.restartId).toBe(rig.restartId)
      newPid = done?.newPid as number
    } finally {
      killPid(rig.old.pid)
      killPid(newPid)
      killPid(rig.helper.pid)
    }
  })

  it('relaunches a --port 0 instance onto the port it actually bound', { timeout: 60_000 }, async () => {
    // The case the whole pin exists for: with `--port 0` the OS chooses, so a
    // verbatim replay would give the successor a different port. The helper
    // would then poll the old one until health-timeout while the new instance
    // sat healthy elsewhere, and the per-port marker would never be claimed.
    const rig = await startRidge({ dynamicPort: true })
    let newPid: number | undefined
    try {
      // Sanity: the rig really is on an OS-assigned port, not a chosen one.
      expect(rig.port).toBeGreaterThan(1_024)

      await commitAndExitOld(rig)
      const done = await waitFor(() => {
        const s = readStatus(rig.statusFile)
        return s !== null && (s.stage === 'ready' || s.stage === 'failed') ? s : null
      }, 45_000)
      expect(done?.stage).toBe('ready')

      // The successor is reachable on the SAME port the helper waited for — the
      // property a verbatim `--port 0` replay would break.
      const health = await getHealth(rig.port)
      expect(health?.instanceId).toBe(NEW)
      expect(health?.restart?.restartId).toBe(rig.restartId)
      newPid = done?.newPid as number
    } finally {
      killPid(rig.old.pid)
      killPid(newPid)
      killPid(rig.helper.pid)
    }
  })

  it('never relaunches when the host never commits — the old instance stays up', { timeout: 30_000 }, async () => {
    const rig = await startRidge({ commitWaitMs: 800 })
    try {
      // Armed but no COMMIT ever written: the helper must abandon without
      // spawning anything. This is the core safety property — an exit with no
      // successor is the one outcome the UI cannot recover from.
      const done = await waitFor(() => {
        const s = readStatus(rig.statusFile)
        return s !== null && (s.stage === 'failed' || s.stage === 'ready') ? s : null
      }, 20_000)
      expect(done?.stage).toBe('failed')
      expect((done?.failure as { code?: string } | undefined)?.code).toBe('commit-timeout')
      expect(done?.newPid).toBeUndefined()
      await exitOf(rig.helper)
      // The old instance is untouched and still serving.
      expect((await getHealth(rig.port))?.instanceId).toBe(OLD)
    } finally {
      killPid(rig.old.pid)
      killPid(rig.helper.pid)
    }
  })

  it('bounds spawn failures at three attempts and records relaunch-failed', { timeout: 60_000 }, async () => {
    // A relaunch exec that cannot exist: every spawn attempt fails at 'error'
    // before any process is created, which is the ONLY case retrying is safe.
    const rig = await startRidge({ relaunchExec: join(tmpdir(), 'dsh-power-no-such-binary') })
    try {
      await commitAndExitOld(rig)
      const done = await waitFor(() => {
        const s = readStatus(rig.statusFile)
        return s !== null && (s.stage === 'ready' || s.stage === 'failed') ? s : null
      }, 50_000)
      expect(done?.stage).toBe('failed')
      expect((done?.failure as { code?: string } | undefined)?.code).toBe('relaunch-failed')
      // Retried to the cap, never beyond: a 4th spawn attempt would mean an
      // unbounded retry loop.
      expect(done?.attempt).toBe(3)
    } finally {
      killPid(rig.old.pid)
      killPid(rig.helper.pid)
    }
  })

  it('refuses to declare ready when the new process answers with the OLD instanceId', { timeout: 45_000 }, async () => {
    // A spawn that comes up but is NOT a new instance (config replayed into the
    // old identity, wrong target, port squatter) must fail the health gate —
    // and because a process WAS created, the helper must not retry.
    const rig = await startRidge({ relaunchInstance: OLD, readyWaitMs: 2_500 })
    let newPid: number | undefined
    try {
      await commitAndExitOld(rig)
      const done = await waitFor(() => {
        const s = readStatus(rig.statusFile)
        return s !== null && (s.stage === 'ready' || s.stage === 'failed') ? s : null
      }, 30_000)
      expect(done?.stage).toBe('failed')
      expect((done?.failure as { code?: string } | undefined)?.code).toBe('health-timeout')
      expect(done?.attempt).toBe(1)
      newPid = done?.newPid as number
    } finally {
      killPid(rig.old.pid)
      killPid(newPid)
      killPid(rig.helper.pid)
    }
  })

  it('refuses to declare ready when the new process cannot prove its restart identity', { timeout: 45_000 }, async () => {
    // A different instanceId alone is not enough: the answering process must
    // carry THIS restart's identity (consumed via the launch token). A manual
    // boot or a foreign instance on the port fails the gate even though its
    // instanceId differs from the old one.
    const rig = await startRidge({ forgetRestart: true, readyWaitMs: 2_500 })
    let newPid: number | undefined
    try {
      await commitAndExitOld(rig)
      const done = await waitFor(() => {
        const s = readStatus(rig.statusFile)
        return s !== null && (s.stage === 'ready' || s.stage === 'failed') ? s : null
      }, 30_000)
      expect(done?.stage).toBe('failed')
      expect((done?.failure as { code?: string } | undefined)?.code).toBe('health-timeout')
      expect(done?.attempt).toBe(1)
      newPid = done?.newPid as number
    } finally {
      killPid(rig.old.pid)
      killPid(newPid)
      killPid(rig.helper.pid)
    }
  })

  it('names a failed restart-marker write instead of reporting a health timeout', { timeout: 45_000 }, async () => {
    // A marker that cannot be written leaves the successor unable to claim this
    // restart, so readiness fails while the process itself started fine. The
    // failure must say which of the two happened; reporting a health timeout
    // sends the reader looking at a process that is actually healthy.
    const rig = await startRidge({ markerWriteFails: true, readyWaitMs: 2_500 })
    let newPid: number | undefined
    try {
      await commitAndExitOld(rig)
      const done = await waitFor(() => {
        const s = readStatus(rig.statusFile)
        return s !== null && (s.stage === 'ready' || s.stage === 'failed') ? s : null
      }, 30_000)
      expect(done?.stage).toBe('failed')
      const failure = done?.failure as { code?: string, message?: string } | undefined
      expect(failure?.code).toBe('marker-write-failed')
      expect(failure?.message).toContain('marker')
      // The launch still happened: this is a diagnosis change, not a policy one.
      expect(done?.attempt).toBe(1)
      newPid = done?.newPid as number
      // The helper recorded the write failure when it happened, not only at the end.
      expect(readFileSync(join(rig.home, 'helper.log'), 'utf8')).toContain('marker write failed')
    } finally {
      killPid(rig.old.pid)
      killPid(newPid)
      killPid(rig.helper.pid)
    }
  })

  it('records a still-moving session log and proceeds anyway', { timeout: 60_000 }, async () => {
    // The quiescence check exists because a writer can still be draining when
    // the old process exits. This pins the CURRENT policy: the helper records
    // `sessionQuiescent: false` and relaunches regardless. Changing that to a
    // refusal is a product decision, and this case is what makes the change
    // visible instead of silent.
    const rig = await startRidge({ quiescenceWaitMs: 600 })
    let newPid: number | undefined
    const sessionDir = join(rig.home, 'sessions')
    mkdirSync(sessionDir, { recursive: true })
    const sessionLog = join(sessionDir, 'live-session.jsonl')
    let n = 0
    const writer = setInterval(() => {
      // A size change on every tick is what the (size, mtimeMs) stamp compares.
      writeFileSync(sessionLog, JSON.stringify({ seq: n++, pad: 'x'.repeat(2048) }) + '\n', { flag: 'a' })
    }, 80)
    try {
      await commitAndExitOld(rig)
      const done = await waitFor(() => {
        const s = readStatus(rig.statusFile)
        return s !== null && (s.stage === 'ready' || s.stage === 'failed') ? s : null
      }, 30_000)
      expect(done?.sessionQuiescent).toBe(false)
      // Proceeding is the current behaviour, not an accident: the relaunch
      // completed and the marker was written.
      expect(done?.stage).toBe('ready')
      newPid = done?.newPid as number
      expect(readFileSync(join(rig.home, 'helper.log'), 'utf8')).toContain('proceeding anyway')
    } finally {
      clearInterval(writer)
      killPid(rig.old.pid)
      killPid(newPid)
      killPid(rig.helper.pid)
    }
  })

  it('relaunches with the current OS environment, not the launcher snapshot', { timeout: 60_000 }, async () => {
    // A process environment is a snapshot captured when its launcher started, so
    // a variable changed with setx or System Properties AFTER DSH started never
    // reached the relaunched instance: the "new" server came back identical to
    // the old one. The helper re-reads the registry, so the successor must see
    // the registry value even though every process in the chain inherits the
    // stale one. This case is only meaningful on Windows, where that registry is
    // the source of truth; elsewhere the helper deliberately keeps inheritance.
    if (process.platform !== 'win32') return
    const name = `DSH_POWER_ENV_PROBE_${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`
    const stale = 'stale-from-launcher'
    const fresh = `fresh-${randomUUID()}`
    const dumpDir = mkdtempSync(join(tmpdir(), 'dsh-power-env-'))
    const dumpFile = join(dumpDir, 'env.txt')
    execFileSync('reg', ['add', 'HKCU\\Environment', '/v', name, '/t', 'REG_SZ', '/d', fresh, '/f'], { windowsHide: true })
    cleanups.push(() => {
      try {
        execFileSync('reg', ['delete', 'HKCU\\Environment', '/v', name, '/f'], { windowsHide: true })
      } catch { /* already removed */ }
      delete process.env[name]
      rmSync(dumpDir, { recursive: true, force: true })
    })
    // Play the old DSH instance: the value every child in the chain inherits.
    process.env[name] = stale
    const rig = await startRidge({
      targetArgs: ['--dump-env', name, '--dump-env-file', dumpFile],
    })
    let newPid: number | undefined
    try {
      await commitAndExitOld(rig)
      const done = await waitFor(() => {
        const s = readStatus(rig.statusFile)
        return s !== null && (s.stage === 'ready' || s.stage === 'failed') ? s : null
      }, 45_000)
      expect(done?.stage).toBe('ready')
      newPid = done?.newPid as number
      // The successor reports what it actually inherited. Without the registry
      // refresh this reads `stale` — the defect the issue describes.
      const seen = readFileSync(dumpFile, 'utf8')
      expect(seen).toBe(fresh)
      expect(seen).not.toBe(stale)
    } finally {
      killPid(rig.old.pid)
      killPid(newPid)
      killPid(rig.helper.pid)
    }
  })

  it('carries a non-ASCII registry value through unchanged', { timeout: 60_000 }, async () => {
    // reg.exe writes PIPED stdout in the OEM code page, so decoding its bytes as
    // UTF-8 turned a Chinese value into replacement characters. The successor
    // then received a corrupted variable — worse than the stale one this
    // mechanism exists to replace — and the damage is invisible because the
    // relaunch still reports ready.
    if (process.platform !== 'win32') return
    const name = `DSH_POWER_CJK_PROBE_${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`
    const value = 'C:\\测试目录\\中文 路径'
    const dumpDir = mkdtempSync(join(tmpdir(), 'dsh-power-cjk-'))
    const dumpFile = join(dumpDir, 'env.txt')
    execFileSync('reg', ['add', 'HKCU\\Environment', '/v', name, '/t', 'REG_SZ', '/d', value, '/f'],
      { windowsHide: true })
    cleanups.push(() => {
      try {
        execFileSync('reg', ['delete', 'HKCU\\Environment', '/v', name, '/f'], { windowsHide: true })
      } catch { /* already removed */ }
      rmSync(dumpDir, { recursive: true, force: true })
    })
    const rig = await startRidge({ targetArgs: ['--dump-env', name, '--dump-env-file', dumpFile] })
    let newPid: number | undefined
    try {
      await commitAndExitOld(rig)
      const done = await waitFor(() => {
        const s = readStatus(rig.statusFile)
        return s !== null && (s.stage === 'ready' || s.stage === 'failed') ? s : null
      }, 45_000)
      expect(done?.stage).toBe('ready')
      newPid = done?.newPid as number
      expect(readFileSync(dumpFile, 'utf8')).toBe(value)
    } finally {
      killPid(rig.old.pid)
      killPid(newPid)
      killPid(rig.helper.pid)
    }
  })
})
