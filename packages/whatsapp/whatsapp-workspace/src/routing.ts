/**
 * Pure routing and framing: which session one observed message belongs to, and
 * the text that message enters that session as. Both run on every inbound
 * message and touch nothing but their arguments.
 * @module @deepseek-ai/dsh-whatsapp-workspace/src/routing
 */

import { createHash } from 'node:crypto'
import { assertNever, boundContextSummary } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { WhatsAppChatKind, WhatsAppMessage } from '@deepseek-ai/dsh-whatsapp'
import type { ResolvedConfig } from './index.ts'

/**
 * Session id of one conversation. A chat id is an account-visible address
 * containing characters a session id should not carry, so the identity is a
 * digest of it: stable across restarts and collision-free where a character
 * substitution would not be.
 * @param chatId - the conversation address to derive an identity from.
 * @returns the deterministic per-conversation session id.
 */
export function chatSessionId(chatId: string): SessionId {
  return SessionId(`whatsapp-chat-${createHash('sha256').update(chatId).digest('hex').slice(0, 16)}`)
}

/**
 * Whether the configured scope covers conversations of this kind.
 * @param config - the resolved routing policy.
 * @param chatKind - what the conversation addresses.
 * @returns whether a conversation of this kind opens a session.
 */
export function isRoutedKind(config: ResolvedConfig, chatKind: WhatsAppChatKind): boolean {
  switch (config.chats) {
    case 'all': return true
    case 'groups': return chatKind === 'group'
    case 'contacts': return chatKind === 'direct'
    /* v8 ignore next -- WhatsAppChatScope is closed and every member is handled above. */
    default: return assertNever(config.chats, 'WhatsAppChatScope')
  }
}

/**
 * Whether the deployment routes this conversation at all. The scope decides
 * first, then the id lists: an allowlist, when non-empty, is exhaustive, and
 * the denylist is applied afterwards, so a chat named by both stays denied.
 *
 * An allowlisted id still has to fall inside the scope, so narrowing `chats`
 * never leaves a conversation routed by an entry the operator forgot.
 * @param config - the resolved routing policy.
 * @param chatId - the conversation address to judge.
 * @param chatKind - what that conversation addresses.
 * @returns whether messages from this conversation reach a session.
 */
export function isRoutedChat(config: ResolvedConfig, chatId: string, chatKind: WhatsAppChatKind): boolean {
  if (!isRoutedKind(config, chatKind)) return false
  if (config.denyChatIds.includes(chatId)) return false
  return config.allowChatIds.length === 0 || config.allowChatIds.includes(chatId)
}

/**
 * Resolve the session one observed message belongs to. Every routed
 * conversation owns its own session, so the identity is a digest of the chat
 * id and one contact's history never mixes with another's.
 *
 * A message the connected account wrote (`fromMe`, including from another
 * device) is never routed: it is the echo of an answer the deployment already
 * produced, and delivering it back would wake the agent with its own words.
 * Nothing else is filtered by content — `whatsapp/message-received` means a
 * person sent something, and a provider that cannot honor that drops the frame
 * rather than publishing it.
 * @param config - the resolved routing policy.
 * @param message - the observed message, as the seam normalized it.
 * @returns the session that conversation owns, or `undefined` when the message is not routed.
 */
export function routeMessage(config: ResolvedConfig, message: WhatsAppMessage): SessionId | undefined {
  if (message.fromMe) return undefined
  if (!isRoutedChat(config, message.chatId, message.chatKind)) return undefined
  return chatSessionId(message.chatId)
}

/**
 * The title one conversation's session is pinned to. The account's own name
 * for the conversation wins, because it is the one the operator recognizes and
 * the only one that exists for a group; the name carried by the message is the
 * fallback, and the chat id is what an unnamed conversation is called until a
 * name is resolved.
 * @param message - the observed message, as the seam normalized it.
 * @param resolved - the conversation's name according to the account, when it has one.
 * @returns the display title for that conversation's session.
 */
export function chatTitle(message: WhatsAppMessage, resolved?: string): string {
  return resolved ?? message.chatName ?? message.chatId
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
 * Frame one message for the session it enters. A session serves exactly one
 * conversation, but the chat id is still part of the message: it is the value
 * `whatsapp_send_message` needs to answer, and reading it out of the turn is
 * more reliable than expecting the model to carry it from session context.
 * @param message - the observed message, as the seam normalized it.
 * @returns the text the framing carries to the model.
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

/**
 * One-line account of a message for the collapsed transcript row, so a message
 * still waiting to reach the model is readable without expanding it. The sender
 * leads, because a session already serves one conversation and the addresses
 * `renderInbound` carries for the model are noise to a reader.
 * @param message - the observed message, as the seam normalized it.
 * @returns the account, bounded to the durable `notice` summary limit.
 */
export function summarizeInbound(message: WhatsAppMessage): string {
  const sender = message.senderName ?? message.senderId
  return boundContextSummary(`${sender}: ${renderBody(message)}`)
}
