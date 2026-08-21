import { describe, expect, it, vi } from 'vitest'
import { WhatsAppChatId, WhatsAppError, WhatsAppMessageId } from '@deepseek-ai/dsh-whatsapp'
import type { WhatsAppMessage, WhatsAppStatus } from '@deepseek-ai/dsh-whatsapp'
import { BaileysProvider } from '@deepseek-ai/dsh-whatsapp-baileys'
import type { SocketEvent, WhatsAppSocket } from '@deepseek-ai/dsh-whatsapp-baileys'

const chatId = WhatsAppChatId('5511999990000@s.whatsapp.net')
const otherId = WhatsAppChatId('120363000000000000@g.us')

/** The scripted rig a test drives the provider through. */
interface Rig {
  readonly provider: BaileysProvider
  readonly statuses: WhatsAppStatus[]
  readonly messages: WhatsAppMessage[]
  readonly fatals: unknown[]
  /** Push one observation into the provider, as a live socket would. */
  emit(event: SocketEvent): void
  /** Run the reconnection timer the provider is waiting on. */
  fireTimer(): void
  readonly pendingTimers: number
  readonly cancelledTimers: number
  readonly opens: number
  readonly socket: { sent: string[]; read: string[]; closed: boolean }
}

/** Build a provider over a scripted socket, with the failure modes a test needs. */
function rig(options: {
  openFails?: () => Error | undefined
  sendFails?: boolean
  maxReconnectAttempts?: number
  historyPerChat?: number
} = {}): Rig {
  const statuses: WhatsAppStatus[] = []
  const messages: WhatsAppMessage[] = []
  const fatals: unknown[] = []
  const timers: (() => void)[] = []
  const socket = { sent: [] as string[], read: [] as string[], closed: false }
  let cancelledTimers = 0
  let opens = 0
  let emit: (event: SocketEvent) => void = () => {}

  const port: WhatsAppSocket = {
    sendText: (request) => {
      if (options.sendFails === true) return Promise.reject(new WhatsAppError('rate limited', 'WHATSAPP_RATE_LIMIT'))
      socket.sent.push(request.text)
      return Promise.resolve({ id: WhatsAppMessageId('SENT'), chatId: request.chatId, timestamp: '2026-01-01T00:00:00.000Z' })
    },
    markRead: (id) => {
      socket.read.push(id)
      return Promise.resolve()
    },
    close: () => {
      socket.closed = true
      return Promise.resolve()
    },
  }

  const provider = new BaileysProvider({
    open: (onEvent) => {
      opens += 1
      emit = onEvent
      const failure = options.openFails?.()
      return failure === undefined ? Promise.resolve(port) : Promise.reject(failure)
    },
    onStatus: status => statuses.push(status),
    onMessage: message => messages.push(message),
    onFatal: error => fatals.push(error),
    setTimer: (callback) => {
      timers.push(callback)
      return () => {
        cancelledTimers += 1
      }
    },
    config: {
      reconnectDelay: 10,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 2,
      historyPerChat: options.historyPerChat ?? 200,
    },
  })

  return {
    provider,
    statuses,
    messages,
    fatals,
    socket,
    emit: (event) => { emit(event) },
    fireTimer: () => timers.shift()?.(),
    get pendingTimers() {
      return timers.length
    },
    get cancelledTimers() {
      return cancelledTimers
    },
    get opens() {
      return opens
    },
  }
}

/** One inbound message, defaulted to a direct text. */
function message(overrides: Partial<WhatsAppMessage> = {}): WhatsAppMessage {
  return {
    id: WhatsAppMessageId('M1'),
    chatId,
    chatKind: 'direct',
    chatName: 'Ana',
    senderId: chatId,
    senderName: 'Ana',
    fromMe: false,
    timestamp: '2026-01-01T10:00:00.000Z',
    content: { kind: 'text', text: 'oi' },
    ...overrides,
  }
}

/** Bring a provider all the way to a usable connection. */
async function online(options: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const scripted = rig(options)
  await scripted.provider.start()
  scripted.emit({ kind: 'open', accountId: '5511888880000' })
  return scripted
}

