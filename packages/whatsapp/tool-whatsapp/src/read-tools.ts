/**
 * The three read-side WhatsApp tools: list the account's conversations, read one
 * conversation's recent history, and mark a conversation read. None of them
 * emits anything to WhatsApp's network beyond the read receipt `mark_read`
 * exists to send, so none goes through approval.
 * @module @deepseek-ai/dsh-tool-whatsapp/src/read-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { WhatsAppMessageId } from '@deepseek-ai/dsh-whatsapp'
import { chatLabel, chatOutput, messageOutput, resolveChat } from './chats.ts'

/** Output entry schema shared by every tool that returns messages. */
const MESSAGE_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message_id: { type: 'string', required: true },
    sender: { type: 'string', required: true },
    from_me: { type: 'boolean', required: true },
    timestamp: { type: 'string', required: true },
    text: { type: 'string', required: true },
  },
} as const

/**
 * Register `whatsapp_list_chats`.
 * @param ctx - registrant context carrying the tool registry and `ctx.whatsapp`.
 * @param maxResults - upper bound on conversations one call returns.
 * @param timeoutMs - cooperative tool-call timeout budget.
 */
export function applyListChatsTool(ctx: Context, maxResults: number, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'whatsapp_list_chats',
    description:
      'List the WhatsApp conversations this account has observed since it connected, with their chat_id, '
      + 'display name, kind (direct or group), and unread count. This index is connection-scoped rather than a '
      + 'roster: it holds what this connection happens to have seen, which may be nothing. An empty result '
      + 'means nothing has been observed yet, NOT that the account has no conversations. A chat_id you already '
      + 'hold — from an incoming message or from the operator — stays usable even when it is absent here.',
    timeoutMs,
    parameters: {
      unread_only: {
        type: 'boolean',
        description: 'Return only conversations with unread messages. Defaults to false.',
      },
      limit: {
        type: 'integer',
        description: `Maximum conversations to return (1-${maxResults}). Defaults to ${maxResults}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chats: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                chat_id: { type: 'string', required: true },
                name: { type: 'string' },
                kind: { type: 'string', required: true },
                unread_count: { type: 'integer', required: true },
              },
            },
          },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.chats.length === 0
          ? 'No WhatsApp conversations observed on this connection yet.'
          : [
            `${value.chats.length} of ${value.total} WhatsApp conversations:`,
            ...value.chats.map(chat =>
              `- ${chatLabel(chat.name)} [chat_id: ${chat.chat_id}] ${chat.kind}, ${chat.unread_count} unread`),
          ].join('\n'),
      }],
    },
    async execute(args, exec) {
      const limit = resolveLimit(args.limit, maxResults, 'limit') ?? maxResults
      const chats = await ctx.whatsapp.listChats(exec.signal)
      const matched = args.unread_only === true ? chats.filter(chat => chat.unreadCount > 0) : chats
      return { chats: matched.slice(0, limit).map(chatOutput), total: matched.length }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.unread_only === true ? 'List unread WhatsApp chats' : 'List WhatsApp chats',
      kind: 'fetch',
    }),
  }))
}

/**
 * Register `whatsapp_read_chat`.
 * @param ctx - registrant context carrying the tool registry and `ctx.whatsapp`.
 * @param defaultLimit - history page size when the model names none.
 * @param maxLimit - upper bound on messages one call returns.
 * @param timeoutMs - cooperative tool-call timeout budget.
 */
export function applyReadChatTool(ctx: Context, defaultLimit: number, maxLimit: number, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'whatsapp_read_chat',
    description:
      'Read the recent messages of ONE WhatsApp conversation, newest first. Use it to catch up on a '
      + 'chat before answering it. chat_id must come from whatsapp_list_chats or from an incoming '
      + 'message. History is connection-scoped, so an empty result is a normal outcome: it means this '
      + 'connection has retained nothing for that chat, NOT that the conversation is empty or '
      + 'unreachable. A chat that reads empty can still be sent to.',
    timeoutMs,
    parameters: {
      chat_id: {
        type: 'string',
        required: true,
        description: 'The conversation to read, exactly as reported by whatsapp_list_chats or by an incoming message.',
      },
      limit: {
        type: 'integer',
        description: `Maximum messages to return (1-${maxLimit}). Defaults to ${defaultLimit}.`,
      },
      before: {
        type: 'string',
        description: 'Return only messages older than this message_id, to page further back.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chat_id: { type: 'string', required: true },
          chat_name: { type: 'string' },
          messages: { type: 'array', required: true, items: MESSAGE_ITEM },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.messages.length === 0
          ? `No messages retained on this connection for ${chatLabel(value.chat_name)} `
            + `[chat_id: ${value.chat_id}]. The conversation is still writable.`
          : [
            `${value.messages.length} message(s) in ${chatLabel(value.chat_name)} [chat_id: ${value.chat_id}], newest first:`,
            ...value.messages.map(message =>
              `- ${message.timestamp} ${message.from_me ? '(you)' : message.sender}: ${message.text}`),
          ].join('\n'),
      }],
    },
    async execute(args, exec) {
      const limit = resolveLimit(args.limit, maxLimit, 'limit') ?? defaultLimit
      const chat = await resolveChat(ctx, args.chat_id, exec.signal)
      const messages = await ctx.whatsapp.fetchMessages({
        chatId: chat.id,
        limit,
        ...args.before === undefined ? {} : { before: WhatsAppMessageId(args.before) },
      }, exec.signal)
      return {
        chat_id: chat.id,
        ...chat.name === undefined ? {} : { chat_name: chat.name },
        messages: messages.map(messageOutput),
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Read WhatsApp chat ${args.chat_id}`,
      kind: 'fetch',
    }),
  }))
}

/**
 * Register `whatsapp_mark_read`.
 * @param ctx - registrant context carrying the tool registry and `ctx.whatsapp`.
 * @param timeoutMs - cooperative tool-call timeout budget.
 */
export function applyMarkReadTool(ctx: Context, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'whatsapp_mark_read',
    description:
      'Mark ONE WhatsApp conversation read up to its newest message. The other participant sees the '
      + 'read receipt, so only mark a conversation you have actually read.',
    timeoutMs,
    parameters: {
      chat_id: {
        type: 'string',
        required: true,
        description: 'The conversation to mark read, exactly as reported by whatsapp_list_chats or by an incoming message.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chat_id: { type: 'string', required: true },
          chat_name: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Marked ${chatLabel(value.chat_name)} [chat_id: ${value.chat_id}] read.`,
      }],
    },
    async execute(args, exec) {
      const chat = await resolveChat(ctx, args.chat_id, exec.signal)
      await ctx.whatsapp.markRead(chat.id, exec.signal)
      return { chat_id: chat.id, ...chat.name === undefined ? {} : { chat_name: chat.name } }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Mark WhatsApp chat ${args.chat_id} read`,
      kind: 'other',
    }),
  }))
}

/**
 * Validate one model-supplied page size against the deployment's cap. The
 * schema can express the type but not the bound, so the bound is checked here
 * and a violation is rejected rather than clamped: silently returning fewer
 * messages than asked would read as the conversation being that short.
 * @param value - the model-supplied limit, when given.
 * @param max - the deployment's cap.
 * @param field - the argument name, for the rejection message.
 * @returns the accepted limit, or `undefined` when the model named none.
 */
export function resolveLimit(value: number | undefined, max: number, field: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`invalid ${field}: expected an integer between 1 and ${max}, got ${value}`)
  }
  return value
}
