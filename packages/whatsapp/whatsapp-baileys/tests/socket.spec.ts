import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WhatsAppChatId, WhatsAppError, WhatsAppMessageId } from '@deepseek-ai/dsh-whatsapp'
import { baileysOpener, loadBaileys } from '@deepseek-ai/dsh-whatsapp-baileys'
import type {
  BaileysConnectionUpdate,
  BaileysMessage,
  BaileysModule,
  BaileysSocket,
  SocketEvent,
  WhatsAppSocket,
} from '@deepseek-ai/dsh-whatsapp-baileys'

const LOGGED_OUT = 401

const chatId = WhatsAppChatId('5511999990000@s.whatsapp.net')
const groupId = WhatsAppChatId('120363000000000000@g.us')

/** A scripted Baileys socket whose streams the test drives. */
interface FakeSocket extends BaileysSocket {
  emitConnection(update: BaileysConnectionUpdate): void
  emitCreds(): void
  emitMessages(messages: readonly BaileysMessage[]): void
  readonly sent: { jid: string; text: string; quoted: BaileysMessage | undefined }[]
  readonly read: readonly BaileysMessage['key'][][]
  ended: boolean
}

/** Build the scripted socket plus the module surface that returns it. */
function makeModule(options: {
  ack?: BaileysMessage | undefined
  user?: { id: string } | undefined
  saveCreds?: () => Promise<void>
} = {}): { module: BaileysModule; socket: FakeSocket } {
  const connectionListeners: ((update: BaileysConnectionUpdate) => void)[] = []
  const credsListeners: (() => void)[] = []
  const messageListeners: ((batch: { messages: readonly BaileysMessage[] }) => void)[] = []
  const sent: { jid: string; text: string; quoted: BaileysMessage | undefined }[] = []
  const read: BaileysMessage['key'][][] = []

  const socket: FakeSocket = {
    user: 'user' in options ? options.user : { id: '5511888880000:1@s.whatsapp.net' },
    ev: {
      on: (event: string, listener: (payload: never) => void) => {
        if (event === 'connection.update') connectionListeners.push(listener as (u: BaileysConnectionUpdate) => void)
        if (event === 'creds.update') credsListeners.push(listener as () => void)
        if (event === 'messages.upsert') {
          messageListeners.push(listener as (b: { messages: readonly BaileysMessage[] }) => void)
        }
      },
    },
    sendMessage: (jid, content, opts) => {
      sent.push({ jid, text: content.text, quoted: opts?.quoted })
      return Promise.resolve('ack' in options ? options.ack : { key: { id: 'SENT1' }, messageTimestamp: 1_700_000_100 })
    },
    readMessages: (keys) => {
      read.push([...keys])
      return Promise.resolve()
    },
    end: () => {
      socket.ended = true
    },
    emitConnection: (update) => { connectionListeners.forEach((listener) => { listener(update) }) },
    emitCreds: () => { credsListeners.forEach((listener) => { listener() }) },
    emitMessages: (messages) => { messageListeners.forEach((listener) => { listener({ messages }) }) },
    sent,
    read,
    ended: false,
  }

  return {
    socket,
    module: {
      default: () => socket,
      useMultiFileAuthState: () =>
        Promise.resolve({ state: {}, saveCreds: options.saveCreds ?? (() => Promise.resolve()) }),
      DisconnectReason: { loggedOut: LOGGED_OUT },
    },
  }
}

/** Open a bound socket over the scripted module and capture its observations. */
async function open(
  moduleOptions: Parameters<typeof makeModule>[0] = {},
): Promise<{ socket: FakeSocket; port: WhatsAppSocket; events: SocketEvent[] }> {
  const { module, socket } = makeModule(moduleOptions)
  const events: SocketEvent[] = []
  const port = await baileysOpener(
    { moduleSpecifier: 'baileys', authDir: '/tmp/auth', browser: ['DSH', 'Chrome', '1.0.0'] },
    () => Promise.resolve(module),
  )(event => events.push(event))
  return { socket, port, events }
}

