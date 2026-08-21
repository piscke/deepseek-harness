/**
 * Vocabulary for the WhatsApp capability seam (`ctx.whatsapp`): connection
 * status, chats, messages, the provider interface, and the error taxonomy. A
 * WhatsApp account is one long-lived authenticated connection, so status is
 * part of the capability rather than a per-operation result.
 * @module @deepseek-ai/dsh-whatsapp/src/types
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { WhatsAppChatId, WhatsAppMessageId } from './brand.ts'

/**
 * Whether a conversation addresses one person or a group. Consumers route on
 * this, so a provider that cannot classify a conversation must fail rather than
 * guess.
 */
export type WhatsAppChatKind = 'direct' | 'group'

/**
 * Connection state of the account. A CLOSED discriminated union owned by
 * `dsh-whatsapp`: consumers `switch` on `state` ending in `assertNever(...)`, so
 * a new state breaks compilation at every consumer until handled.
 *
 * `pairing` carries the payload a human must scan or type to authorize the
 * connection; it is short-lived and replaced whenever the provider rotates it,
 * and it is a credential — whoever scans it links a device with full access to
 * the account, so a surface that displays it decides who can see it.
 * `online` names the account, not the device it connected through, and omits
 * the name rather than inventing one when the provider cannot report it.
 * `logged-out` is terminal for the current credentials: the account must pair
 * again, and no reconnection attempt can recover it.
 */
export type WhatsAppStatus =
  | { readonly state: 'offline' }
  | { readonly state: 'connecting' }
  | { readonly state: 'pairing'; readonly qr: string }
  | { readonly state: 'online'; readonly accountId?: string }
  | { readonly state: 'logged-out'; readonly reason: string }

/** One conversation the connected account participates in. */
export interface WhatsAppChat {
  readonly id: WhatsAppChatId
  readonly kind: WhatsAppChatKind
  /** Contact or group display name; absent when the account has never resolved one. */
  readonly name?: string
  /** Messages the account has not marked read, as reported by the provider. */
  readonly unreadCount: number
}

/**
 * The body of one message. A CLOSED discriminated union: a provider reports
 * media it cannot represent as `unsupported` with its media type rather than
 * dropping the message, so a consumer can still see that something arrived and
 * answer accordingly.
 */
export type WhatsAppContent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'unsupported'; readonly mediaType: string }

/** One message observed in a chat, inbound or sent by the connected account. */
export interface WhatsAppMessage {
  readonly id: WhatsAppMessageId
  readonly chatId: WhatsAppChatId
  readonly chatKind: WhatsAppChatKind
  /** Conversation display name; absent when the account has never resolved one. */
  readonly chatName?: string
  /** Author address. Equals `chatId` in a direct chat and the participant in a group. */
  readonly senderId: string
  /** Author display name; absent when the account has never resolved one. */
  readonly senderName?: string
  /** True when the connected account is the author, including its other devices. */
  readonly fromMe: boolean
  /** Provider-reported send time as a four-digit-year RFC 3339 UTC string. */
  readonly timestamp: string
  readonly content: WhatsAppContent
}

/** What the seam is asked to send. Text is the only body a consumer can send. */
export interface WhatsAppSendRequest {
  readonly chatId: WhatsAppChatId
  /** Message body; the seam rejects an empty or whitespace-only value. */
  readonly text: string
  /** Message to quote in the same chat, when the reply should be threaded. */
  readonly quotedMessageId?: WhatsAppMessageId
}

/** Provider acknowledgement of one accepted send. */
export interface WhatsAppSentMessage {
  readonly id: WhatsAppMessageId
  readonly chatId: WhatsAppChatId
  /** Provider-reported send time as a four-digit-year RFC 3339 UTC string. */
  readonly timestamp: string
}

