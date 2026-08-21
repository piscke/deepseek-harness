/**
 * Vocabulary of the model-facing WhatsApp tools: the durable record one
 * approved send writes. Types and the session-event declaration only.
 * @module @deepseek-ai/dsh-tool-whatsapp/src/types
 */

/** Durable record of one message this session sent, after the provider acknowledged it. */
export interface WhatsAppOutboundEvent {
  /** Provider message id of the acknowledged message. */
  readonly messageId: string
  /** Conversation the message was sent to. */
  readonly chatId: string
  /** Conversation display name at send time; absent when the account had never resolved one. */
  readonly chatName?: string
  /** The body as it was sent, verbatim. */
  readonly text: string
  /** Message quoted in the same chat, when the send was threaded. */
  readonly quotedMessageId?: string
  /** Provider-reported send time as a four-digit-year RFC 3339 UTC string. */
  readonly timestamp: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * The account sent one message this session composed, and the provider
     * acknowledged it. Written only after acknowledgement, so the log never
     * claims a send WhatsApp refused. Acknowledgement means WhatsApp accepted
     * the message, not that it reached or was read by the recipient.
     */
    'whatsapp/outbound': WhatsAppOutboundEvent
  }
}