/** One inbound text message. */
function inbound(overrides: Partial<BaileysMessage> = {}): BaileysMessage {
  return {
    key: { id: 'M1', remoteJid: chatId },
    message: { conversation: 'oi' },
    messageTimestamp: 1_700_000_000,
    pushName: 'Ana',
    ...overrides,
  }
}

describe('module loading', () => {
  it('reports an absent library as a deployment failure naming the specifier', async () => {
    const opener = baileysOpener(
      { moduleSpecifier: 'baileys', authDir: '/tmp/auth', browser: ['DSH', 'Chrome', '1.0.0'] },
      () => Promise.reject(new Error('Cannot find package')),
    )
    await expect(opener(() => {})).rejects.toMatchObject({ code: 'WHATSAPP_BAILEYS_MISSING' })
    await expect(opener(() => {})).rejects.toThrow(/"baileys" is not installed/)
  })

  it('resolves the specifier through a dynamic import by default', async () => {
    await expect(loadBaileys('./no-such-whatsapp-library.js')).rejects.toThrow()
  })

  it('passes the configured auth directory and device identity to the library', async () => {
    const { module } = makeModule()
    const useMultiFileAuthState = vi.spyOn(module, 'useMultiFileAuthState')
    const makeSocket = vi.spyOn(module, 'default')
    await baileysOpener(
      { moduleSpecifier: 'baileys', authDir: '/var/dsh/auth', browser: ['Console', 'Chrome', '2.0.0'] },
      () => Promise.resolve(module),
    )(() => {})
    expect(useMultiFileAuthState).toHaveBeenCalledWith('/var/dsh/auth')
    expect(makeSocket.mock.calls[0]?.[0]).toMatchObject({
      browser: ['Console', 'Chrome', '2.0.0'],
      syncFullHistory: false,
    })
  })
})

describe('stored pairing', () => {
  /** Open over a real directory so the credential file is read from disk. */
  async function openOver(creds: string | undefined): Promise<void> {
    const authDir = await mkdtemp(join(tmpdir(), 'dsh-whatsapp-'))
    try {
      if (creds !== undefined) await writeFile(join(authDir, 'creds.json'), creds)
      const { module } = makeModule()
      await baileysOpener(
        { moduleSpecifier: 'baileys', authDir, browser: ['DSH', 'Chrome', '1.0.0'] },
        () => Promise.resolve(module),
      )(() => {})
    } finally {
      await rm(authDir, { recursive: true, force: true })
    }
  }

  it('refuses to connect on a truncated credential file rather than linking a new device', async () => {
    await expect(openOver('')).rejects.toMatchObject({ code: 'WHATSAPP_AUTH_STATE_DAMAGED' })
    await expect(openOver('{"noiseKey":')).rejects.toThrow(/are damaged/)
  })

  it('connects over an intact credential file', async () => {
    await expect(openOver('{"me":{"id":"5511888880000:1@s.whatsapp.net"}}')).resolves.toBeUndefined()
  })

  it('connects when the directory holds no credentials yet', async () => {
    await expect(openOver(undefined)).resolves.toBeUndefined()
  })
})

describe('connection stream', () => {
  it('reports connecting, pairing, and the connected account', async () => {
    const { socket, events } = await open()
    socket.emitConnection({ connection: 'connecting' })
    socket.emitConnection({ qr: 'QR-1' })
    socket.emitConnection({ connection: 'open' })
    expect(events).toEqual([
      { kind: 'connecting' },
      { kind: 'pairing', qr: 'QR-1' },
      { kind: 'open', accountId: '5511888880000:1@s.whatsapp.net' },
    ])
  })

  it('names the account unknown when the library reports none', async () => {
    const { socket, events } = await open({ user: undefined })
    socket.emitConnection({ connection: 'open' })
    expect(events).toEqual([{ kind: 'open', accountId: 'unknown' }])
  })

  it('distinguishes a logged-out close from a transient one', async () => {
    const { socket, events } = await open()
    socket.emitConnection({ connection: 'close', lastDisconnect: { error: { output: { statusCode: LOGGED_OUT } } } })
    socket.emitConnection({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 503 } } } })
    socket.emitConnection({ connection: 'close' })
    expect(events).toEqual([
      { kind: 'closed', loggedOut: true, reason: 'connection closed with status 401' },
      { kind: 'closed', loggedOut: false, reason: 'connection closed with status 503' },
      { kind: 'closed', loggedOut: false, reason: 'connection closed' },
    ])
  })

  it('persists credentials whenever the library rotates them', async () => {
    const saveCreds = vi.fn(() => Promise.resolve())
    const { socket } = await open({ saveCreds })
    socket.emitCreds()
    expect(saveCreds).toHaveBeenCalledOnce()
  })
})