/** A page of one chat's history, newest first. */
export interface WhatsAppHistoryRequest {
  readonly chatId: WhatsAppChatId
  /** Maximum messages to return; the seam rejects a non-positive or fractional value. */
  readonly limit?: number
  /** Return only messages older than this one, for paging past the newest page. */
  readonly before?: WhatsAppMessageId
}

/**
 * One WhatsApp backend. Registered with `ctx.whatsapp.register`; the seam holds
 * at most one, because a registration owns a specific authenticated account.
 *
 * A provider owns its connection lifecycle: it connects while its plugin is
 * loaded, reports progress through `status()` and `whatsapp/status`, and
 * publishes every observed message through `whatsapp/message-received`. Every
 * operation rejects with a {@link WhatsAppError} while the account is not
 * `online`.
 */
export interface WhatsAppProvider {
  readonly id: string
  /** Cheap local usability check; must not touch the network. */
  available(): boolean
  /** Current connection state; synchronous and never throws. */
  status(): WhatsAppStatus
  /** List known conversations; honor `signal` for cancellation. */
  listChats(signal?: AbortSignal): Promise<readonly WhatsAppChat[]>
  /**
   * Resolve one conversation address, deciding its kind and naming it when this
   * connection observed it. The provider owns this because it tracks WhatsApp's
   * address spaces; it must answer for an address it has never observed, and
   * reject only a value that names no conversation at all, with
   * `WHATSAPP_UNKNOWN_CHAT`.
   */
  resolveChat(chatId: WhatsAppChatId, signal?: AbortSignal): Promise<WhatsAppChat>
  /**
   * Read one page of a chat's history, newest first; honor `signal`. An address
   * this connection has not observed has no retained history, so it answers with
   * an empty page; only a value that names no conversation at all is rejected,
   * with `WHATSAPP_UNKNOWN_CHAT`.
   */
  fetchMessages(request: WhatsAppHistoryRequest, signal?: AbortSignal): Promise<readonly WhatsAppMessage[]>
  /** Send one text message; honor `signal`. */
  send(request: WhatsAppSendRequest, signal?: AbortSignal): Promise<WhatsAppSentMessage>
  /** Mark a chat read up to its newest message; honor `signal`. */
  markRead(chatId: WhatsAppChatId, signal?: AbortSignal): Promise<void>
}

/**
 * Typed WhatsApp error with a machine-routable, open-string `code` and chained
 * `cause`. Consumers must tolerate provider-specific codes. The seam owns
 * `WHATSAPP_PROVIDER_UNAVAILABLE` (no provider registered),
 * `WHATSAPP_PROVIDER_ALREADY_REGISTERED` (a second registration),
 * `WHATSAPP_NOT_ONLINE` (the account is not connected),
 * `WHATSAPP_EMPTY_MESSAGE`, and `WHATSAPP_INVALID_LIMIT`; a provider adds codes
 * for its own transport, addressing, and rate failures.
 */
export class WhatsAppError extends HarnessError {}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The account's connection state changed, emitted once per transition. A
     * `pairing` state is re-emitted whenever the provider rotates its payload,
     * so a display always renders the latest one.
     * @param status - the state just entered.
     * @mode emit
     */
    'whatsapp/status'(status: WhatsAppStatus): void
    /**
     * One message was observed in a chat, including messages the connected
     * account sent from another device (`fromMe`). Delivery follows the
     * provider's own order and repeats a message whose id was already seen when
     * the provider replays history after a reconnection, so a consumer that
     * must act once keeps its own processed-id set.
     * @param message - the observed message, normalized by the provider.
     * @mode emit
     */
    'whatsapp/message-received'(message: WhatsAppMessage): void
    /**
     * The provider acknowledged one send requested through `ctx.whatsapp`.
     * Acknowledgement means WhatsApp accepted the message, not that it reached
     * or was read by the recipient.
     * @param message - the acknowledged message identity and send time.
     * @mode emit
     */
    'whatsapp/message-sent'(message: WhatsAppSentMessage): void
  }
}
