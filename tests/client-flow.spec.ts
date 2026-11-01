import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginPower, dismissPower, getRestartError, getRestartPhase,
} from '../src/client/index.ts'
import { BROWSER_REQUEST_WAIT_MS, RESTART_FLOW_WAIT_MS, SHUTDOWN_FLOW_WAIT_MS } from '../src/protocol.ts'

function reply(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

beforeEach(() => {
  vi.useFakeTimers()
  dismissPower()
})

afterEach(() => {
  dismissPower()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('power operation polling', () => {
  it('still observes a successor that takes longer than ninety seconds to boot', async () => {
    const started = Date.now()
    const reload = vi.fn()
    let requested = false
    vi.stubGlobal('window', { location: { reload } })
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        requested = true
        return reply({ ok: true })
      }
      if (!requested) return reply({ instanceId: 'old' })
      if (Date.now() - started < 120_000) throw new Error('successor starting')
      return reply({ instanceId: 'new' })
    }))
    beginPower('restart')
    await vi.advanceTimersByTimeAsync(121_500)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(getRestartPhase()).toBe('recovering')
  })

  it.each(['restart', 'shutdown'] as const)('keeps a rejected %s error after subsequent health failures', async (action) => {
    let requested = false
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        requested = true
        return reply({ ok: false, error: 'Permission denied' }, 403)
      }
      if (!requested) return reply({ instanceId: 'old' })
      throw new Error('health unavailable')
    }))
    beginPower(action)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(getRestartPhase()).toBe('error')
    expect(getRestartError()).toBe('Permission denied')
  })

  it('stops polling after the complete restart budget expires', async () => {
    let requested = false
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        requested = true
        return reply({ ok: true })
      }
      if (!requested) return reply({ instanceId: 'old' })
      throw new Error('successor unavailable')
    })
    vi.stubGlobal('fetch', fetch)
    beginPower('restart')
    await vi.advanceTimersByTimeAsync(RESTART_FLOW_WAIT_MS + 1_000)
    expect(getRestartPhase()).toBe('error')
    const calls = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fetch).toHaveBeenCalledTimes(calls)
  })

  it('ignores a shutdown poll that finishes after the operation was dismissed', async () => {
    const pollCompletions: ((response: Response) => void)[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return reply({ ok: true })
      return new Promise<Response>((resolve) => { pollCompletions.push(resolve) })
    }))
    beginPower('shutdown')
    await vi.advanceTimersByTimeAsync(1_500)
    dismissPower()
    for (const finishPoll of pollCompletions) finishPoll(reply({}, 503))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(getRestartPhase()).toBe('idle')
  })

  it.each(['fetch', 'body'] as const)('bounds a stalled initial health %s and still sends the restart', async (stall) => {
    let requested = false
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { requested = true; return reply({ ok: true, restartId: 'r1' }) }
      if (requested) return reply({ instanceId: 'new', restart: { restartId: 'r1' } })
      if (stall === 'fetch') return new Promise<Response>(() => {})
      return { ok: true, status: 200, json: () => new Promise(() => {}) } as Response
    })
    const reload = vi.fn()
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('window', { location: { reload } })
    beginPower('restart')
    await vi.advanceTimersByTimeAsync(BROWSER_REQUEST_WAIT_MS + 3_000)
    expect(requested).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('bounds the whole restart when health requests never settle', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return reply({ ok: true, restartId: 'r1' })
      return new Promise<Response>(() => {})
    })
    vi.stubGlobal('fetch', fetch)
    beginPower('restart')
    await vi.advanceTimersByTimeAsync(RESTART_FLOW_WAIT_MS + 1)
    expect(getRestartPhase()).toBe('error')
    const calls = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(BROWSER_REQUEST_WAIT_MS * 2)
    expect(fetch).toHaveBeenCalledTimes(calls)
  })

  it.each(['hung response', 'http error', 'missing acknowledgement'] as const)(
    'does not report shutdown when health has %s', async (scenario) => {
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          if (scenario === 'missing acknowledgement') return new Promise<Response>(() => {})
          return reply({ ok: true })
        }
        if (scenario === 'hung response') return new Promise<Response>(() => {})
        if (scenario === 'http error') return reply({}, 503)
        throw new Error('connection refused')
      }))
      beginPower('shutdown')
      await vi.advanceTimersByTimeAsync(SHUTDOWN_FLOW_WAIT_MS + 1)
      expect(getRestartPhase()).toBe('error')
    },
  )

  it('reports shutdown only after acknowledgement and repeated connection failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return reply({ ok: true })
      throw new Error('connection refused')
    }))
    beginPower('shutdown')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(getRestartPhase()).toBe('off')
  })

  it('requires the acknowledged restart ID when the new host answers', async () => {
    let requested = false
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { requested = true; return reply({ ok: true, restartId: 'expected' }) }
      return requested ? reply({ instanceId: 'new', restart: { restartId: 'different' } }) : reply({ instanceId: 'old' })
    }))
    beginPower('restart')
    await vi.advanceTimersByTimeAsync(RESTART_FLOW_WAIT_MS + 1)
    expect(getRestartPhase()).toBe('error')
  })
})
