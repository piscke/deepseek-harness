/**
 * The socket port the provider runs on, plus its Baileys binding. The port
 * exists so the connection lifecycle, status machine, and reconnection policy
 * in `provider.ts` are exercised without a WhatsApp account, and so the only
 * code that touches the Baileys module is this one.
 *
 * Baileys is NOT a dependency of this package, in any field. Its transitive
 * `libsignal` is GPL-3.0 and, in the 6.x line, resolves from a git repository,
 * which this repository's supply-chain policy rejects outright. The module is
 * therefore resolved by name at connect time from the deployment's own
 * installation, which is also what makes an operator's install the act that
 * accepts Baileys' license.
 * @module @deepseek-ai/dsh-whatsapp-baileys/src/socket
 */

import { WhatsAppChatId, WhatsAppError, WhatsAppMessageId } from '@deepseek-ai/dsh-whatsapp'
import type {
  WhatsAppChatKind,
  WhatsAppContent,
  WhatsAppMessage,
  WhatsAppSendRequest,
  WhatsAppSentMessage,
} from '@deepseek-ai/dsh-whatsapp'

/** Group conversations are the only ones WhatsApp addresses through this domain. */
const GROUP_JID_SUFFIX = '@g.us'

/** Addressing fields Baileys attaches to every message. */
export interface BaileysKey {
  readonly id?: string | null
  readonly remoteJid?: string | null
  readonly fromMe?: boolean | null
  readonly participant?: string | null
}

/** One message as Baileys reports it. */
export interface BaileysMessage {
  readonly key: BaileysKey
  readonly message?: {
    readonly conversation?: string | null
    readonly extendedTextMessage?: { readonly text?: string | null } | null
  } | null
  /** Seconds since the epoch, as a number or a protobufjs 64-bit integer. */
  readonly messageTimestamp?: number | { toNumber(): number } | null
  readonly pushName?: string | null
}

/** Connection progress as Baileys reports it on `connection.update`. */
export interface BaileysConnectionUpdate {
  readonly connection?: 'close' | 'connecting' | 'open'
  readonly qr?: string
  readonly lastDisconnect?: {
    readonly error?: { readonly output?: { readonly statusCode?: number } } | null
  } | null
}

/** One live Baileys connection. */
export interface BaileysSocket {
  readonly user?: { readonly id: string } | undefined
  readonly ev: {
    on(event: 'connection.update', listener: (update: BaileysConnectionUpdate) => void): void
    on(event: 'creds.update', listener: () => void): void
    on(event: 'messages.upsert', listener: (batch: { readonly messages: readonly BaileysMessage[] }) => void): void
  }
  sendMessage(
    jid: string,
    content: { text: string },
    options?: { quoted: { key: BaileysKey } },
  ): Promise<BaileysMessage | undefined>
  readMessages(keys: readonly BaileysKey[]): Promise<void>
  end(error: Error | undefined): void
}

/**
 * The Baileys module surface this binding calls. Declared here because Baileys
 * is resolved at runtime rather than compiled against; a member that moves
 * upstream surfaces as a load or connect failure, not as a silent no-op.
 */
export interface BaileysModule {
  default(config: {
    auth: unknown
    browser: readonly [string, string, string]
    syncFullHistory: boolean
  }): BaileysSocket
  useMultiFileAuthState(folder: string): Promise<{ state: unknown; saveCreds: () => Promise<void> }>
  readonly DisconnectReason: { readonly loggedOut: number }
}

/**
 * One observation from a live connection, already normalized away from Baileys
 * types. A CLOSED discriminated union: `provider.ts` switches on `kind` ending
 * in `assertNever(...)`.
 */
export type SocketEvent =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'pairing'; readonly qr: string }
  | { readonly kind: 'open'; readonly accountId: string }
  | { readonly kind: 'closed'; readonly loggedOut: boolean; readonly reason: string }
  | { readonly kind: 'message'; readonly message: WhatsAppMessage }

/** One live connection, as the provider uses it. */
export interface WhatsAppSocket {
  /** Send one text message and return the acknowledgement. */
  sendText(request: WhatsAppSendRequest): Promise<WhatsAppSentMessage>
  /** Mark the chat read up to the newest message this socket observed in it. */
  markRead(chatId: WhatsAppChatId): Promise<void>
  /** Close the connection without logging the account out. */
  close(): Promise<void>
}

/**
 * Open one connection and stream its observations to `onEvent`. An opener
 * rejects only when the connection cannot be started at all; a connection that
 * starts and later fails reports `closed` instead.
 */
