/**
 * Connection lifecycle and observed-conversation index for the Baileys
 * provider. Everything here runs over the {@link WhatsAppSocket} port, so the
 * status machine, reconnection policy, and normalization are pinned without a
 * WhatsApp account.
 * @module @deepseek-ai/dsh-whatsapp-baileys/src/provider
 */

import { assertNever } from '@deepseek-ai/dsh-llm'
import { WhatsAppError } from '@deepseek-ai/dsh-whatsapp'
import type {
  WhatsAppChat,
  WhatsAppChatId,
  WhatsAppHistoryRequest,
  WhatsAppMessage,
  WhatsAppProvider,
  WhatsAppSendRequest,
  WhatsAppSentMessage,
  WhatsAppStatus,
} from '@deepseek-ai/dsh-whatsapp'
import { sameStatus } from './status.ts'
import { chatKindOf } from './socket.ts'
import type { SocketEvent, WhatsAppSocket, WhatsAppSocketOpener } from './socket.ts'

/** Deployment-varying behavior of one provider instance. */
export interface BaileysProviderConfig {
  /** Milliseconds to wait before reopening a connection that closed unexpectedly. */
  readonly reconnectDelay: number
  /** Consecutive reopen attempts before the provider gives up until it is reloaded. */
  readonly maxReconnectAttempts: number
  /** Messages retained per conversation for `fetchMessages`. */
  readonly historyPerChat: number
}

/** Collaborators the provider is composed with. */
export interface BaileysProviderDeps {
  /** Opens one connection; the composition seam that keeps `baileys` out of this module. */
  readonly open: WhatsAppSocketOpener
  /** Publishes one status transition. */
  readonly onStatus: (status: WhatsAppStatus) => void
  /** Publishes one observed message. */
  readonly onMessage: (message: WhatsAppMessage) => void
  /** Reports a failure that ends the provider's usability. */
  readonly onFatal: (error: unknown) => void
  /** Schedules `callback` after `delay` milliseconds; the return value cancels it. */
  readonly setTimer: (callback: () => void, delay: number) => () => void
  readonly config: BaileysProviderConfig
}

/** One conversation as reconstructed from the messages this connection observed. */
interface ChatRecord {
  readonly messages: WhatsAppMessage[]
  readonly seen: Set<string>
  chat: WhatsAppChat
  /** Timestamp of the newest observed message, for ordering `listChats`. */
  newest: string
}

/**
 * WhatsApp provider backed by one Baileys connection.
 *
 * Baileys ships no message store, so this provider answers `listChats` and
 * `fetchMessages` from what its own connection has observed since it loaded:
 * both are empty right after a restart and grow as messages arrive. Retaining
 * more than that would mean owning a durable message database, which the seam
 * deliberately leaves to consumers that log what reaches a model.
 */
export class BaileysProvider implements WhatsAppProvider {
  readonly id = 'baileys'

  private state: WhatsAppStatus = { state: 'offline' }
  private socket: WhatsAppSocket | undefined
  private cancelTimer: (() => void) | undefined
  private attempts = 0
  private terminal = false
  private disposed = false
  private readonly chats = new Map<string, ChatRecord>()

  constructor(private readonly deps: BaileysProviderDeps) {}

  /**
   * Open the connection and keep it open until {@link dispose}. Resolves once
   * the first attempt settles; later reconnections run on the provider's timer.
   */
  async start(): Promise<void> {
    await this.connect()
  }

  /** Close the connection, cancel any pending reconnection, and stop reporting. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.cancelTimer?.()
    this.cancelTimer = undefined
    const socket = this.socket
    this.socket = undefined
    this.setStatus({ state: 'offline' })
    await socket?.close()
  }

  available(): boolean {
    return !this.terminal && !this.disposed
  }

  status(): WhatsAppStatus {
    return this.state
  }

  listChats(signal?: AbortSignal): Promise<readonly WhatsAppChat[]> {
    signal?.throwIfAborted()
    const chats = [...this.chats.values()].sort((left, right) => right.newest.localeCompare(left.newest))
    return Promise.resolve(chats.map(record => record.chat))
  }

  resolveChat(chatId: WhatsAppChatId, signal?: AbortSignal): Promise<WhatsAppChat> {
    signal?.throwIfAborted()
    const record = this.chats.get(chatId)
    if (record !== undefined) return Promise.resolve(record.chat)
    const [user, domain] = chatId.split('@')
    if (user === undefined || user === '' || domain === undefined || domain === '') {
      throw new WhatsAppError(
        `"${chatId}" names no WhatsApp conversation; an address is a user and a domain, such as <number>@s.whatsapp.net`,
        'WHATSAPP_UNKNOWN_CHAT',
      )
    }
    return Promise.resolve({ id: chatId, kind: chatKindOf(chatId), unreadCount: 0 })
  }

  fetchMessages(request: WhatsAppHistoryRequest, signal?: AbortSignal): Promise<readonly WhatsAppMessage[]> {
    signal?.throwIfAborted()
    const record = this.chats.get(request.chatId)
    if (record === undefined) {
      throw new WhatsAppError(
        `chat "${request.chatId}" has not been observed by this connection`,
        'WHATSAPP_UNKNOWN_CHAT',
      )
    }
    const newestFirst = [...record.messages].reverse()
    const from = request.before === undefined ? 0 : indexAfter(newestFirst, request.before)
    return Promise.resolve(newestFirst.slice(from, from + (request.limit ?? this.deps.config.historyPerChat)))
  }

  async send(request: WhatsAppSendRequest, signal?: AbortSignal): Promise<WhatsAppSentMessage> {
    signal?.throwIfAborted()
    return await this.requireOnline().sendText(request)
  }

  async markRead(chatId: WhatsAppChatId, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    await this.requireOnline().markRead(chatId)
  }

  /** The open socket, or the failure explaining why there is none. */
  private requireOnline(): WhatsAppSocket {
    if (this.socket === undefined || this.state.state !== 'online') {
      throw new WhatsAppError(
        `the WhatsApp account is not connected (state: ${this.state.state})`,
        'WHATSAPP_NOT_ONLINE',
      )
    }
    return this.socket
  }

