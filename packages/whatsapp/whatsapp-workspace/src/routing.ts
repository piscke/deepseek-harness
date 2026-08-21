/**
 * Pure routing and framing: which session one observed message belongs to, and
 * the text that message enters that session as. Both run on every inbound
 * message and touch nothing but their arguments.
 * @module @deepseek-ai/dsh-whatsapp-workspace/src/routing
 */

import { createHash } from 'node:crypto'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { WhatsAppMessage } from '@deepseek-ai/dsh-whatsapp'
import type { ResolvedConfig } from './index.ts'
import type { WhatsAppRouteTarget } from './types.ts'

/** Session id of the `category` route's group session. */
export const GROUPS_SESSION_ID = SessionId('whatsapp-groups')
/** Session id of the `category` route's direct-chat session. */
export const CONTACTS_SESSION_ID = SessionId('whatsapp-contacts')
/** Session id of the `single` route's one session. */
export const CONVERSATIONS_SESSION_ID = SessionId('whatsapp-conversations')

/**
 * Session id of one conversation under the `per-chat` route. A chat id is an
 * account-visible address containing characters a session id should not carry,
 * so the identity is a digest of it: stable across restarts and collision-free
 * where a character substitution would not be.
 * @param chatId - the conversation address to derive an identity from.
 * @returns the deterministic per-chat session id.
 */
export function chatSessionId(chatId: string): SessionId {
  return SessionId(`whatsapp-chat-${createHash('sha256').update(chatId).digest('hex').slice(0, 16)}`)
}

/**
 * Whether the deployment routes this conversation at all. An allowlist, when
 * non-empty, is exhaustive; the denylist is applied afterwards, so a chat named
 * by both stays denied.
 * @param config - the resolved routing policy.
 * @param chatId - the conversation address to judge.
 * @returns whether messages from this conversation reach a session.
 */
export function isRoutedChat(config: ResolvedConfig, chatId: string): boolean {
  if (config.denyChatIds.includes(chatId)) return false
  return config.allowChatIds.length === 0 || config.allowChatIds.includes(chatId)
}

/**
 * Resolve the session one observed message belongs to.
 *
 * A message the connected account wrote (`fromMe`, including from another
 * device) is never routed: it is the echo of an answer the deployment already
 * produced, and delivering it back would wake the agent with its own words.
 * Nothing else is filtered by content — `whatsapp/message-received` means a
 * person sent something, and a provider that cannot honor that drops the frame
 * rather than publishing it.
 * @param config - the resolved routing policy.
 * @param message - the observed message, as the seam normalized it.
 * @returns the target session and its pinned title, or `undefined` when the message is not routed.
 */
export function routeMessage(config: ResolvedConfig, message: WhatsAppMessage): WhatsAppRouteTarget | undefined {
  if (message.fromMe) return undefined
  if (!isRoutedChat(config, message.chatId)) return undefined
  switch (config.route) {
    case 'category': return message.chatKind === 'group'
      ? { sessionId: GROUPS_SESSION_ID, title: config.groupsTitle }
      : { sessionId: CONTACTS_SESSION_ID, title: config.contactsTitle }
    case 'per-chat': return {
      sessionId: chatSessionId(message.chatId),
      title: message.chatName ?? message.chatId,
    }
    case 'single': return { sessionId: CONVERSATIONS_SESSION_ID, title: config.conversationsTitle }
    /* v8 ignore next -- WhatsAppRouteMode is closed and every member is handled above. */
    default: return assertNever(config.route, 'WhatsAppRouteMode')
  }
}

/**
 * The standing sessions a route opens before any message arrives, so the
 * Workspace is populated in the sidebar from load. The `per-chat` route opens
 * none: a conversation's session exists once that conversation is routed.
 * @param config - the resolved routing policy.
 * @returns the targets to create or resume at load, in display order.
 */
export function standingTargets(config: ResolvedConfig): readonly WhatsAppRouteTarget[] {
  switch (config.route) {
    case 'category': return [
      { sessionId: GROUPS_SESSION_ID, title: config.groupsTitle },
      { sessionId: CONTACTS_SESSION_ID, title: config.contactsTitle },
    ]
    case 'per-chat': return []
    case 'single': return [{ sessionId: CONVERSATIONS_SESSION_ID, title: config.conversationsTitle }]
    /* v8 ignore next -- WhatsAppRouteMode is closed and every member is handled above. */
    default: return assertNever(config.route, 'WhatsAppRouteMode')
  }
}

/** The body as the model reads it; unsupported media names its type rather than vanishing. */
function renderBody(message: WhatsAppMessage): string {
  switch (message.content.kind) {
    case 'text': return message.content.text
    case 'unsupported': return `[unsupported media: ${message.content.mediaType}]`
    /* v8 ignore next -- WhatsAppContent is closed and every member is handled above. */
    default: return assertNever(message.content, 'WhatsAppContent')
  }
}

/**
 * Frame one message for the session it enters. One session serves many
 * conversations under every route except `per-chat`, so the chat id and the
 * conversation's display name are part of the message rather than session
 * context the model is expected to remember.
 * @param message - the observed message, as the seam normalized it.
 * @returns the text the follow-up turn carries.
 */
export function renderInbound(message: WhatsAppMessage): string {
  const chat = message.chatName === undefined ? '' : ` "${message.chatName}"`
  const sender = message.senderName === undefined ? message.senderId : `${message.senderName} (${message.senderId})`
  return [
    `WhatsApp message in ${message.chatKind} chat${chat} [chat_id: ${message.chatId}]`,
    `From: ${sender}`,
    `Sent: ${message.timestamp}`,
    '',
    renderBody(message),
  ].join('\n')
}