export type WhatsAppSocketOpener = (onEvent: (event: SocketEvent) => void) => Promise<WhatsAppSocket>

/** Resolves the Baileys module the deployment installed. */
export type BaileysLoader = () => Promise<BaileysModule>

/** How the binding reaches Baileys and where it keeps the paired credentials. */
export interface BaileysSocketOptions {
  /** Module specifier resolved at connect time, normally `baileys`. */
  readonly moduleSpecifier: string
  /** Directory holding the multi-file auth state. */
  readonly authDir: string
  /** Browser identity WhatsApp shows in the linked-devices list. */
  readonly browser: readonly [string, string, string]
}

/**
 * Load the Baileys module the deployment installed.
 * @param specifier - module specifier to resolve.
 * @returns the loaded module.
 */
export async function loadBaileys(specifier: string): Promise<BaileysModule> {
  // Baileys is not a declared dependency, so the compiler cannot type this
  // import; `BaileysModule` states the subset the binding calls.
  return await import(specifier) as BaileysModule
}

/**
 * Build the opener that binds this provider to Baileys.
 * @param options - module specifier, credential directory, and linked-device identity.
 * @param load - resolves the module; defaults to importing `options.moduleSpecifier`.
 * @returns an opener that starts one connection per call.
 */
export function baileysOpener(
  options: BaileysSocketOptions,
  load: BaileysLoader = () => loadBaileys(options.moduleSpecifier),
): WhatsAppSocketOpener {
  return async (onEvent) => {
    const baileys = await loadModule(load, options.moduleSpecifier)
    const { state, saveCreds } = await baileys.useMultiFileAuthState(options.authDir)
    const socket = baileys.default({
      auth: state,
      browser: options.browser,
      syncFullHistory: false,
    })
    return bindSocket(socket, saveCreds, baileys.DisconnectReason.loggedOut, onEvent)
  }
}

/** Load the module, reporting its absence as a deployment failure. */
async function loadModule(load: BaileysLoader, specifier: string): Promise<BaileysModule> {
  try {
    return await load()
  } catch (cause) {
    throw new WhatsAppError(
      `the WhatsApp library "${specifier}" is not installed in this deployment; install it to enable the WhatsApp provider`,
      'WHATSAPP_BAILEYS_MISSING',
      { cause },
    )
  }
}

/** Subscribe to one socket's streams and expose it through the port. */
function bindSocket(
  socket: BaileysSocket,
  saveCreds: () => Promise<void>,
  loggedOutCode: number,
  onEvent: (event: SocketEvent) => void,
): WhatsAppSocket {
  // Baileys exposes no message store, so the binding retains the keys that
  // quoting and read receipts need from the messages it has observed.
  const keyById = new Map<string, BaileysKey>()
  const newestKeyByChat = new Map<string, BaileysKey>()

  socket.ev.on('creds.update', () => void saveCreds())

  socket.ev.on('connection.update', (update) => {
    if (update.qr !== undefined) onEvent({ kind: 'pairing', qr: update.qr })
    if (update.connection === 'connecting') onEvent({ kind: 'connecting' })
    if (update.connection === 'open') onEvent({ kind: 'open', accountId: socket.user?.id ?? 'unknown' })
    if (update.connection === 'close') {
      const statusCode = update.lastDisconnect?.error?.output?.statusCode
      onEvent({
        kind: 'closed',
        loggedOut: statusCode === loggedOutCode,
        reason: statusCode === undefined ? 'connection closed' : `connection closed with status ${String(statusCode)}`,
      })
    }
  })

  socket.ev.on('messages.upsert', (batch) => {
    for (const raw of batch.messages) {
      const message = normalizeMessage(raw)
      if (message === undefined) continue
      keyById.set(message.id, raw.key)
      newestKeyByChat.set(message.chatId, raw.key)
      onEvent({ kind: 'message', message })
    }
  })

  return {
    async sendText(request) {
      const acknowledged = await socket.sendMessage(
        request.chatId,
        { text: request.text },
        ...quotedOptions(request, keyById),
      )
      const id = acknowledged?.key.id
      if (id === null || id === undefined) {
        throw new WhatsAppError('WhatsApp acknowledged the send without a message id', 'WHATSAPP_SEND_UNACKNOWLEDGED')
      }
      return {
        id: WhatsAppMessageId(id),
        chatId: request.chatId,
        timestamp: timestampOf(acknowledged?.messageTimestamp),
      }
    },
    async markRead(chatId) {
      const key = newestKeyByChat.get(chatId)
      if (key === undefined) {
        throw new WhatsAppError(
          `no message of chat "${chatId}" has been observed, so there is nothing to mark read`,
          'WHATSAPP_UNKNOWN_CHAT',
        )
      }
      await socket.readMessages([key])
    },
    close() {
      socket.end(undefined)
      return Promise.resolve()
    },
  }
}

