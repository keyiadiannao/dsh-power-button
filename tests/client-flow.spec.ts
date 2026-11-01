import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  beginPower, dismissPower, getRestartError, getRestartPhase,
} from '../src/client/index.ts'
import { RESTART_FLOW_WAIT_MS } from '../src/protocol.ts'

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
})