describe('connection lifecycle', () => {
  it('reports connecting before the account comes online', async () => {
    const scripted = await online()
    expect(scripted.statuses).toEqual([
      { state: 'connecting' },
      { state: 'online', accountId: '5511888880000' },
    ])
    expect(scripted.provider.status()).toEqual({ state: 'online', accountId: '5511888880000' })
    expect(scripted.provider.available()).toBe(true)
  })

  it('publishes the pairing payload every time it rotates', async () => {
    const scripted = rig()
    await scripted.provider.start()
    scripted.emit({ kind: 'pairing', qr: 'QR-1' })
    scripted.emit({ kind: 'pairing', qr: 'QR-1' })
    scripted.emit({ kind: 'pairing', qr: 'QR-2' })
    expect(scripted.statuses.filter(status => status.state === 'pairing')).toEqual([
      { state: 'pairing', qr: 'QR-1' },
      { state: 'pairing', qr: 'QR-2' },
    ])
  })

  it('collapses a transition into the state already reported', async () => {
    const scripted = await online()
    scripted.emit({ kind: 'open', accountId: '5511888880000' })
    scripted.emit({ kind: 'closed', loggedOut: true, reason: 'device removed' })
    scripted.emit({ kind: 'closed', loggedOut: true, reason: 'device removed' })
    expect(scripted.statuses).toEqual([
      { state: 'connecting' },
      { state: 'online', accountId: '5511888880000' },
      { state: 'logged-out', reason: 'device removed' },
    ])
  })

  it('reports the connection attempt the socket announces', async () => {
    const scripted = await online()
    scripted.emit({ kind: 'closed', loggedOut: false, reason: 'stream ended' })
    scripted.emit({ kind: 'connecting' })
    expect(scripted.statuses.at(-1)).toEqual({ state: 'connecting' })
  })

  it('refuses an observation whose kind it does not know', async () => {
    const scripted = await online()
    expect(() => { scripted.emit({ kind: 'unknown' } as unknown as SocketEvent) }).toThrow()
  })

  it('treats a logged-out close as terminal and stops reconnecting', async () => {
    const scripted = await online()
    scripted.emit({ kind: 'closed', loggedOut: true, reason: 'device removed' })
    expect(scripted.provider.status()).toEqual({ state: 'logged-out', reason: 'device removed' })
    expect(scripted.provider.available()).toBe(false)
    expect(scripted.pendingTimers).toBe(0)
  })
})

describe('reconnection', () => {
  it('reopens the connection after an unexpected close', async () => {
    const scripted = await online()
    scripted.emit({ kind: 'closed', loggedOut: false, reason: 'stream ended' })
    expect(scripted.provider.status()).toEqual({ state: 'offline' })
    scripted.fireTimer()
    await vi.waitFor(() => { expect(scripted.opens).toBe(2) })
  })

  it('gives up once the attempt budget is spent, naming the last failure', async () => {
    const scripted = await online({ maxReconnectAttempts: 1 })
    scripted.emit({ kind: 'closed', loggedOut: false, reason: 'stream ended' })
    scripted.fireTimer()
    await vi.waitFor(() => { expect(scripted.opens).toBe(2) })
    scripted.emit({ kind: 'closed', loggedOut: false, reason: 'stream ended again' })
    expect(scripted.fatals).toHaveLength(1)
    expect(scripted.fatals[0]).toMatchObject({ code: 'WHATSAPP_RECONNECT_EXHAUSTED' })
    expect((scripted.fatals[0] as Error).cause).toMatchObject({ code: 'WHATSAPP_CONNECTION_CLOSED' })
    expect(scripted.provider.available()).toBe(false)
  })

  it('resets the budget once a connection succeeds', async () => {
    const scripted = await online({ maxReconnectAttempts: 1 })
    scripted.emit({ kind: 'closed', loggedOut: false, reason: 'first drop' })
    scripted.fireTimer()
    await vi.waitFor(() => { expect(scripted.opens).toBe(2) })
    scripted.emit({ kind: 'open', accountId: '5511888880000' })
    scripted.emit({ kind: 'closed', loggedOut: false, reason: 'second drop' })
    expect(scripted.fatals).toEqual([])
    expect(scripted.pendingTimers).toBe(1)
  })

  it('retries a connection that cannot be opened', async () => {
    const scripted = rig({ openFails: () => new Error('socket refused') })
    await scripted.provider.start()
    expect(scripted.provider.status()).toEqual({ state: 'offline' })
    expect(scripted.pendingTimers).toBe(1)
  })

  it('does not retry a library the deployment never installed', async () => {
    const missing = new WhatsAppError('not installed', 'WHATSAPP_BAILEYS_MISSING')
    const scripted = rig({ openFails: () => missing })
    await scripted.provider.start()
    expect(scripted.fatals).toEqual([missing])
    expect(scripted.pendingTimers).toBe(0)
    expect(scripted.provider.available()).toBe(false)
  })

  it('does not retry damaged credentials, and reports the state whose remedy is pairing again', async () => {
    const damaged = new WhatsAppError('creds.json is damaged', 'WHATSAPP_AUTH_STATE_DAMAGED')
    const scripted = rig({ openFails: () => damaged })
    await scripted.provider.start()
    expect(scripted.fatals).toEqual([damaged])
    expect(scripted.pendingTimers).toBe(0)
    expect(scripted.provider.status()).toEqual({ state: 'logged-out', reason: 'creds.json is damaged' })
    expect(scripted.provider.available()).toBe(false)
  })
})

