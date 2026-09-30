import { describe, expect, it } from 'vitest'
import { isTrustedPowerRequest } from '../src/index.ts'

// Regression matrix for the destructive-POST trust fence. This fence is
// self-maintained — `/api/dsh-power-button/*` is longer than the official
// `/api` route, so webServer's longest-prefix matching never routes these
// requests through the official browser-trust fence. The checks below pin
// every rule the fence enforces, so an upstream drift or a careless edit
// fails loudly here instead of opening restart/shutdown to a cross-origin
// page (a no-cors fetch still fires even though its response is unreadable).

function req(address: string | undefined, headers: Record<string, unknown>): { socket: { remoteAddress: string | undefined }, headers: Record<string, unknown> } {
  return { socket: { remoteAddress: address }, headers }
}

const GOOD_HOST = { host: '127.0.0.1:3080' }

describe('trust fence: socket', () => {
  it('allows the three loopback spellings', () => {
    expect(isTrustedPowerRequest(req('127.0.0.1', GOOD_HOST))).toBe(true)
    expect(isTrustedPowerRequest(req('::1', GOOD_HOST))).toBe(true)
    expect(isTrustedPowerRequest(req('::ffff:127.0.0.1', GOOD_HOST))).toBe(true)
  })
  it('denies non-loopback sockets even with a perfect Host', () => {
    expect(isTrustedPowerRequest(req('192.168.1.10', GOOD_HOST))).toBe(false)
    expect(isTrustedPowerRequest(req('10.0.0.5', GOOD_HOST))).toBe(false)
    expect(isTrustedPowerRequest(req('::ffff:192.168.1.10', GOOD_HOST))).toBe(false)
  })
  it('denies a request with no socket address', () => {
    expect(isTrustedPowerRequest(req(undefined, GOOD_HOST))).toBe(false)
  })
})

describe('trust fence: Host header (DNS rebinding)', () => {
  it('allows loopback authorities', () => {
    for (const host of ['localhost:3080', '127.0.0.1:3080', '[::1]:3080', 'localhost']) {
      expect(isTrustedPowerRequest(req('127.0.0.1', { host })), host).toBe(true)
    }
  })
  it('denies a rebound or foreign Host even on a loopback socket', () => {
    for (const host of ['evil.com', 'localhost.evil.com', '127.0.0.1.evil.com', '127.0.0.2:3080', '[::2]:3080']) {
      expect(isTrustedPowerRequest(req('127.0.0.1', { host })), host).toBe(false)
    }
  })
  it('denies a missing or unparseable Host', () => {
    expect(isTrustedPowerRequest(req('127.0.0.1', {}))).toBe(false)
    expect(isTrustedPowerRequest(req('127.0.0.1', { host: 'not a url' }))).toBe(false)
  })
})

describe('trust fence: sec-fetch-site', () => {
  it('denies an explicit cross-site request', () => {
    expect(isTrustedPowerRequest(req('127.0.0.1', { ...GOOD_HOST, 'sec-fetch-site': 'cross-site' }))).toBe(false)
  })
  it('allows same-origin and unknown values', () => {
    expect(isTrustedPowerRequest(req('127.0.0.1', { ...GOOD_HOST, 'sec-fetch-site': 'same-origin' }))).toBe(true)
    expect(isTrustedPowerRequest(req('127.0.0.1', { ...GOOD_HOST, 'sec-fetch-site': 'none' }))).toBe(true)
  })
})

describe('trust fence: Origin', () => {
  it('allows an absent Origin (curl / non-browser callers)', () => {
    expect(isTrustedPowerRequest(req('127.0.0.1', GOOD_HOST))).toBe(true)
  })
  it('allows an Origin equal to the Host authority', () => {
    expect(isTrustedPowerRequest(req('127.0.0.1', { ...GOOD_HOST, origin: 'http://127.0.0.1:3080' }))).toBe(true)
    expect(isTrustedPowerRequest(req('127.0.0.1', { host: 'localhost:3080', origin: 'http://localhost:3080' }))).toBe(true)
  })
  it('denies a cross-origin or foreign-port Origin', () => {
    expect(isTrustedPowerRequest(req('127.0.0.1', { ...GOOD_HOST, origin: 'http://127.0.0.1:9999' }))).toBe(false)
    expect(isTrustedPowerRequest(req('127.0.0.1', { ...GOOD_HOST, origin: 'http://evil.com:3080' }))).toBe(false)
  })
  it('mirrors the official fence: Origin comparison is authority-only, scheme ignored', () => {
    // Deliberate parity with dsh-client-connection's isTrustedApiRequest,
    // which compares `new URL(origin).host === hostUrl.host` — an https
    // Origin on the served authority passes there too (the Host fence has
    // already bound the request to this loopback server, which serves plain
    // HTTP). If upstream ever tightens this, this test is the drift signal.
    expect(isTrustedPowerRequest(req('127.0.0.1', { ...GOOD_HOST, origin: 'https://127.0.0.1:3080' }))).toBe(true)
  })
  it('denies the "null" origin and unparseable values', () => {
    expect(isTrustedPowerRequest(req('127.0.0.1', { ...GOOD_HOST, origin: 'null' }))).toBe(false)
    expect(isTrustedPowerRequest(req('127.0.0.1', { ...GOOD_HOST, origin: 'garbage' }))).toBe(false)
  })
})
