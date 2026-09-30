import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRestartHelper } from '../src/index.ts'

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

function getHealth(port: number): Promise<{ ok?: boolean, instanceId?: string } | null> {
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

/** Shared rig: temp home, a live old-instance target, and a generated helper
 * whose every file lands in the temp dir (never the real ~/.dsh). */
async function startRidge(opts: { relaunchInstance?: string, commitWaitMs?: number, readyWaitMs?: number, relaunchExec?: string, forgetRestart?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-power-e2e-'))
  const port = await freePort()
  const old = spawn(process.execPath, [TARGET, '--port', String(port), '--instance-id', OLD], { stdio: 'ignore' })
  const up = await waitFor(async () => {
    const h = await getHealth(port)
    return h?.instanceId === OLD ? h : null
  }, 10_000)
  if (up === null) throw new Error('fake old target never became healthy')

  const restartId = randomUUID()
  const markerFile = join(home, 'marker.json')
  const statusFile = join(home, 'status.json')
  const helperFile = join(home, 'helper.cjs')
  const commitFile = join(home, 'commit.json')
  const relaunchExec = opts.relaunchExec ?? process.execPath
  const relaunchArgs = [relaunchExec, TARGET, '--port', String(port), '--instance-id', opts.relaunchInstance ?? NEW]
  if (opts.forgetRestart) relaunchArgs.push('--forget-restart')
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
      expect((health?.restart as { restartId?: string } | undefined)?.restartId).toBe(rig.restartId)
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
})
