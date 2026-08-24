import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WhatsAppRuntime, {
  OUTBOUND_ECHO_RECALL,
  WhatsAppChatId,
  WhatsAppError,
  WhatsAppMessageId,
  type WhatsAppChat,
  type WhatsAppMessage,
  type WhatsAppProvider,
  type WhatsAppSentMessage,
  type WhatsAppStatus,
} from '@deepseek-ai/dsh-whatsapp'

const chatId = WhatsAppChatId('5511999990000@s.whatsapp.net')
const messageId = WhatsAppMessageId('ABCD1234')

const online: WhatsAppStatus = { state: 'online', accountId: '5511888880000' }

function chat(): WhatsAppChat {
  return { id: chatId, kind: 'direct', name: 'Ana', unreadCount: 2 }
}

function message(): WhatsAppMessage {
  return {
    id: messageId,
    chatId,
    chatKind: 'direct',
    senderId: chatId,
    fromMe: false,
    timestamp: '2026-08-21T10:00:00.000Z',
    content: { kind: 'text', text: 'oi' },
  }
}

function sent(): WhatsAppSentMessage {
  return { id: messageId, chatId, timestamp: '2026-08-21T10:00:01.000Z' }
}

/** A scripted provider whose reported state the test controls per call. */
function makeProvider(overrides: Partial<WhatsAppProvider> = {}): WhatsAppProvider {
  return {
    id: 'scripted',
    available: () => true,
    status: () => online,
    listChats: () => Promise.resolve([chat()]),
    fetchMessages: () => Promise.resolve([message()]),
    send: () => Promise.resolve(sent()),
    markRead: () => Promise.resolve(),
    resolveChat: (chatId: WhatsAppChatId) => Promise.resolve({ id: chatId, kind: 'direct' as const, unreadCount: 0 }),
    ...overrides,
  }
}

/** Mount the seam on a fresh root context. */
async function mount(): Promise<{ ctx: Context; whatsapp: WhatsAppRuntime }> {
  const ctx = new Context()
  await ctx.plugin(WhatsAppRuntime)
  return { ctx, whatsapp: ctx.whatsapp }
}

describe('WhatsAppRuntime registration', () => {
  it('serves the registered provider and stops after the disposer runs', async () => {
    const { whatsapp } = await mount()

    const dispose = whatsapp.register(makeProvider())
    await expect(whatsapp.listChats()).resolves.toEqual([chat()])

    dispose()
    await expect(whatsapp.listChats()).rejects.toThrow(
      expect.objectContaining({ code: 'WHATSAPP_PROVIDER_UNAVAILABLE' }),
    )
  })

  it('rejects a second registration because one registration owns one account', async () => {
    const { whatsapp } = await mount()
    whatsapp.register(makeProvider())

    expect(() => whatsapp.register(makeProvider({ id: 'other' })))
      .toThrow(expect.objectContaining({ code: 'WHATSAPP_PROVIDER_ALREADY_REGISTERED' }))
  })

  it('registers again after the first registration is disposed', async () => {
    const { whatsapp } = await mount()
    whatsapp.register(makeProvider())()

    expect(() => whatsapp.register(makeProvider({ id: 'second' }))).not.toThrow()
  })
})

describe('WhatsAppRuntime status', () => {
  it('reports offline while no provider is registered', async () => {
    const { whatsapp } = await mount()
    expect(whatsapp.status()).toEqual({ state: 'offline' })
  })

  it('reports the registered provider state', async () => {
    const { whatsapp } = await mount()
    whatsapp.register(makeProvider({ status: () => ({ state: 'pairing', qr: 'QR-PAYLOAD' }) }))

    expect(whatsapp.status()).toEqual({ state: 'pairing', qr: 'QR-PAYLOAD' })
  })
})

describe('WhatsAppRuntime operations', () => {
  it('rejects every operation while the account is not online', async () => {
    const { whatsapp } = await mount()
    whatsapp.register(makeProvider({ status: () => ({ state: 'logged-out', reason: 'device removed' }) }))
    const notOnline = expect.objectContaining({ code: 'WHATSAPP_NOT_ONLINE' }) as Error

    await expect(whatsapp.listChats()).rejects.toThrow(notOnline)
    await expect(whatsapp.fetchMessages({ chatId })).rejects.toThrow(notOnline)
    await expect(whatsapp.send({ chatId, text: 'oi' })).rejects.toThrow(notOnline)
    await expect(whatsapp.markRead(chatId)).rejects.toThrow(notOnline)
    await expect(whatsapp.resolveChat(chatId)).rejects.toThrow(notOnline)
  })

  it('forwards the cancellation signal and paging cursor to the provider', async () => {
    const { whatsapp } = await mount()
    const fetchMessages = vi.fn(() => Promise.resolve([message()]))
    whatsapp.register(makeProvider({ fetchMessages }))
    const controller = new AbortController()

    await whatsapp.fetchMessages({ chatId, limit: 10, before: messageId }, controller.signal)

    expect(fetchMessages).toHaveBeenCalledWith({ chatId, limit: 10, before: messageId }, controller.signal)
  })

  it.each([0, -1, 1.5])('rejects the non-positive-integer history limit %s', async (limit) => {
    const { whatsapp } = await mount()
    whatsapp.register(makeProvider())

    await expect(whatsapp.fetchMessages({ chatId, limit })).rejects.toThrow(
      expect.objectContaining({ code: 'WHATSAPP_INVALID_LIMIT' }),
    )
  })

  it('marks a chat read through the provider', async () => {
    const { whatsapp } = await mount()
    const markRead = vi.fn(() => Promise.resolve())
    whatsapp.register(makeProvider({ markRead }))

    await whatsapp.markRead(chatId)

    expect(markRead).toHaveBeenCalledWith(chatId, undefined)
  })

  it('resolves a conversation address through the provider', async () => {
    const { whatsapp } = await mount()
    const resolveChat = vi.fn((id: WhatsAppChatId) => Promise.resolve({ id, kind: 'group' as const, unreadCount: 3 }))
    whatsapp.register(makeProvider({ resolveChat }))

    await expect(whatsapp.resolveChat(chatId)).resolves.toEqual({ id: chatId, kind: 'group', unreadCount: 3 })
    expect(resolveChat).toHaveBeenCalledWith(chatId, undefined)
  })
})

