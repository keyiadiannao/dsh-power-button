import { BROWSER_REQUEST_WAIT_MS } from '../protocol.ts'

export type JsonRequestResult =
  | { kind: 'response', ok: boolean, status: number, body: unknown }
  | { kind: 'unavailable' | 'timeout' | 'aborted' }

/** Bound both the HTTP request and body parsing, even if either never settles. */
export function requestJson(url: string, init: RequestInit = {}, timeoutMs = BROWSER_REQUEST_WAIT_MS): Promise<JsonRequestResult> {
  return new Promise((resolve) => {
    const controller = new AbortController()
    const parent = init.signal
    let settled = false
    const finish = (result: JsonRequestResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      parent?.removeEventListener('abort', abort)
      resolve(result)
    }
    const abort = (): void => {
      controller.abort()
      finish({ kind: 'aborted' })
    }
    const timer = setTimeout(() => {
      controller.abort()
      finish({ kind: 'timeout' })
    }, timeoutMs)
    if (parent?.aborted) {
      abort()
      return
    }
    parent?.addEventListener('abort', abort, { once: true })
    void Promise.resolve().then(() => fetch(url, { ...init, signal: controller.signal })).then(async (response) => {
      let body: unknown = null
      try { body = await response.json() } catch { /* A non-JSON response still establishes reachability. */ }
      finish({ kind: 'response', ok: response.ok, status: response.status, body })
    }, () => finish({ kind: 'unavailable' }))
  })
}

export function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}
