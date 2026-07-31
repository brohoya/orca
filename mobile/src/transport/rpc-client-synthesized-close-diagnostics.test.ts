// Why: RN can swallow onclose for a wedged iOS transport, so the client synthesizes the close.
// These cover the diagnostic clocks that synthesis has to keep honest, and prove synthesis
// never costs us the auth-failed latch when the real close lands late.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'

vi.mock('./e2ee', () => ({
  generateKeyPair: () => ({
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(32)
  }),
  deriveSharedKey: () => new Uint8Array(32),
  publicKeyFromBase64: () => new Uint8Array(32),
  publicKeyToBase64: () => 'client-public-key',
  encrypt: (plaintext: string) => `encrypted:${plaintext}`,
  decrypt: (raw: string) => raw.replace(/^encrypted:/, ''),
  decryptBytes: (bytes: Uint8Array) => bytes
}))

// Why: close() deliberately never fires onclose — that is the wedged-transport bug being modelled.
class WedgedWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readonly CONNECTING = WedgedWebSocket.CONNECTING
  readonly OPEN = WedgedWebSocket.OPEN
  readonly CLOSING = WedgedWebSocket.CLOSING
  readonly CLOSED = WedgedWebSocket.CLOSED

  readyState = WedgedWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: ((event?: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  close = vi.fn(() => {
    this.readyState = WedgedWebSocket.CLOSED
  })

  constructor(readonly endpoint: string) {
    sockets.push(this)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  open(): void {
    this.readyState = WedgedWebSocket.OPEN
    this.onopen?.()
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: payload })
  }

  // Why: the close event the native layer eventually coughs up, possibly long after we gave up.
  deliverClose(code: number, reason = ''): void {
    this.readyState = WedgedWebSocket.CLOSED
    this.onclose?.({ code, reason, wasClean: true })
  }
}

const sockets: WedgedWebSocket[] = []
const originalWebSocket = globalThis.WebSocket

function lastSocket(): WedgedWebSocket {
  return sockets[sockets.length - 1]!
}

function openConnectionLogs(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls
    .filter((call) => call[0] === '[net] openConnection')
    .map((call) => call[1] as Record<string, unknown>)
}

describe('synthesized close diagnostics', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    sockets.length = 0
    globalThis.WebSocket = WedgedWebSocket as unknown as typeof WebSocket
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    vi.useRealTimers()
    globalThis.WebSocket = originalWebSocket
  })

  it('records the close clock when a handshake timeout synthesizes the close', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    lastSocket().open()

    // 5s handshake budget elapses with no e2ee_ready — the client closes and synthesizes onclose.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(client.getState()).toBe('reconnecting')

    // 500ms is the first reconnect delay; the redial log must date the close it just made.
    await vi.advanceTimersByTimeAsync(500)
    expect(sockets).toHaveLength(2)

    const redial = openConnectionLogs(logSpy)[1]
    expect(redial?.msSinceLastClose).toBe(500)

    client.close()
  })

  it('keeps the replacement socket clock when the swallowed close arrives late', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const wedged = lastSocket()
    wedged.open()

    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(500)
    expect(sockets).toHaveLength(2)

    // The native layer finally reports the dead socket's close, 200ms into the replacement's life.
    await vi.advanceTimersByTimeAsync(200)
    wedged.deliverClose(1006)

    // The replacement's own close must still be able to date itself against its open.
    await vi.advanceTimersByTimeAsync(300)
    lastSocket().deliverClose(1006)
    const closeLog = logSpy.mock.calls.findLast((call) => call[0] === '[net] ws.onclose')?.[1] as
      | Record<string, unknown>
      | undefined
    expect(closeLog?.constructToCloseMs).toBe(500)

    client.close()
  })

  it('still latches auth-failed when a real 4001 lands after a synthesized close', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const wedged = lastSocket()
    wedged.open()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(client.getState()).toBe('reconnecting')

    // The revoked-device close finally surfaces, after synthesis already gave up on this socket.
    wedged.deliverClose(4001, 'Unauthorized')

    for (let i = 0; i < 3; i++) {
      const previous = lastSocket()
      await vi.advanceTimersByTimeAsync(2_500)
      expect(lastSocket()).not.toBe(previous)
      const socket = lastSocket()
      expect(socket.readyState).toBe(WedgedWebSocket.CONNECTING)
      socket.open()
      socket.receive(JSON.stringify({ type: 'e2ee_ready' }))
      socket.deliverClose(4001, 'Unauthorized')
    }

    expect(client.getState()).toBe('auth-failed')

    // A latched client must stay latched and stop redialling.
    const dialCount = sockets.length
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(sockets).toHaveLength(dialCount)
    expect(client.getState()).toBe('auth-failed')

    client.close()
  })
})