/** Resolve the optional quoted message into `sendMessage` options. */
function quotedOptions(
  request: WhatsAppSendRequest,
  keyById: ReadonlyMap<string, BaileysKey>,
): [] | [{ quoted: { key: BaileysKey } }] {
  const { quotedMessageId } = request
  if (quotedMessageId === undefined) return []
  const key = keyById.get(quotedMessageId)
  if (key === undefined) {
    throw new WhatsAppError(
      `message "${quotedMessageId}" was never observed by this connection, so it cannot be quoted`,
      'WHATSAPP_UNKNOWN_MESSAGE',
    )
  }
  return [{ quoted: { key } }]
}

/**
 * Normalize one raw message, or skip it.
 *
 * A message without an id or a conversation address cannot be addressed,
 * quoted, or deduplicated; a message with no `message` body, and one whose
 * body holds only delivery metadata or protocol housekeeping, carries nothing
 * a person sent. All are dropped rather than published as an entry no consumer
 * can act on.
 * @param raw - one entry of a `messages.upsert` batch.
 * @returns the normalized message, or `undefined` when it is not addressable.
 */
function normalizeMessage(raw: BaileysMessage): WhatsAppMessage | undefined {
  const { id, remoteJid } = raw.key
  if (id === null || id === undefined || remoteJid === null || remoteJid === undefined) return undefined
  const body = raw.message
  if (body === null || body === undefined) return undefined
  const content = contentOf(body)
  if (content === undefined) return undefined
  const chatKind: WhatsAppChatKind = remoteJid.endsWith(GROUP_JID_SUFFIX) ? 'group' : 'direct'
  const pushName = raw.pushName ?? undefined
  // `pushName` is the author's own display name, so it names the conversation
  // only in a direct chat with the other party. A group's subject is not on the
  // message at all, which is why a group chat stays unnamed here.
  const chatName = chatKind === 'direct' && raw.key.fromMe !== true ? pushName : undefined
  return {
    id: WhatsAppMessageId(id),
    chatId: WhatsAppChatId(remoteJid),
    chatKind,
    ...chatName === undefined ? {} : { chatName },
    senderId: raw.key.participant ?? remoteJid,
    ...pushName === undefined ? {} : { senderName: pushName },
    fromMe: raw.key.fromMe === true,
    timestamp: timestampOf(raw.messageTimestamp),
    content,
  }
}

/**
 * Envelope fields that never state what a person sent. `messageContextInfo` and
 * `senderKeyDistributionMessage` ride alongside real content — the latter on
 * most group messages — and can decode before the payload they accompany, so
 * classifying by the first key would report them as the message's type.
 * `protocolMessage` is housekeeping in its own right: history-sync
 * notifications, revocations, and ephemeral-setting changes.
 */
const NON_CONTENT_FIELDS: ReadonlySet<string> = new Set([
  'messageContextInfo',
  'senderKeyDistributionMessage',
  'protocolMessage',
])

/**
 * Classify the message body, naming media this provider cannot represent.
 * @param body - the raw envelope, which may carry metadata beside its content.
 * @returns the content, or `undefined` when the envelope holds nothing a person
 * authored and so is not a message any consumer can answer.
 */
function contentOf(body: NonNullable<BaileysMessage['message']>): WhatsAppContent | undefined {
  const text = body.conversation ?? body.extendedTextMessage?.text
  if (text !== null && text !== undefined) return { kind: 'text', text }
  const [mediaType] = Object.keys(body).filter(field => !NON_CONTENT_FIELDS.has(field))
  if (mediaType === undefined) return undefined
  return { kind: 'unsupported', mediaType }
}

/**
 * Convert a WhatsApp second-resolution timestamp to RFC 3339 UTC.
 * @param timestamp - seconds since the epoch, as a number or protobuf Long.
 * @returns the instant as a four-digit-year RFC 3339 UTC string; an absent
 * timestamp reads as the epoch, which stays ordered before every real message.
 */
function timestampOf(timestamp: BaileysMessage['messageTimestamp']): string {
  if (timestamp === null || timestamp === undefined) return new Date(0).toISOString()
  const seconds = typeof timestamp === 'number' ? timestamp : timestamp.toNumber()
  return new Date(seconds * 1000).toISOString()
}