  /** Open one connection, routing a start failure through the retry policy. */
  private async connect(): Promise<void> {
    if (this.disposed) return
    this.setStatus({ state: 'connecting' })
    try {
      this.socket = await this.deps.open((event) => { this.handle(event) })
    } catch (cause) {
      this.setStatus({ state: 'offline' })
      // A connection that cannot even be opened is either a missing peer,
      // which no retry can install, or unreachable infrastructure, which the
      // reconnection policy already bounds.
      if (cause instanceof WhatsAppError && cause.code === 'WHATSAPP_BAILEYS_MISSING') {
        this.fail(cause)
        return
      }
      this.retry(cause)
    }
  }

  /** Route one socket observation. */
  private handle(event: SocketEvent): void {
    if (this.disposed) return
    switch (event.kind) {
      case 'connecting':
        this.setStatus({ state: 'connecting' })
        return
      case 'pairing':
        this.setStatus({ state: 'pairing', qr: event.qr })
        return
      case 'open':
        this.attempts = 0
        this.setStatus({ state: 'online', accountId: event.accountId })
        return
      case 'closed':
        this.socket = undefined
        if (event.loggedOut) {
          this.terminal = true
          this.setStatus({ state: 'logged-out', reason: event.reason })
          return
        }
        this.setStatus({ state: 'offline' })
        this.retry(new WhatsAppError(event.reason, 'WHATSAPP_CONNECTION_CLOSED'))
        return
      case 'message':
        this.record(event.message)
        this.deps.onMessage(event.message)
        return
      default:
        assertNever(event)
    }
  }

  /** Schedule the next attempt, or give up once the budget is spent. */
  private retry(cause: unknown): void {
    if (this.attempts >= this.deps.config.maxReconnectAttempts) {
      this.fail(
        new WhatsAppError(
          `giving up after ${String(this.attempts)} reconnection attempts`,
          'WHATSAPP_RECONNECT_EXHAUSTED',
          { cause },
        ),
      )
      return
    }
    this.attempts += 1
    this.cancelTimer = this.deps.setTimer(() => void this.connect(), this.deps.config.reconnectDelay)
  }

  /** Stop attempting and report the failure that ended this provider's usability. */
  private fail(error: unknown): void {
    this.terminal = true
    this.deps.onFatal(error)
  }

  /** Index one observed message, dropping a repeat of an id already retained. */
  private record(message: WhatsAppMessage): void {
    const existing = this.chats.get(message.chatId)
    const record = existing ?? {
      messages: [],
      seen: new Set<string>(),
      chat: {
        id: message.chatId,
        kind: message.chatKind,
        ...message.chatName === undefined ? {} : { name: message.chatName },
        unreadCount: 0,
      },
      newest: message.timestamp,
    }
    this.chats.set(message.chatId, record)
    if (record.seen.has(message.id)) return
    record.seen.add(message.id)
    record.messages.push(message)
    if (message.timestamp > record.newest) record.newest = message.timestamp
    if (record.messages.length > this.deps.config.historyPerChat) {
      // The bound is exceeded by exactly one message, so this evicts one.
      for (const evicted of record.messages.splice(0, 1)) record.seen.delete(evicted.id)
    }
    record.chat = {
      ...record.chat,
      unreadCount: message.fromMe ? 0 : record.chat.unreadCount + 1,
    }
  }

  /** Publish a transition, collapsing a repeat of the state already reported. */
  private setStatus(status: WhatsAppStatus): void {
    if (sameStatus(this.state, status)) return
    this.state = status
    this.deps.onStatus(status)
  }
}

/**
 * Position just past `before` in a newest-first page.
 * @param messages - the chat's messages, newest first.
 * @param before - the message the caller has already read.
 * @returns the index to start from; an id this connection never observed pages
 * from the newest message, because there is no older position to resume at.
 */
function indexAfter(messages: readonly WhatsAppMessage[], before: string): number {
  const index = messages.findIndex(message => message.id === before)
  return index === -1 ? 0 : index + 1
}
