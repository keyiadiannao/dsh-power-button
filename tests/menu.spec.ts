// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RestartButton, type RestartButtonProps } from '../src/client/RestartButton.tsx'
import { en } from '../src/client/locales.ts'
import { apply, beginPower, getRestartPhase } from '../src/client/index.ts'

const t: RestartButtonProps['t'] = (key) => en[key as keyof typeof en] ?? key
let container: HTMLDivElement
let root: Root

function menuButton(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((item) => item.textContent?.includes(text))
  if (!button) throw new Error(`Menu item not found: ${text}`)
  return button
}

async function openMenu(): Promise<void> {
  await act(async () => {
    container.querySelector<HTMLButtonElement>('.dsh-power-button')!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function status(surface: 'web' | 'desktop') {
  return {
    ok: true, pluginVersion: '0.4.24', lifecycle: 'ready', surface,
    capabilities: { restart: surface === 'web', shutdown: surface === 'web' },
    lastRestart: 'unavailable',
  }
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 10, y: 720, top: 720, bottom: 754, left: 10, right: 200, width: 190, height: 34,
    toJSON: () => ({}),
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(RestartButton, { wide: true, t })))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('power menu', () => {
  it('shows Desktop guidance, disables power actions, and skips them with arrow keys', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(status('desktop')))))
    await openMenu()
    expect(menuButton('Refresh interface').disabled).toBe(false)
    expect(menuButton('Restart').disabled).toBe(true)
    expect(menuButton('Shutdown').disabled).toBe(true)
    expect(container.textContent).toContain('Quit the desktop app from its menu or tray')
    expect(container.textContent).toContain('Plugin version: 0.4.24')
    expect(document.activeElement).toBe(menuButton('Refresh interface'))
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(document.activeElement).toBe(menuButton('Refresh interface'))
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(container.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('.dsh-power-button'))
  })

  it('enables Web actions after a valid host response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(status('web')))))
    await openMenu()
    expect(menuButton('Restart').disabled).toBe(false)
    expect(menuButton('Shutdown').disabled).toBe(false)
    expect(menuButton('Refresh interface').title).toContain('without restarting the backend')
  })

  it('disables actions while the Host is already transitioning', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...status('web'), lifecycle: 'restart' }))))
    await openMenu()
    expect(menuButton('Restart').disabled).toBe(true)
    expect(menuButton('Shutdown').disabled).toBe(true)
    expect(container.textContent).toContain('Host status: Restarting')
  })

  it.each(['invalid response', 'network failure'] as const)('fails closed on %s but keeps refresh available', async (failure) => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (failure === 'network failure') throw new Error('offline')
      return new Response(JSON.stringify({ ok: true }))
    }))
    await openMenu()
    expect(menuButton('Refresh interface').disabled).toBe(false)
    expect(menuButton('Restart').disabled).toBe(true)
    expect(menuButton('Shutdown').disabled).toBe(true)
    expect(container.textContent).toContain('Unable to load status')
  })

  it('keeps the menu within a narrow viewport and above the footer', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(status('desktop')))))
    await openMenu()
    const menu = container.querySelector<HTMLElement>('[role="menu"]')!
    expect(menu.style.left).toBe('8px')
    expect(menu.style.bottom).toBe('88px')
    expect(menu.style.maxHeight).toBe('704px')
    expect(menu.style.overflowY).toBe('auto')
  })

  it('ignores a status response from an earlier menu opening', async () => {
    let completeFirst: (response: Response) => void = () => {}
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      if (calls === 1) return new Promise<Response>((resolve) => { completeFirst = resolve })
      return new Response(JSON.stringify(status('desktop')))
    }))
    await openMenu()
    await act(async () => container.querySelector<HTMLButtonElement>('.dsh-power-button')!.click())
    await openMenu()
    await act(async () => { completeFirst(new Response(JSON.stringify(status('web')))) })
    expect(menuButton('Restart').disabled).toBe(true)
    expect(container.textContent).toContain('Quit the desktop app')
  })

  it('cancels a pending power flow when the client plugin is disposed', async () => {
    let cleanup: (() => void) | undefined
    const otherDisposers: (() => void)[] = []
    const ctx = {
      locale: { register: () => () => {}, snapshot: { active: 'en' } },
      slots: { inject: () => {}, register: () => {} },
      effect: (setup: () => (() => void), name: string) => {
        const dispose = setup()
        if (name === 'dsh-power-button: power flow cleanup') cleanup = dispose
        else otherDisposers.push(dispose)
      },
    }
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    apply(ctx as never)
    await act(async () => beginPower('restart'))
    expect(getRestartPhase()).toBe('preparing')
    await act(async () => cleanup?.())
    expect(getRestartPhase()).toBe('idle')
    for (const dispose of otherDisposers) dispose()
  })
})
