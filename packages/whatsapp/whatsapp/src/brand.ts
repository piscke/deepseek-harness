/**
 * Branded ids owned by the WhatsApp capability seam. Both are opaque
 * provider-assigned strings that cross package boundaries, so neither may be
 * passed where the other is expected.
 * @module @deepseek-ai/dsh-whatsapp/src/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Identifies one WhatsApp conversation — a direct chat or a group. The value is
 * the provider's addressing string (a JID for the Baileys provider); the seam
 * treats it as opaque and never parses it.
 */
export type WhatsAppChatId = Branded<'WhatsAppChatId'>

/**
 * Brand a string as a {@link WhatsAppChatId}.
 * @param id - the provider's raw conversation address.
 * @returns the same string, branded; no validation is performed.
 */
export function WhatsAppChatId(id: string): WhatsAppChatId {
  return id as WhatsAppChatId
}

/**
 * Identifies one WhatsApp message within its chat. Consumers use it to quote a
 * message, to page history, and to reject a message they already processed.
 */
export type WhatsAppMessageId = Branded<'WhatsAppMessageId'>

/**
 * Brand a string as a {@link WhatsAppMessageId}.
 * @param id - the provider's raw message id.
 * @returns the same string, branded; no validation is performed.
 */
export function WhatsAppMessageId(id: string): WhatsAppMessageId {
  return id as WhatsAppMessageId
}