describe('message normalization', () => {
  it('normalizes a direct text message', async () => {
    const { socket, events } = await open()
    socket.emitMessages([inbound()])
    expect(events).toEqual([{
      kind: 'message',
      message: {
        id: WhatsAppMessageId('M1'),
        chatId,
        chatKind: 'direct',
        chatName: 'Ana',
        senderId: chatId,
        senderName: 'Ana',
        fromMe: false,
        timestamp: '2023-11-14T22:13:20.000Z',
        content: { kind: 'text', text: 'oi' },
      },
    }])
  })

  it('does not name a conversation after the account itself', async () => {
    const { socket, events } = await open()
    socket.emitMessages([inbound({ key: { id: 'M0', remoteJid: chatId, fromMe: true } })])
    expect(events[0]).toMatchObject({ message: { senderName: 'Ana', fromMe: true } })
    expect(events[0]).not.toHaveProperty('message.chatName')
  })

  it('attributes a group message to its participant', async () => {
    const { socket, events } = await open()
    socket.emitMessages([inbound({
      key: { id: 'M2', remoteJid: groupId, participant: '5511777770000@s.whatsapp.net', fromMe: true },
      message: { extendedTextMessage: { text: 'bom dia' } },
      pushName: null,
    })])
    expect(events[0]).toMatchObject({
      message: {
        chatKind: 'group',
        senderId: '5511777770000@s.whatsapp.net',
        fromMe: true,
        content: { kind: 'text', text: 'bom dia' },
      },
    })
    expect(events[0]).not.toHaveProperty('message.senderName')
  })

  it('classifies an address space it does not recognize as a direct conversation', async () => {
    const { socket, events } = await open()
    socket.emitMessages([inbound({ key: { id: 'M9', remoteJid: '94257503293551@lid' } })])
    expect(events[0]).toMatchObject({ message: { chatKind: 'direct', chatId: '94257503293551@lid' } })
  })

  it('reports media it cannot represent instead of dropping the message', async () => {
    const { socket, events } = await open()
    socket.emitMessages([
      inbound({ key: { id: 'M3', remoteJid: chatId }, message: { imageMessage: {} } as Exclude<BaileysMessage['message'], undefined> }),
    ])
    expect(events.map(event => event.kind === 'message' ? event.message.content : undefined)).toEqual([
      { kind: 'unsupported', mediaType: 'imageMessage' },
    ])
  })

  it('names the payload, not the delivery metadata decoded before it', async () => {
    const { socket, events } = await open()
    socket.emitMessages([
      inbound({
        key: { id: 'M7', remoteJid: groupId, participant: '5511777770000@s.whatsapp.net' },
        message: { senderKeyDistributionMessage: {}, imageMessage: {} } as Exclude<BaileysMessage['message'], undefined>,
      }),
      inbound({
        key: { id: 'M8', remoteJid: chatId },
        message: { messageContextInfo: {}, conversation: 'oi' } as Exclude<BaileysMessage['message'], undefined>,
      }),
    ])
    expect(events.map(event => event.kind === 'message' ? event.message.content : undefined)).toEqual([
      { kind: 'unsupported', mediaType: 'imageMessage' },
      { kind: 'text', text: 'oi' },
    ])
  })

  it('drops an envelope that holds only metadata or protocol housekeeping', async () => {
    const { socket, events } = await open()
    socket.emitMessages([
      inbound({ key: { id: 'M9', remoteJid: chatId }, message: {} }),
      inbound({ key: { id: 'M10', remoteJid: chatId }, message: { protocolMessage: {} } as Exclude<BaileysMessage['message'], undefined> }),
      inbound({ key: { id: 'M11', remoteJid: chatId }, message: { messageContextInfo: {} } as Exclude<BaileysMessage['message'], undefined> }),
    ])
    expect(events).toEqual([])
  })

  it('skips entries that carry no address or no body', async () => {
    const { socket, events } = await open()
    socket.emitMessages([
      inbound({ key: { id: null, remoteJid: chatId } }),
      inbound({ key: { id: 'M5', remoteJid: null } }),
      inbound({ key: { id: 'M6', remoteJid: chatId }, message: null }),
    ])
    expect(events).toEqual([])
  })

  it('reads a protobuf timestamp and falls back to the epoch when absent', async () => {
    const { socket, events } = await open()
    socket.emitMessages([
      inbound({ key: { id: 'M7', remoteJid: chatId }, messageTimestamp: { toNumber: () => 1_700_000_500 } }),
      inbound({ key: { id: 'M8', remoteJid: chatId }, messageTimestamp: null }),
    ])
    expect(events.map(event => event.kind === 'message' ? event.message.timestamp : undefined)).toEqual([
      '2023-11-14T22:21:40.000Z',
      '1970-01-01T00:00:00.000Z',
    ])
  })
})