describe('observed conversations', () => {
  it('indexes chats newest first and counts what the account has not sent', async () => {
    const scripted = await online()
    scripted.emit({ kind: 'message', message: message() })
    scripted.emit({ kind: 'message', message: message({ id: WhatsAppMessageId('M2'), timestamp: '2026-01-01T11:00:00.000Z' }) })
    scripted.emit({ kind: 'message', message: message({
      id: WhatsAppMessageId('M3'),
      chatId: otherId,
      chatKind: 'group',
      timestamp: '2026-01-01T12:00:00.000Z',
    }) })
    await expect(scripted.provider.listChats()).resolves.toEqual([
      { id: otherId, kind: 'group', name: 'Ana', unreadCount: 1 },
      { id: chatId, kind: 'direct', name: 'Ana', unreadCount: 2 },
    ])
    expect(scripted.messages).toHaveLength(3)
  })

  it('clears the unread count when the account answers from another device', async () => {
    const scripted = await online()
    scripted.emit({ kind: 'message', message: message() })
    scripted.emit({ kind: 'message', message: message({ id: WhatsAppMessageId('M2'), fromMe: true }) })
    await expect(scripted.provider.listChats()).resolves.toMatchObject([{ unreadCount: 0 }])
  })

  it('indexes a chat whose name the account has never resolved', async () => {
    const scripted = await online()
    const anonymous = { ...message() }
    delete (anonymous as { chatName?: string }).chatName
    scripted.emit({ kind: 'message', message: anonymous })
    await expect(scripted.provider.listChats()).resolves.toEqual([{ id: chatId, kind: 'direct', unreadCount: 1 }])
  })

  it('retains a repeated id once, so a replayed history does not duplicate it', async () => {
    const scripted = await online()
    scripted.emit({ kind: 'message', message: message() })
    scripted.emit({ kind: 'message', message: message() })
    await expect(scripted.provider.fetchMessages({ chatId })).resolves.toHaveLength(1)
    expect(scripted.messages).toHaveLength(2)
  })

  it('evicts the oldest message once the retention bound is reached', async () => {
    const scripted = await online({ historyPerChat: 2 })
    for (const id of ['M1', 'M2', 'M3']) {
      scripted.emit({ kind: 'message', message: message({ id: WhatsAppMessageId(id) }) })
    }
    await expect(scripted.provider.fetchMessages({ chatId })).resolves.toMatchObject([{ id: 'M3' }, { id: 'M2' }])
  })
})

