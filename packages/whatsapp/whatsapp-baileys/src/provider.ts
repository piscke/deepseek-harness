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
  WhatsAppChatKind,
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
  /** Discards the stored pairing, so the next connection asks for a new QR. */
  readonly forgetPairing: () => Promise<void>
  /** Publishes one status transition. */
  readonly onStatus: (status: WhatsAppStatus) => void
  /** Publishes one observed message. */
  readonly onMessage: (message: WhatsAppMessage) => void
  /** Publishes one conversation whose display name became known or changed. */
  readonly onChatNamed: (chatId: WhatsAppChatId, name: string) => void
  /** Reports a group whose subject could not be read; the conversation stays usable but unnamed. */
  readonly onNameFailure: (chatId: WhatsAppChatId, error: unknown) => void
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
  /**
   * Every conversation name this connection knows, including conversations it
   * has observed no message in. Kept apart from {@link chats} so a roster sync
   * names conversations without inventing observed ones: `listChats` answers
   * for what the connection saw, and this only decides what those are called.
   */
  private readonly names = new Map<string, string>()
  /** Group-subject lookups in flight, so a burst of messages asks the account once. */
  private readonly nameLookups = new Map<string, Promise<string | undefined>>()

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

  async resolveChat(chatId: WhatsAppChatId, signal?: AbortSignal): Promise<WhatsAppChat> {
    signal?.throwIfAborted()
    const record = this.chats.get(chatId)
    if (record === undefined) assertAddressable(chatId)
    const kind = record?.chat.kind ?? chatKindOf(chatId)
    // A group's messages carry no subject, so the first resolution of one is
    // what asks the account for it.
    const name = record?.chat.name ?? await this.nameOf(chatId, kind)
    return {
      id: chatId,
      kind,
      ...name === undefined ? {} : { name },
      unreadCount: record?.chat.unreadCount ?? 0,
    }
  }

  fetchMessages(request: WhatsAppHistoryRequest, signal?: AbortSignal): Promise<readonly WhatsAppMessage[]> {
    signal?.throwIfAborted()
    const record = this.chats.get(request.chatId)
    if (record === undefined) {
      // An unobserved address is a conversation with no retained history rather
      // than a bad request; the account can still send to it and mark it read.
      assertAddressable(request.chatId)
      return Promise.resolve([])
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
      const code = cause instanceof WhatsAppError ? cause.code : undefined
      // Damaged credentials are terminal for the same reason WhatsApp's own
      // logout is, so the operator sees the state whose remedy is to pair again
      // rather than an `offline` indistinguishable from a dropped network.
      if (code === 'WHATSAPP_AUTH_STATE_DAMAGED') {
        this.setStatus({ state: 'logged-out', reason: (cause as WhatsAppError).message })
        this.fail(cause)
        return
      }
      this.setStatus({ state: 'offline' })
      if (code === 'WHATSAPP_BAILEYS_MISSING') {
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
        this.setStatus({ state: 'online', ...event.accountId === undefined ? {} : { accountId: event.accountId } })
        return
      case 'closed':
        this.socket = undefined
        if (event.loggedOut) {
          this.setStatus({ state: 'logged-out', reason: event.reason })
          void this.repair(event.reason)
          return
        }
        this.setStatus({ state: 'offline' })
        this.retry(new WhatsAppError(event.reason, 'WHATSAPP_CONNECTION_CLOSED'))
        return
      case 'message':
        this.record(event.message)
        this.deps.onMessage(event.message)
        return
      case 'chat-named':
        this.learnName(event.chatId, event.name)
        return
      default:
        assertNever(event)
    }
  }

  /**
   * Discard the credentials WhatsApp rejected and reopen, so unlinking the
   * device from the phone leads back to a QR instead of to a provider that can
   * only be revived by deleting `authDir` by hand. A logged-out close means the
   * stored identity can never authenticate again, so reopening over it would
   * reproduce the same rejection. The reopen goes through the reconnection
   * budget, which bounds an account that keeps rejecting a fresh pairing.
   * @param reason - the close being recovered from, carried into that budget.
   */
  private async repair(reason: string): Promise<void> {
    try {
      await this.deps.forgetPairing()
    } catch (cause) {
      this.fail(new WhatsAppError(
        `the WhatsApp account was logged out (${reason}) and its credentials could not be discarded, `
        + 'so pairing again needs the auth directory deleted by hand',
        'WHATSAPP_PAIRING_NOT_DISCARDED',
        { cause },
      ))
      return
    }
    if (this.disposed) return
    this.retry(new WhatsAppError(reason, 'WHATSAPP_CONNECTION_CLOSED'))
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
    const known = this.names.get(message.chatId)
    const record = existing ?? {
      messages: [],
      seen: new Set<string>(),
      chat: {
        id: message.chatId,
        kind: message.chatKind,
        ...known === undefined ? {} : { name: known },
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
    this.nameFrom(message)
  }

  /** Take the conversation's name from the message, or ask the account for a group's subject. */
  private nameFrom(message: WhatsAppMessage): void {
    if (message.chatName !== undefined) {
      this.learnName(message.chatId, message.chatName)
      return
    }
    if (message.chatKind !== 'group' || this.names.has(message.chatId)) return
    // Naming must never delay delivering the message that revealed the group:
    // the subject reaches consumers through `chat-named` when the lookup lands.
    void this.fetchGroupSubject(message.chatId)
  }

  /**
   * Retain what one conversation is called and announce a name that changed.
   * @param chatId - the conversation the name belongs to.
   * @param name - the display name this connection resolved.
   */
  private learnName(chatId: WhatsAppChatId, name: string): void {
    if (this.names.get(chatId) === name) return
    this.names.set(chatId, name)
    const record = this.chats.get(chatId)
    if (record !== undefined) record.chat = { ...record.chat, name }
    this.deps.onChatNamed(chatId, name)
  }

  /**
   * The conversation's name: the one this connection knows, or the one only the
   * account can answer for.
   * @param chatId - the conversation to name.
   * @param kind - what that conversation is, since only a group needs a lookup.
   * @returns the display name, or `undefined` while the connection has none.
   */
  private async nameOf(chatId: WhatsAppChatId, kind: WhatsAppChatKind): Promise<string | undefined> {
    const known = this.names.get(chatId)
    if (known !== undefined) return known
    if (kind !== 'group') return undefined
    return await this.fetchGroupSubject(chatId)
  }

  /**
   * Ask the account for one group's subject, collapsing concurrent asks for the
   * same group into the one request in flight.
   *
   * A lookup that fails leaves the group unnamed rather than failing the caller:
   * an unnamed conversation still routes, and the next roster update names it.
   * @param chatId - the group to look up.
   * @returns the subject, or `undefined` when offline or when the lookup failed.
   */
  private fetchGroupSubject(chatId: WhatsAppChatId): Promise<string | undefined> {
    const inflight = this.nameLookups.get(chatId)
    if (inflight !== undefined) return inflight
    const socket = this.socket
    if (socket === undefined || this.state.state !== 'online') return Promise.resolve(undefined)
    const lookup = socket.fetchGroupSubject(chatId).then(
      (name) => {
        if (name !== undefined) this.learnName(chatId, name)
        return name
      },
      (error: unknown) => {
        this.deps.onNameFailure(chatId, error)
        return undefined
      },
    ).finally(() => {
      this.nameLookups.delete(chatId)
    })
    this.nameLookups.set(chatId, lookup)
    return lookup
  }

  /** Publish a transition, collapsing a repeat of the state already reported. */
  private setStatus(status: WhatsAppStatus): void {
    if (sameStatus(this.state, status)) return
    this.state = status
    this.deps.onStatus(status)
  }
}

/**
 * Reject a value that names no conversation at all.
 *
 * Every domain is accepted, because WhatsApp owns that set and extends it; only
 * a value missing a user or a domain is refused, which is the one judgment that
 * does not go stale.
 * @param chatId - the conversation address to check.
 */
function assertAddressable(chatId: WhatsAppChatId): void {
  const [user, domain] = chatId.split('@')
  if (user === undefined || user === '' || domain === undefined || domain === '') {
    throw new WhatsAppError(
      `"${chatId}" names no WhatsApp conversation; an address is a user and a domain, such as <number>@s.whatsapp.net`,
      'WHATSAPP_UNKNOWN_CHAT',
    )
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
