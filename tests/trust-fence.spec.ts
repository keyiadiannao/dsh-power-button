import { describe, expect, it } from 'vitest'
import { boundHostOf, declaredTrustedHosts, explainPowerRequestTrust, isTrustedPowerRequest } from '../src/index.ts'

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
  it('denies a port-less loopback Origin, which is a known upstream compatibility gap', () => {
    // A page served from http://127.0.0.1:3080 should send
    // `Origin: http://127.0.0.1:3080`; the port is omitted only for a scheme's
    // default port. There are reports of a browser sending the port-less form
    // for a non-default port, which this fence — and the official
    // `isTrustedApiRequest`, which compares the same authority — both refuse.
    //
    // This test pins the CURRENT behaviour on purpose rather than endorsing it.
    // Relaxing a destructive endpoint's Origin check to hostname-only is not a
    // change to make unilaterally: the fence deliberately follows upstream's
    // rule, so the fix belongs there and this test is the signal to sync when
    // it lands. Failing here means someone changed the rule — make that
    // deliberate.
    expect(isTrustedPowerRequest(req('127.0.0.1', { ...GOOD_HOST, 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1' }))).toBe(false)
  })

  it('denies the "null" origin and unparseable values', () => {
    expect(isTrustedPowerRequest(req('127.0.0.1', { ...GOOD_HOST, origin: 'null' }))).toBe(false)
    expect(isTrustedPowerRequest(req('127.0.0.1', { ...GOOD_HOST, origin: 'garbage' }))).toBe(false)
  })
})

describe('trust fence: deliberate divergence from the official loopback set', () => {
  it('accepts only 127.0.0.1, not the whole of 127/8 the official helper accepts', () => {
    // dsh-client-connection's `isLoopbackHostname` accepts any 127/8 address
    // (`127.0.0.2` included). This fence does not. It is strictly narrower, so
    // it cannot admit anything the official fence would refuse — but it means
    // that if DSH ever serves on another 127/8 address, the official /api
    // routes would answer while these endpoints returned 403. Pinned here so
    // that widening it is a visible, deliberate edit.
    for (const host of ['127.0.0.2:3080', '127.1.2.3:3080']) {
      expect(isTrustedPowerRequest(req('127.0.0.1', { host })), host).toBe(false)
    }
  })

  it('refuses a non-loopback authority that the host never declared', () => {
    // With no declaration from the host, a non-loopback authority is refused —
    // and the same request is accepted once the host declares it (see the
    // --trusted-host suite below). Both halves are pinned so the widening is
    // tied to the host's own decision rather than to a blanket relaxation.
    expect(isTrustedPowerRequest(req('127.0.0.1', { host: 'harness.internal:3080' }))).toBe(false)
    expect(isTrustedPowerRequest(req('192.168.1.10', { host: '192.168.1.10:3080' }))).toBe(false)
  })
})

describe('trust fence: a refusal names the rule that refused', () => {
  // The first reported failure of this fence arrived as an issue with an empty
  // body: the caller could see only "forbidden", so there was nothing to
  // report. Each rule now names itself in the 403.
  const reasonOf = (request: Parameters<typeof explainPowerRequestTrust>[0]): string => {
    const verdict = explainPowerRequestTrust(request)
    return verdict.trusted ? 'trusted' : verdict.reason
  }

  it('names the socket rule', () => {
    expect(reasonOf(req('192.168.1.10', GOOD_HOST))).toBe('socket-not-loopback')
    expect(reasonOf(req(undefined, GOOD_HOST))).toBe('socket-not-loopback')
  })

  it('names the Host rules', () => {
    expect(reasonOf(req('127.0.0.1', {}))).toBe('host-missing')
    expect(reasonOf(req('127.0.0.1', { host: 'not a url' }))).toBe('host-unparseable')
    expect(reasonOf(req('127.0.0.1', { host: 'evil.com' }))).toBe('host-untrusted')
    expect(reasonOf(req('127.0.0.1', { host: '127.0.0.2:3080' }))).toBe('host-untrusted')
  })

  it('names the cross-site rule', () => {
    expect(reasonOf(req('127.0.0.1', { ...GOOD_HOST, 'sec-fetch-site': 'cross-site' }))).toBe('cross-site')
  })

  it('names the Origin rules', () => {
    expect(reasonOf(req('127.0.0.1', { ...GOOD_HOST, origin: 'null' }))).toBe('origin-null')
    expect(reasonOf(req('127.0.0.1', { ...GOOD_HOST, origin: 'garbage' }))).toBe('origin-mismatch')
    expect(reasonOf(req('127.0.0.1', { ...GOOD_HOST, origin: 'http://127.0.0.1:9999' }))).toBe('origin-mismatch')
    // The reported browser behaviour: Host has a port, Origin does not.
    expect(reasonOf(req('127.0.0.1', { ...GOOD_HOST, origin: 'http://127.0.0.1' }))).toBe('origin-mismatch')
  })

  it('reports trust, not a reason, when every rule passes', () => {
    expect(explainPowerRequestTrust(req('127.0.0.1', { ...GOOD_HOST, origin: 'http://127.0.0.1:3080' })))
      .toEqual({ trusted: true })
    expect(explainPowerRequestTrust(req('::1', { host: 'localhost:3080', 'sec-fetch-site': 'same-origin' })))
      .toEqual({ trusted: true })
  })
})

describe('trust fence: authorities the host declared with --trusted-host', () => {
  // DSH accepts an operator-declared authority for its own /api fence, so a
  // deployment it serves over a LAN works there and used to return 403 here.
  // These read the host's own list rather than a second policy beside it.
  const LAN = { host: '192.168.1.5:3080' }

  it('accepts a declared authority arriving over a non-loopback socket', () => {
    // A declared LAN authority is reached from off-box by definition, so the
    // loopback-socket rule cannot apply to it.
    expect(explainPowerRequestTrust(req('192.168.1.10', LAN), ['192.168.1.5']))
      .toEqual({ trusted: true })
    expect(explainPowerRequestTrust(req('192.168.1.10', { ...LAN, origin: 'http://192.168.1.5:3080' }), ['192.168.1.5']))
      .toEqual({ trusted: true })
  })

  it('still refuses an authority the host never declared', () => {
    // The rebinding defense is unchanged: the Host must be one we serve, and
    // only the operator decides which those are.
    expect(explainPowerRequestTrust(req('127.0.0.1', { host: 'evil.com:3080' }), ['192.168.1.5']))
      .toEqual({ trusted: false, reason: 'host-untrusted' })
    expect(explainPowerRequestTrust(req('192.168.1.10', { host: '10.0.0.9:3080' }), ['192.168.1.5']))
      .toEqual({ trusted: false, reason: 'host-untrusted' })
  })

  it('keeps the loopback-socket rule for loopback authorities', () => {
    // Declaring an unrelated authority must not license a loopback Host
    // arriving from elsewhere.
    expect(explainPowerRequestTrust(req('192.168.1.10', GOOD_HOST), ['192.168.1.5']))
      .toEqual({ trusted: false, reason: 'socket-not-loopback' })
  })

  it('matches a port-less entry on any port and a ported entry on that port only', () => {
    expect(explainPowerRequestTrust(req('127.0.0.1', LAN), ['192.168.1.5']))
      .toEqual({ trusted: true })
    expect(explainPowerRequestTrust(req('127.0.0.1', { host: '192.168.1.5:9999' }), ['192.168.1.5:3080']))
      .toEqual({ trusted: false, reason: 'host-untrusted' })
  })

  it('treats an explicit :80 as a port, not as port-less', () => {
    // `new URL` strips http's default port, so `host:80` would look port-less
    // and widen to every port. Judging it under https too is what tells them
    // apart — an explicit :80 must narrow, not widen.
    expect(explainPowerRequestTrust(req('127.0.0.1', { host: 'harness.internal:80' }), ['harness.internal:80']))
      .toEqual({ trusted: true })
    expect(explainPowerRequestTrust(req('127.0.0.1', { host: 'harness.internal:3080' }), ['harness.internal:80']))
      .toEqual({ trusted: false, reason: 'host-untrusted' })
  })

  it('ignores malformed entries instead of trusting them', () => {
    expect(explainPowerRequestTrust(req('192.168.1.10', LAN), ['not a url']))
      .toEqual({ trusted: false, reason: 'host-untrusted' })
  })
})

describe('declaredTrustedHosts', () => {
  it('reads the host\u2019s own startup values', () => {
    expect(declaredTrustedHosts({ get: (n: string) => (n === 'webStartup' ? { trustedHosts: ['a.internal', '10.0.0.9'] } : undefined) }))
      .toEqual(['a.internal', '10.0.0.9'])
  })

  it('yields nothing when the profile provides no webStartup service', () => {
    // A profile without the web bundle must not block or widen this plugin.
    expect(declaredTrustedHosts({ get: () => undefined })).toEqual([])
    expect(declaredTrustedHosts({})).toEqual([])
    expect(declaredTrustedHosts({ get: () => ({ trustedHosts: 'nope' }) })).toEqual([])
  })
})

describe('trust fence: the socket rule follows what the server is bound to', () => {
  // Bound to 127.0.0.1 the server listens nowhere else, so a non-loopback peer
  // cannot be an off-box client reaching it directly — it is a local forwarding
  // layer (WSL's localhost bridge, a container port map, a tunnel) whose address
  // in this namespace is what arrives. Refusing that broke setups every other
  // DSH route serves. Bound to 0.0.0.0 an off-box peer is real, and there the
  // rule is what stops a forged loopback Host.
  const OFFBOX = req('192.168.1.10', GOOD_HOST)

  it('accepts a non-loopback peer for a loopback Host when bound to 127.0.0.1', () => {
    expect(explainPowerRequestTrust(OFFBOX, [], '127.0.0.1')).toEqual({ trusted: true })
    expect(explainPowerRequestTrust(req('172.17.0.1', { ...GOOD_HOST, origin: 'http://127.0.0.1:3080' }), [], '127.0.0.1'))
      .toEqual({ trusted: true })
  })

  it('still refuses that peer when bound to every interface', () => {
    expect(explainPowerRequestTrust(OFFBOX, [], '0.0.0.0'))
      .toEqual({ trusted: false, reason: 'socket-not-loopback' })
  })

  it('defaults to the exposed binding, so an omitted argument stays strict', () => {
    expect(explainPowerRequestTrust(OFFBOX)).toEqual({ trusted: false, reason: 'socket-not-loopback' })
  })

  it('keeps the Host fence either way', () => {
    // Relaxing the socket rule for a loopback binding must not license a Host we
    // do not serve — the rebinding defense is independent of the binding.
    expect(explainPowerRequestTrust(req('192.168.1.10', { host: 'evil.com:3080' }), [], '127.0.0.1'))
      .toEqual({ trusted: false, reason: 'host-untrusted' })
  })
})

describe('boundHostOf', () => {
  it('reads the host\u2019s own web server binding', () => {
    expect(boundHostOf({ webServer: { host: '127.0.0.1' } })).toBe('127.0.0.1')
    expect(boundHostOf({ webServer: { host: '0.0.0.0' } })).toBe('0.0.0.0')
  })

  it('falls back to the exposed binding when it cannot be read', () => {
    // An unreadable binding must keep the strict rule, not silently relax it.
    expect(boundHostOf({})).toBe('0.0.0.0')
    expect(boundHostOf({ webServer: {} })).toBe('0.0.0.0')
    expect(boundHostOf({ webServer: { host: 'something-else' } })).toBe('0.0.0.0')
  })
})
