/**
 * The WhatsApp Workspace's settings section, as this package spells it.
 *
 * The Workspace is a Host package and a client package must not depend on one,
 * so the namespace, the field, and the values it accepts are written out here
 * instead of imported. `node-half.host.spec.ts` compares them against the
 * Workspace's own schema, on the side of the split where importing it is legal.
 * @module @deepseek-ai/dsh-client-ui-settings-whatsapp/src/workspace-settings
 */

/** Settings namespace the WhatsApp Workspace registers. */
export const WHATSAPP_WORKSPACE_NS = 'whatsapp-workspace'

/** Field of that namespace carrying which conversations open a session. */
export const WHATSAPP_CHATS_FIELD = 'chats'

/** Every value that field accepts, in the order the card offers them. */
export const WHATSAPP_CHAT_SCOPES = ['all', 'groups', 'contacts'] as const

/** Which conversations the Workspace opens a session for. */
export type WhatsAppChatScope = typeof WHATSAPP_CHAT_SCOPES[number]

/** The routing slice of the Workspace's settings section. */
export interface WhatsAppWorkspaceSection {
  /** Which conversations open a session. */
  chats?: WhatsAppChatScope
}
