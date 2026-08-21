/**
 * `whatsapp_send_message`: the only tool in this package that puts something on
 * the network under the operator's own account. Every call resolves its
 * destination against the account's known chats, asks the operator through
 * `ctx.approval` with that destination named, and records the acknowledged
 * message in the session log.
 * @module @deepseek-ai/dsh-tool-whatsapp/src/send-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { assertNever } from '@deepseek-ai/dsh-llm'
import type { CallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { WhatsAppMessageId } from '@deepseek-ai/dsh-whatsapp'
import type { WhatsAppChat } from '@deepseek-ai/dsh-whatsapp'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { chatLabel, describeChat, resolveChat } from './chats.ts'
import type {} from './types.ts'

/** How much of the body the approval prompt quotes before eliding the rest. */
export const APPROVAL_PREVIEW_CHARS = 200

/**
 * The one-line reason the operator reads before a message leaves the machine.
 * The destination is named first and in full — the decision being made is "does
 * this text go to this person", so the recipient can never be off-screen.
 * @param chat - the resolved destination conversation.
 * @param text - the body about to be sent.
 * @returns the approval prompt reason.
 */
export function approvalReason(chat: WhatsAppChat, text: string): string {
  const preview = text.length > APPROVAL_PREVIEW_CHARS
    ? `${text.slice(0, APPROVAL_PREVIEW_CHARS)}…`
    : text
  return `send a WhatsApp message to ${describeChat(chat)}: ${JSON.stringify(preview)}`
}

/**
 * Resolve the operator's decision, failing closed on every path that is not an
 * explicit grant. A composition without an approval channel cannot send at all:
 * the operator's consent is the whole reason this tool is allowed to act under
 * their identity, so an absent channel is a refusal, never a default yes.
 * @param ctx - context that may carry `ctx.approval`.
 * @param agent - the calling agent, or `undefined` for an agent-less execution.
 * @param callId - the call the approval prompt attaches to.
 * @param chat - the resolved destination conversation.
 * @param text - the body about to be sent.
 * @param signal - the tool call's cancellation signal.
 * @returns the calling agent, once the operator granted this exact send.
 */
export async function approveSend(
  ctx: Context,
  agent: Agent | undefined,
  callId: CallId,
  chat: WhatsAppChat,
  text: string,
  signal: AbortSignal,
): Promise<Agent> {
  const approval = ctx.get('approval')
  if (approval === undefined) {
    throw new Error('whatsapp_send_message requires approval, but no approval service is composed')
  }
  if (agent === undefined) {
    throw new Error('whatsapp_send_message requires approval, but the call has no agent to route it through')
  }
  const outcome = await approval.request({
    agent,
    toolName: 'whatsapp_send_message',
    callId,
    reason: approvalReason(chat, text),
    signal,
  })
  switch (outcome) {
    case 'allowed-once': return agent
    case 'rejected': throw new Error(`the user rejected sending this message to ${describeChat(chat)}`)
    case 'cancelled': throw new Error(`approval for sending to ${describeChat(chat)} was cancelled`)
    case 'unavailable': throw new Error('whatsapp_send_message requires approval, but no approval channel is available')
    /* v8 ignore next -- ApprovalOutcome is closed and every member is handled above. */
    default: return assertNever(outcome, 'ApprovalOutcome')
  }
}

/**
 * Register `whatsapp_send_message`.
 * @param ctx - registrant context carrying the tool registry, `ctx.whatsapp`, and optionally `ctx.approval`.
 * @param maxTextChars - upper bound on one message body.
 * @param timeoutMs - cooperative tool-call timeout budget.
 */
export function applySendMessageTool(ctx: Context, maxTextChars: number, timeoutMs: number): void {
  ctx.tools.register(defineTool({
    name: 'whatsapp_send_message',
    description:
      'Send ONE WhatsApp text message to an explicit conversation. chat_id is REQUIRED and must come '
      + 'from whatsapp_list_chats or from the [chat_id: ...] header of an incoming message — this tool '
      + 'never infers a recipient, and there is no "reply to the last chat". The user approves every '
      + 'send before it leaves the machine, and the approval prompt names the recipient.',
    timeoutMs,
    parameters: {
      chat_id: {
        type: 'string',
        required: true,
        description: 'The conversation to send to, exactly as reported by whatsapp_list_chats or an incoming message.',
      },
      text: {
        type: 'string',
        required: true,
        description: `The message body, as the recipient will read it (1-${maxTextChars} characters).`,
      },
      quoted_message_id: {
        type: 'string',
        description: 'A message_id in the same conversation to quote, when the reply should be threaded.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message_id: { type: 'string', required: true },
          chat_id: { type: 'string', required: true },
          chat_name: { type: 'string' },
          timestamp: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Sent to ${chatLabel(value.chat_name)} [chat_id: ${value.chat_id}] `
          + `at ${value.timestamp} (message_id: ${value.message_id}).`,
      }],
    },
    async execute(args, exec) {
      const text = args.text
      if (text.trim().length === 0) {
        throw new Error('invalid text: a WhatsApp message must carry a non-empty body')
      }
      if (text.length > maxTextChars) {
        throw new Error(`invalid text: at most ${maxTextChars} characters (got ${text.length})`)
      }
      const chat = await resolveChat(ctx, args.chat_id, exec.signal)
      const agent = await approveSend(ctx, exec.agent, exec.callId, chat, text, exec.signal)
      const sent = await ctx.whatsapp.send({
        chatId: chat.id,
        text,
        ...args.quoted_message_id === undefined ? {} : { quotedMessageId: WhatsAppMessageId(args.quoted_message_id) },
      }, exec.signal)
      // After acknowledgement, so the log never claims a send WhatsApp refused.
      agent.session.append('whatsapp/outbound', {
        messageId: sent.id,
        chatId: sent.chatId,
        ...chat.name === undefined ? {} : { chatName: chat.name },
        text,
        ...args.quoted_message_id === undefined ? {} : { quotedMessageId: args.quoted_message_id },
        timestamp: sent.timestamp,
      })
      return {
        message_id: sent.id,
        chat_id: sent.chatId,
        ...chat.name === undefined ? {} : { chat_name: chat.name },
        timestamp: sent.timestamp,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Send WhatsApp message to ${args.chat_id}`,
      kind: 'other',
      rawInput: args.text,
    }),
  }))
}