describe('sending', () => {
  it('returns the acknowledged identity and send time', async () => {
    const { port, socket } = await open()
    await expect(port.sendText({ chatId, text: 'olá' })).resolves.toEqual({
      id: WhatsAppMessageId('SENT1'),
      chatId,
      timestamp: '2023-11-14T22:15:00.000Z',
    })
    expect(socket.sent).toEqual([{ jid: chatId, text: 'olá', quoted: undefined }])
  })

  it('quotes a message this connection observed, body included', async () => {
    const { port, socket } = await open()
    socket.emitMessages([inbound()])
    await port.sendText({ chatId, text: 'claro', quotedMessageId: WhatsAppMessageId('M1') })
    // Baileys reads the quoted message's own body to build the reply context,
    // so a quote carrying only the key crashes inside the library.
    expect(socket.sent[0]?.quoted).toMatchObject({ key: { id: 'M1' }, message: { conversation: 'oi' } })
  })

  it('refuses to quote a message it never observed', async () => {
    const { port } = await open()
    await expect(port.sendText({ chatId, text: 'claro', quotedMessageId: WhatsAppMessageId('GONE') }))
      .rejects.toMatchObject({ code: 'WHATSAPP_UNKNOWN_MESSAGE' })
  })

  it('rejects an acknowledgement without a message id', async () => {
    for (const ack of [undefined, { key: { id: null } }] as const) {
      const { port } = await open({ ack })
      await expect(port.sendText({ chatId, text: 'oi' }))
        .rejects.toMatchObject({ code: 'WHATSAPP_SEND_UNACKNOWLEDGED' })
    }
  })
})

describe('read receipts and teardown', () => {
  it('marks the chat read at its newest observed message', async () => {
    const { port, socket } = await open()
    socket.emitMessages([inbound(), inbound({ key: { id: 'M9', remoteJid: chatId } })])
    await port.markRead(chatId)
    expect(socket.read).toEqual([[{ id: 'M9', remoteJid: chatId }]])
  })

  it('refuses to mark a chat it has never observed', async () => {
    const { port } = await open()
    await expect(port.markRead(chatId)).rejects.toBeInstanceOf(WhatsAppError)
    await expect(port.markRead(chatId)).rejects.toMatchObject({ code: 'WHATSAPP_UNKNOWN_CHAT' })
  })

  it('closes the underlying connection', async () => {
    const { port, socket } = await open()
    await port.close()
    expect(socket.ended).toBe(true)
  })
})
