import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

let apply: typeof import('../src/index.ts').apply
let Config: typeof import('../src/index.ts').Config

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => { throw new Error('unexpected helper launch') }),
}))

const testHome = process.env.DSH_HOME as string
const electronVersion = Object.getOwnPropertyDescriptor(process.versions, 'electron')
const connectedDescriptor = Object.getOwnPropertyDescriptor(process, 'connected')
const sendDescriptor = Object.getOwnPropertyDescriptor(process, 'send')

/** Replace process.send without fighting its exact optional typing. */
function stubSend(implementation: (message: Message, callback: (error: Error | null) => void) => boolean): void {
  Object.defineProperty(process, 'send', { configurable: true, writable: true, value: implementation })
}

type Message = { type?: string, restartId?: string }

function mount(send: (message: Message, callback: (error: Error | null) => void) => boolean) {
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  const ctx = {
    effect: (setup: () => unknown) => setup(),
    on: () => () => {},
    get: (name: string) => name === 'appExit' ? vi.fn() : undefined,
    settings: { get: () => ({ preference: 'en' }) },
    sessions: { list: () => [] },
    agents: { list: () => [] },
    webServer: {
      register: (route: { handler: typeof handler }) => {
        handler = route.handler
        return () => {}
      },
    },
    tools: { register: () => () => {} },
    commands: { register: () => () => {} },
  }
  apply(ctx, Config({ enableModelTool: false, maxDelayMs: 5_000, restartWakeMode: 'quiet' }))

  const exchange = async (method: string, path: string) => {
    let status = 0
    let body: Record<string, unknown> = {}
    const socket = new Socket()
    const request = new IncomingMessage(socket)
    request.method = method
    request.url = path
    request.headers = { host: '127.0.0.1:3080' }
    Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' })
    const response = new ServerResponse(request)
    vi.spyOn(response, 'writeHead').mockImplementation((code: number) => { status = code; return response })
    vi.spyOn(response, 'end').mockImplementation((text?: unknown) => {
      if (typeof text === 'string') body = JSON.parse(text) as Record<string, unknown>
      return response
    })
    vi.spyOn(response, 'once').mockReturnValue(response)
    try {
      await handler(request, response)
    } finally {
      socket.destroy()
    }
    return { status, body }
  }
  return {
    post: (action: string) => exchange('POST', `/api/dsh-power-button/${action}`),
    get: (path: string) => exchange('GET', `/api/dsh-power-button/${path}`),
    sent: [] as Message[],
    sendImpl: send,
  }
}

const clearMarkers = (): void => {
  for (const name of readdirSync(testHome)) {
    if (/^dsh-power-marker-.*\.json$/u.test(name)) rmSync(join(testHome, name), { force: true })
  }
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
  vi.stubEnv('DSH_DESKTOP_RESTART_PROTOCOL', '1')
  Object.defineProperty(process.versions, 'electron', { configurable: true, value: '44.7.0' })
  Object.defineProperty(process, 'connected', { configurable: true, value: true })
  const plugin = await import('../src/index.ts')
  apply = plugin.apply
  Config = plugin.Config
  clearMarkers()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  if (sendDescriptor === undefined) delete (process as { send?: unknown }).send
  else Object.defineProperty(process, 'send', sendDescriptor)
  if (connectedDescriptor === undefined) delete (process as { connected?: boolean }).connected
  else Object.defineProperty(process, 'connected', connectedDescriptor)
  if (electronVersion === undefined) delete process.versions.electron
  else Object.defineProperty(process.versions, 'electron', electronVersion)
  clearMarkers()
})

describe('Desktop hand-over', () => {
  const acceptingSend = (sent: Message[]) => (message: Message, callback: (error: Error | null) => void) => {
    sent.push(message)
    callback(null)
    return true
  }

  it('asks the shell to restart instead of spawning a helper', async () => {
    const sent: Message[] = []
    stubSend(acceptingSend(sent))
    const app = mount(acceptingSend(sent))

    const response = await app.post('restart')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ ok: true, action: 'restart' })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.type).toBe('desktop-restart-requested')
    expect(sent[0]?.restartId).toBe(response.body.restartId)
    const { spawn } = await import('node:child_process')
    expect(spawn).not.toHaveBeenCalled()
    // The successor only proves itself through the marker this process wrote.
    expect(readdirSync(testHome).some((name) => /^dsh-power-marker-.*\.json$/u.test(name))).toBe(true)
  })

  it('releases the transition when the shell never takes over', async () => {
    const sent: Message[] = []
    stubSend(acceptingSend(sent))
    const app = mount(acceptingSend(sent))

    expect((await app.post('restart')).status).toBe(200)
    // The shell owns the relaunch, so this process is still alive and the transition is
    // legitimately held while the hand-over is in flight.
    expect((await app.post('restart')).status).toBe(409)

    await vi.advanceTimersByTimeAsync(20_001)

    const health = await app.get('health')
    expect(health.body.powerFailure).toBe('the desktop shell accepted the restart request but did not take over')
    // Without the release above, every later power request would answer 409 for the rest
    // of this process's life.
    expect((await app.post('restart')).status).toBe(200)
  })

  it('fails and releases the transition when the IPC send rejects', async () => {
    const rejectingSend = (message: Message, callback: (error: Error | null) => void) => {
      callback(new Error('channel closed'))
      return false
    }
    stubSend(rejectingSend)
    const app = mount(rejectingSend)

    const failed = await app.post('restart')
    expect(failed.status).toBe(500)
    expect(failed.body).toMatchObject({ ok: false })
    // Nothing was handed over, so nothing may stay locked.
    expect((await app.post('restart')).status).not.toBe(409)
  })
})
