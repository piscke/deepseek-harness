/**
 * Shared chat resolution and model-facing rendering for the WhatsApp tools.
 * Every tool that names a conversation resolves it through {@link resolveChat},
 * so the account's display name reaches the model and the operator whenever the
 * account knows one.
 * @module @deepseek-ai/dsh-tool-whatsapp/src/chats
 */

import type { Context } from '@deepseek-ai/cordis'
import { assertNever } from '@deepseek-ai/dsh-llm'
import type { WhatsAppChat, WhatsAppMessage } from '@deepseek-ai/dsh-whatsapp'
import { WhatsAppChatId } from '@deepseek-ai/dsh-whatsapp'

/**
 * Resolve one model-supplied chat id through the account.
 *
 * A chat id is opaque, so nothing here parses it: WhatsApp owns its address
 * spaces and adds to them, and guessing gets it wrong in the direction that
 * matters — a live account returned a named `…@lid` conversation that suffix
 * matching here rejected as "not a WhatsApp address", so `whatsapp_list_chats`
 * and `whatsapp_read_chat` contradicted each other on the documented path. The
 * provider decides the conversation's kind, names it when this connection
 * observed it, and rejects only a value that names no conversation at all.
 *
 * Resolving before anything else is also what makes a logged-out account fail
 * before an operator is asked to approve a send.
 * @param ctx - context carrying `ctx.whatsapp`.
 * @param chatId - the model-supplied conversation address.
 * @param signal - the tool call's cancellation signal.
 * @returns the conversation as the account reports it.
 */
export async function resolveChat(ctx: Context, chatId: string, signal: AbortSignal): Promise<WhatsAppChat> {
  return ctx.whatsapp.resolveChat(WhatsAppChatId(chatId), signal)
}

/**
 * Name one conversation for a human reading an approval prompt or a tool
 * result. An account that resolved no display name leaves the operator judging a
 * bare address, so the unnamed case says so rather than presenting digits as if
 * they identified someone.
 * @param chat - the resolved conversation.
 * @returns the human-facing description.
 */
export function describeChat(chat: WhatsAppChat): string {
  return chat.name === undefined ? `an unnamed conversation at ${chat.id}` : `${chat.name} (${chat.id})`
}

/**
 * Label one conversation in a rendered tool result, where the id is already
 * shown beside the label.
 * @param name - the display name, when the account resolved one.
 * @returns the label.
 */
export function chatLabel(name: string | undefined): string {
  return name ?? '(unnamed)'
}

/**
 * The body of one message as the model reads it; unsupported media names its
 * type rather than vanishing from the transcript.
 * @param message - the message to render.
 * @returns the body text.
 */
export function renderBody(message: WhatsAppMessage): string {
  switch (message.content.kind) {
    case 'text': return message.content.text
    case 'unsupported': return `[unsupported media: ${message.content.mediaType}]`
    /* v8 ignore next -- WhatsAppContent is closed and every member is handled above. */
    default: return assertNever(message.content, 'WhatsAppContent')
  }
}

/** One history entry as the tools return it. */
export interface MessageOutput {
  message_id: string
  sender: string
  from_me: boolean
  timestamp: string
  text: string
}

/**
 * Project one message onto the tool's output entry.
 * @param message - the message the provider returned.
 * @returns the model-facing entry.
 */
export function messageOutput(message: WhatsAppMessage): MessageOutput {
  return {
    message_id: message.id,
    sender: message.senderName === undefined ? message.senderId : `${message.senderName} (${message.senderId})`,
    from_me: message.fromMe,
    timestamp: message.timestamp,
    text: renderBody(message),
  }
}

/** One conversation as `whatsapp_list_chats` returns it. */
export interface ChatOutput {
  chat_id: string
  name?: string
  kind: string
  unread_count: number
}

/**
 * Project one conversation onto the tool's output entry. A chat the account
 * resolved no name for reports none, so the model can tell an unnamed
 * conversation from one actually called by its number.
 * @param chat - the conversation the provider returned.
 * @returns the model-facing entry.
 */
export function chatOutput(chat: WhatsAppChat): ChatOutput {
  return {
    chat_id: chat.id,
    ...chat.name === undefined ? {} : { name: chat.name },
    kind: chat.kind,
    unread_count: chat.unreadCount,
  }
}