describe('WhatsAppRuntime send', () => {
  it('announces an acknowledged send on whatsapp/message-sent', async () => {
    const { ctx, whatsapp } = await mount()
    whatsapp.register(makeProvider())
    const observed: WhatsAppSentMessage[] = []
    ctx.on('whatsapp/message-sent', acknowledged => void observed.push(acknowledged))

    await expect(whatsapp.send({ chatId, text: 'oi' })).resolves.toEqual(sent())

    expect(observed).toEqual([sent()])
  })

  it('announces nothing when the provider rejects the send', async () => {
    const { ctx, whatsapp } = await mount()
    whatsapp.register(makeProvider({
      send: () => Promise.reject(new WhatsAppError('rate limited', 'WHATSAPP_RATE_LIMITED')),
    }))
    const observed: WhatsAppSentMessage[] = []
    ctx.on('whatsapp/message-sent', acknowledged => void observed.push(acknowledged))

    await expect(whatsapp.send({ chatId, text: 'oi' })).rejects.toThrow(
      expect.objectContaining({ code: 'WHATSAPP_RATE_LIMITED' }),
    )

    expect(observed).toEqual([])
  })

  it.each(['', '   '])('rejects the blank message body %j before reaching the provider', async (text) => {
    const { whatsapp } = await mount()
    const send = vi.fn(() => Promise.resolve(sent()))
    whatsapp.register(makeProvider({ send }))

    await expect(whatsapp.send({ chatId, text })).rejects.toThrow(
      expect.objectContaining({ code: 'WHATSAPP_EMPTY_MESSAGE' }),
    )
    expect(send).not.toHaveBeenCalled()
  })
})

describe('WhatsAppRuntime own-echo claims', () => {
  /** An observed message as a provider republishes the account's own traffic. */
  function echo(text: string, overrides: Partial<WhatsAppMessage> = {}): WhatsAppMessage {
    return { ...message(), fromMe: true, content: { kind: 'text', text }, ...overrides }
  }

  it('claims the echo of a dispatched send once, then treats an identical body as the account writing', async () => {
    const { whatsapp } = await mount()
    whatsapp.register(makeProvider())

    await whatsapp.send({ chatId, text: 'combinado' })

    expect(whatsapp.claimOwnEcho(echo('combinado'))).toBe(true)
    expect(whatsapp.claimOwnEcho(echo('combinado'))).toBe(false)
  })

  it('claims an echo published before the provider acknowledged the send', async () => {
    const { ctx, whatsapp } = await mount()
    const claimed: boolean[] = []
    whatsapp.register(makeProvider({
      send: () => {
        // A provider republishes its own traffic from inside the dispatch, so
        // the record has to exist before this point.
        claimed.push(ctx.whatsapp.claimOwnEcho(echo('combinado')))
        return Promise.resolve(sent())
      },
    }))

    await whatsapp.send({ chatId, text: 'combinado' })

    expect(claimed).toEqual([true])
  })

  it('keeps the record when the send rejects, because a send can fail after WhatsApp relayed it', async () => {
    const { whatsapp } = await mount()
    whatsapp.register(makeProvider({
      send: () => Promise.reject(new WhatsAppError('timed out', 'WHATSAPP_TIMEOUT')),
    }))

    await expect(whatsapp.send({ chatId, text: 'combinado' })).rejects.toThrow(WhatsAppError)

    expect(whatsapp.claimOwnEcho(echo('combinado'))).toBe(true)
  })

  it('claims nothing the deployment did not dispatch', async () => {
    const { whatsapp } = await mount()
    whatsapp.register(makeProvider())
    await whatsapp.send({ chatId, text: 'combinado' })
    const otherChat = WhatsAppChatId('12036300000@g.us')

    // The account writing from its phone, a different conversation, and media
    // this seam cannot send are all the account's own traffic, none of it ours.
    expect(whatsapp.claimOwnEcho(echo('bom dia'))).toBe(false)
    expect(whatsapp.claimOwnEcho(echo('combinado', { chatId: otherChat }))).toBe(false)
    expect(whatsapp.claimOwnEcho(echo('combinado', { content: { kind: 'unsupported', mediaType: 'image' } })))
      .toBe(false)
    expect(whatsapp.claimOwnEcho({ ...echo('combinado'), fromMe: false })).toBe(false)
  })

  it('forgets the oldest dispatched send past the recall depth', async () => {
    const { whatsapp } = await mount()
    whatsapp.register(makeProvider())

    await whatsapp.send({ chatId, text: 'oldest' })
    for (let index = 0; index < OUTBOUND_ECHO_RECALL; index += 1) {
      await whatsapp.send({ chatId, text: `filler ${index}` })
    }

    expect(whatsapp.claimOwnEcho(echo('oldest'))).toBe(false)
    expect(whatsapp.claimOwnEcho(echo('filler 0'))).toBe(true)
  })
})

describe('WhatsApp branded ids', () => {
  it('brands raw provider strings without altering them', () => {
    expect(WhatsAppChatId('120363000000000000@g.us')).toBe('120363000000000000@g.us')
    expect(WhatsAppMessageId('3EB0')).toBe('3EB0')
  })
})
