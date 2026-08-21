/**
 * Vocabulary of the WhatsApp Workspace consumer: the routing mode, the
 * resolved routing target, and the durable provenance event one delivered
 * inbound message writes. Types and the session-event declaration only — the
 * runtime lives in the sibling modules, and the deployment policy lives with
 * its schema in `src/index.ts`.
 * @module @deepseek-ai/dsh-whatsapp-workspace/src/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WhatsAppChatKind, WhatsAppContent } from '@deepseek-ai/dsh-whatsapp'

/**
 * How inbound conversations map onto sessions. A CLOSED union: consumers
 * `switch` on it ending in `assertNever`, so a new mode breaks compilation.
 *
 * - `category` — two standing sessions, one for groups and one for direct
 *   chats. Every conversation of a kind shares an agent, so each delivered
 *   message must identify its chat.
 * - `per-chat` — one session per conversation, created the first time that
 *   conversation is routed.
 * - `single` — every conversation shares one session.
 */
export type WhatsAppRouteMode = 'category' | 'per-chat' | 'single'

/** The session one routed message belongs to, plus the title that session is pinned to. */
export interface WhatsAppRouteTarget {
  /** Deterministic session identity, so a restart resumes the same conversation. */
  readonly sessionId: SessionId
  /** Display title pinned with `ctx.sessionTitle.rename()` when the session is ensured. */
  readonly title: string
}

/** Durable provenance of one inbound WhatsApp message delivered to this session. */
export interface WhatsAppInboundEvent {
  /** Provider message id, unique to the connection that observed it. */
  readonly messageId: string
  /** Conversation the message belongs to — the value `whatsapp_send_message` needs to answer it. */
  readonly chatId: string
  /** Whether the conversation addresses one person or a group. */
  readonly chatKind: WhatsAppChatKind
  /** Conversation display name; absent when the account has never resolved one. */
  readonly chatName?: string
  /** Author address. Equals `chatId` in a direct chat and the participant in a group. */
  readonly senderId: string
  /** Author display name; absent when the account has never resolved one. */
  readonly senderName?: string
  /** Provider-reported send time as a four-digit-year RFC 3339 UTC string. */
  readonly timestamp: string
  /** The observed body, verbatim from the seam. */
  readonly content: WhatsAppContent
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One inbound WhatsApp message was delivered to this session as a
     * follow-up turn. The turn's `user/message` carries the framing the model
     * reads; this event carries the WhatsApp identity behind it, which the
     * framing text cannot be parsed back into.
     */
    'whatsapp/inbound': WhatsAppInboundEvent
  }
}
