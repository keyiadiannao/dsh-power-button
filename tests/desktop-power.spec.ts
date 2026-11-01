import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'

let apply: typeof import('../src/index.ts').apply
let Config: typeof import('../src/index.ts').Config

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => { throw new Error('unexpected helper launch') }),
}))

const electronVersion = Object.getOwnPropertyDescriptor(process.versions, 'electron')

function mount(locale = 'en') {
  let handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  const tools = new Map<string, { execute: (args: object, exec: object) => Promise<unknown> }>()
  const commands = new Map<string, { handler: (invocation: object) => Promise<unknown> }>()
  const exit = vi.fn()
  const ctx = {
    effect: (setup: () => unknown) => setup(),
    on: () => () => {},
    get: (name: string) => name === 'appExit' ? exit : undefined,
    settings: { get: () => ({ preference: locale }) },
    sessions: { list: () => [] },
    agents: { list: () => [] },
    webServer: {
      register: (route: { handler: typeof handler }) => {
        handler = route.handler
        return () => {}
      },
    },
    tools: { register: (spec: { name: string; execute: (args: object, exec: object) => Promise<unknown> }) => { tools.set(spec.name, spec); return () => {} } },
    commands: { register: (spec: { name: string; handler: (invocation: object) => Promise<unknown> }) => { commands.set(spec.name, spec); return () => {} } },
  }
  apply(ctx, Config({ enableModelTool: true, maxDelayMs: 5_000, restartWakeMode: 'quiet' }))
  return {
    tools, commands, exit,
    async post(action: string) {
      let status = 0
      let body: object = {}
      const socket = new Socket()
      const request = new IncomingMessage(socket)
      request.method = 'POST'
      request.url = `/api/dsh-power-button/${action}`
      request.headers = { host: '127.0.0.1:3080' }
      Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' })
      const response = new ServerResponse(request)
      vi.spyOn(response, 'writeHead').mockImplementation((code: number) => { status = code; return response })
      vi.spyOn(response, 'end').mockImplementation((text?: unknown) => {
        if (typeof text === 'string') body = JSON.parse(text)
        return response
      })
      const finish = vi.spyOn(response, 'once').mockReturnValue(response)
      try {
        await handler(request, response)
      } finally {
        socket.destroy()
      }
      return { status, body, finish }
    },
  }
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
  Object.defineProperty(process.versions, 'electron', { configurable: true, value: '44.7.0' })
  const plugin = await import('../src/index.ts')
  apply = plugin.apply
  Config = plugin.Config
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  if (electronVersion === undefined) delete process.versions.electron
  else Object.defineProperty(process.versions, 'electron', electronVersion)
})

describe('Desktop power control', () => {
  it.each(['restart', 'shutdown'])('refuses HTTP %s before launching a helper or scheduling exit', async (action) => {
    const app = mount()
    const response = await app.post(action)
    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({ ok: false, reason: 'desktop-unsupported' })
    expect(response.finish).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(app.exit).not.toHaveBeenCalled()
    const { spawn } = await import('node:child_process')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('also refuses the model tool and slash command', async () => {
    const app = mount()
    expect(await app.tools.get('restart_harness')!.execute({}, {}))
      .toMatchObject({ ok: false, reason: 'desktop-unsupported' })
    expect(await app.commands.get('restart')!.handler({}))
      .toMatchObject({ kind: 'error', text: expect.stringContaining('Desktop') })
    expect(await app.commands.get('shutdown')!.handler({}))
      .toMatchObject({ kind: 'error', text: expect.stringContaining('Desktop') })
    expect(vi.getTimerCount()).toBe(0)
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('does not mistake a standalone Node process for Desktop because of an inherited environment flag', async () => {
    delete process.versions.electron
    const response = await mount().post('restart')
    expect(response.status).toBe(500)
    expect(response.body).toMatchObject({ ok: false, error: 'unexpected helper launch' })
  })

  it('reports the Desktop limitation in the configured host language', async () => {
    const response = await mount('zh').post('restart')
    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({ error: expect.stringContaining('桌面版') })
  })
})