describe('history', () => {
  /** Three messages in one chat, oldest first. */
  async function seeded(): Promise<Rig> {
    const scripted = await online()
    for (const [index, id] of ['M1', 'M2', 'M3'].entries()) {
      scripted.emit({ kind: 'message', message: message({
        id: WhatsAppMessageId(id),
        timestamp: `2026-01-01T1${String(index)}:00:00.000Z`,
      }) })
    }
    return scripted
  }

  it('returns the newest page first', async () => {
    const scripted = await seeded()
    await expect(scripted.provider.fetchMessages({ chatId, limit: 2 })).resolves.toMatchObject([{ id: 'M3' }, { id: 'M2' }])
  })

  it('pages past a message the caller has already read', async () => {
    const scripted = await seeded()
    await expect(scripted.provider.fetchMessages({ chatId, before: WhatsAppMessageId('M3') }))
      .resolves.toMatchObject([{ id: 'M2' }, { id: 'M1' }])
  })

  it('pages from the newest message when the cursor was never observed', async () => {
    const scripted = await seeded()
    await expect(scripted.provider.fetchMessages({ chatId, before: WhatsAppMessageId('GONE') }))
      .resolves.toHaveLength(3)
  })

  it('reads a chat this connection has never observed as an empty page', async () => {
    const scripted = await online()
    await expect(scripted.provider.fetchMessages({ chatId })).resolves.toStrictEqual([])
  })

  it('refuses to read a value that names no conversation', async () => {
    const scripted = await online()
    expect(() => scripted.provider.fetchMessages({ chatId: WhatsAppChatId('not-an-address') }))
      .toThrow(WhatsAppError)
    expect(() => scripted.provider.fetchMessages({ chatId: WhatsAppChatId('not-an-address') }))
      .toThrow(/names no WhatsApp conversation/)
  })

  it('resolves an observed chat with the name and unread count it recorded', async () => {
    const scripted = await online()
    scripted.emit({ kind: 'message', message: message() })
    await expect(scripted.provider.resolveChat(chatId))
      .resolves.toEqual({ id: chatId, kind: 'direct', name: 'Ana', unreadCount: 1 })
  })

  it('resolves an address it never observed, so a conversation stays addressable', async () => {
    const scripted = await online()
    await expect(scripted.provider.resolveChat(WhatsAppChatId('94257503293551@lid')))
      .resolves.toEqual({ id: '94257503293551@lid', kind: 'direct', unreadCount: 0 })
    await expect(scripted.provider.resolveChat(WhatsAppChatId('120363000000000000@g.us')))
      .resolves.toEqual({ id: '120363000000000000@g.us', kind: 'group', unreadCount: 0 })
  })

  it('refuses a value that names no conversation at all', async () => {
    const scripted = await online()
    for (const bogus of ['ana', '@s.whatsapp.net', '5511999990000@']) {
      expect(() => scripted.provider.resolveChat(WhatsAppChatId(bogus))).toThrow(WhatsAppError)
      expect(() => scripted.provider.resolveChat(WhatsAppChatId(bogus))).toThrow(/names no WhatsApp conversation/)
    }
  })
})

describe('dispatch', () => {
  it('sends and marks read over the open connection', async () => {
    const scripted = await online()
    await scripted.provider.send({ chatId, text: 'olá' })
    await scripted.provider.markRead(chatId)
    expect(scripted.socket.sent).toEqual(['olá'])
    expect(scripted.socket.read).toEqual([chatId])
  })

  it('refuses to dispatch while the account is not connected', async () => {
    const scripted = rig()
    await scripted.provider.start()
    await expect(scripted.provider.send({ chatId, text: 'olá' }))
      .rejects.toMatchObject({ code: 'WHATSAPP_NOT_ONLINE' })
    await expect(scripted.provider.markRead(chatId)).rejects.toThrow(/state: connecting/)
  })

  it('propagates a provider-specific send failure unchanged', async () => {
    const scripted = await online({ sendFails: true })
    await expect(scripted.provider.send({ chatId, text: 'olá' }))
      .rejects.toMatchObject({ code: 'WHATSAPP_RATE_LIMIT' })
  })

  it('honors a cancelled signal on every operation', async () => {
    const scripted = await online()
    const signal = AbortSignal.abort()
    expect(() => scripted.provider.listChats(signal)).toThrow()
    expect(() => scripted.provider.resolveChat(chatId, signal)).toThrow()
    expect(() => scripted.provider.fetchMessages({ chatId }, signal)).toThrow()
    await expect(scripted.provider.send({ chatId, text: 'olá' }, signal)).rejects.toThrow()
    await expect(scripted.provider.markRead(chatId, signal)).rejects.toThrow()
  })
})

describe('teardown', () => {
  it('closes the connection, cancels a pending reconnection, and reports offline', async () => {
    const scripted = await online()
    scripted.emit({ kind: 'closed', loggedOut: false, reason: 'stream ended' })
    await scripted.provider.dispose()
    expect(scripted.socket.closed).toBe(false)
    expect(scripted.cancelledTimers).toBe(1)
    expect(scripted.provider.available()).toBe(false)
    expect(scripted.provider.status()).toEqual({ state: 'offline' })
  })

  it('closes an open connection', async () => {
    const scripted = await online()
    await scripted.provider.dispose()
    expect(scripted.socket.closed).toBe(true)
  })

  it('ignores observations and reconnection that arrive after disposal', async () => {
    const scripted = await online()
    await scripted.provider.dispose()
    scripted.emit({ kind: 'message', message: message() })
    await scripted.provider.start()
    expect(scripted.messages).toEqual([])
    expect(scripted.opens).toBe(1)
  })
})
