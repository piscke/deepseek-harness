/**
 * Snapshot fixture: one scripted WhatsApp account and a scripted operator.
 *
 * The account is online with two conversations and a short history, so the tool
 * suite exercises its real code path without a network or a paired phone. The
 * operator approves the first send and rejects the second, which is what makes
 * the approval choreography observable in the transcript. The account resolves
 * any address it can read, observed or not, and refuses only a value that names
 * no conversation at all — the seam's rule, not a rule the tools apply.
 * @module whatsapp-scripted-account
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import {
  WhatsAppChatId,
  WhatsAppError,
  WhatsAppMessageId,
  type WhatsAppChat,
  type WhatsAppHistoryRequest,
  type WhatsAppMessage,
  type WhatsAppProvider,
  type WhatsAppSendRequest,
  type WhatsAppSentMessage,
  type WhatsAppStatus,
} from '@deepseek-ai/dsh-whatsapp'

/** Fixture plugin name. */
export const name = 'whatsapp-scripted-account'
/** The seam this fixture registers into, and the approval seam it answers. */
export const inject = ['whatsapp', 'approval']

const ANA = WhatsAppChatId('5511999990000@s.whatsapp.net')
const FAMILIA = WhatsAppChatId('12036300000@g.us')

const CHATS: readonly WhatsAppChat[] = [
  { id: ANA, kind: 'direct', name: 'Ana', unreadCount: 2 },
  { id: FAMILIA, kind: 'group', name: 'Família', unreadCount: 0 },
]

const HISTORY: Readonly<Record<string, readonly WhatsAppMessage[]>> = {
  [ANA]: [
    {
      id: WhatsAppMessageId('ana-2'),
      chatId: ANA,
      chatKind: 'direct',
      chatName: 'Ana',
      senderId: ANA,
      senderName: 'Ana',
      fromMe: false,
      timestamp: '2026-08-22T10:01:00.000Z',
      content: { kind: 'text', text: 'consegue confirmar o horário?' },
    },
    {
      id: WhatsAppMessageId('ana-1'),
      chatId: ANA,
      chatKind: 'direct',
      chatName: 'Ana',
      senderId: ANA,
      senderName: 'Ana',
      fromMe: false,
      timestamp: '2026-08-22T10:00:00.000Z',
      content: { kind: 'text', text: 'boa tarde!' },
    },
  ],
  [FAMILIA]: [],
}

/** The scripted account. Every operation answers from memory, in provider order. */
class ScriptedAccount implements WhatsAppProvider {
  readonly id = 'scripted'

  available(): boolean {
    return true
  }

  status(): WhatsAppStatus {
    return { state: 'online', accountId: 'scripted-account' }
  }

  async listChats(): Promise<readonly WhatsAppChat[]> {
    return CHATS
  }

  async resolveChat(chatId: WhatsAppChatId): Promise<WhatsAppChat> {
    const observed = CHATS.find(chat => chat.id === chatId)
    if (observed !== undefined) return observed
    if (!chatId.includes('@')) {
      throw new WhatsAppError(`"${chatId}" names no conversation`, 'WHATSAPP_UNKNOWN_CHAT')
    }
    return { id: chatId, kind: 'direct', unreadCount: 0 }
  }

  async fetchMessages(request: WhatsAppHistoryRequest): Promise<readonly WhatsAppMessage[]> {
    const page = HISTORY[request.chatId] ?? []
    return request.limit === undefined ? page : page.slice(0, request.limit)
  }

  async send(request: WhatsAppSendRequest): Promise<WhatsAppSentMessage> {
    return { id: WhatsAppMessageId('sent-1'), chatId: request.chatId, timestamp: '2026-08-22T10:05:00.000Z' }
  }

  async markRead(): Promise<void> {
    // The scripted account keeps no read state: the tool result is the observable.
  }
}

/**
 * Register the scripted account and the scripted operator.
 * @param ctx - a settled context carrying `ctx.whatsapp` and `ctx.approval`.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.whatsapp.register(new ScriptedAccount()), 'whatsapp-scripted-account.provider')
  ctx.on('approval/request', async (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
    if (request.toolName !== 'whatsapp_send_message') return next()
    return request.reason?.includes('Família') === true ? 'rejected' : 'allowed-once'
  })
}
