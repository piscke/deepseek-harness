import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import WhatsAppRuntime, {
  WhatsAppChatId,
  WhatsAppError,
  WhatsAppMessageId,
  type WhatsAppChat,
  type WhatsAppMessage,
  type WhatsAppProvider,
  type WhatsAppSentMessage,
} from '@deepseek-ai/dsh-whatsapp'

import * as tool from '../src/index.ts'

const anaId = WhatsAppChatId('5511999990000@s.whatsapp.net')
const groupId = WhatsAppChatId('12036300000@g.us')
const lidId = WhatsAppChatId('94257503293551@lid')
const testSignal = new AbortController().signal

const chats: WhatsAppChat[] = [
  { id: anaId, kind: 'direct', name: 'Ana', unreadCount: 2 },
  { id: groupId, kind: 'group', unreadCount: 0 },
]

function history(): WhatsAppMessage[] {
  return [
    {
      id: WhatsAppMessageId('M2'),
      chatId: anaId,
      chatKind: 'direct',
      chatName: 'Ana',
      senderId: anaId,
      senderName: 'Ana',
      fromMe: false,
      timestamp: '2026-08-21T10:00:00.000Z',
      content: { kind: 'text', text: 'oi' },
    },
    {
      id: WhatsAppMessageId('M1'),
      chatId: anaId,
      chatKind: 'direct',
      senderId: anaId,
      fromMe: true,
      timestamp: '2026-08-21T09:00:00.000Z',
      content: { kind: 'unsupported', mediaType: 'image/jpeg' },
    },
  ]
}

/** A scripted provider recording what the tools asked it to do. */
function provider(overrides: Partial<WhatsAppProvider> = {}): WhatsAppProvider & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    id: 'scripted',
    available: () => true,
    status: () => ({ state: 'online', accountId: '5511888880000' }),
    listChats: () => Promise.resolve(chats),
    resolveChat: (chatId) => {
      const observed = chats.find(candidate => candidate.id === chatId)
      if (observed !== undefined) return Promise.resolve(observed)
      const at = chatId.indexOf('@')
      if (at <= 0 || at === chatId.length - 1) {
        return Promise.reject(new WhatsAppError(`"${chatId}" names no conversation`, 'WHATSAPP_UNKNOWN_CHAT'))
      }
      return Promise.resolve({ id: chatId, kind: 'direct', unreadCount: 0 })
    },
    fetchMessages: (request) => {
      calls.push(request)
      return Promise.resolve(history())
    },
    send: (request): Promise<WhatsAppSentMessage> => {
      calls.push(request)
      return Promise.resolve({ id: WhatsAppMessageId('OUT1'), chatId: request.chatId, timestamp: '2026-08-21T11:00:00.000Z' })
    },
    markRead: (chatId) => {
      calls.push({ markRead: chatId })
      return Promise.resolve()
    },
    ...overrides,
  }
}

/** An Agent stand-in backed by a real Session inside an open turn. */
function agentWithSession(id = 'wa-1'): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

interface Setup {
  ctx: Context
  provider: WhatsAppProvider & { calls: unknown[] }
}

async function setup(options: {
  config?: Partial<tool.Config>
  approval?: ApprovalOutcome | 'none' | 'absent'
  providerOverrides?: Partial<WhatsAppProvider>
} = {}): Promise<Setup> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(WhatsAppRuntime)
  const scripted = provider(options.providerOverrides ?? {})
  ctx.whatsapp.register(scripted)
  const approval = options.approval ?? 'allowed-once'
  if (approval !== 'absent') {
    await ctx.plugin(ApprovalService, {})
    if (approval !== 'none') {
      ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>(approval))
    }
  }
  await ctx.plugin(tool, options.config ?? {})
  return { ctx, provider: scripted }
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown, over: { agent?: Agent | undefined } = {}) {
  const agent = 'agent' in over ? over.agent : agentWithSession()
  return ctx.tools.execute({
    signal: testSignal,
    callId: CallId(`call-${++callCounter}`),
    name,
    arguments: args,
    ...agent ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * The canonical value of a successful execution, viewed as the projection the
 * asserting test expects. `JsonValue` is a union, so an assertion cannot index
 * it without naming the tool's declared output.
 * @param result - the settled execution.
 * @returns the canonical value as `T`.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T names the caller's declared output projection.
function value<T>(result: { isError: boolean; value?: JsonValue }): T {
  if (result.isError) throw new Error('expected success')
  return result.value as T
}

/** The object `whatsapp_list_chats` returns. */
interface ListChatsValue {
  chats: { chat_id: string; name?: string; kind: string; unread_count: number }[]
  total: number
}

/** The object `whatsapp_read_chat` returns. */
interface ReadChatValue {
  chat_id: string
  chat_name?: string
  messages: { message_id: string; text: string; from_me: boolean }[]
}

describe('dsh-tool-whatsapp registration', () => {
  it('registers the four WhatsApp tools by default', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual([
      'whatsapp_list_chats',
      'whatsapp_mark_read',
      'whatsapp_read_chat',
      'whatsapp_send_message',
    ])
  })

  it('registers nothing when every tool is disabled', async () => {
    const { ctx } = await setup({
      config: { send: false, listChats: false, readChat: false, markRead: false },
    })
    expect(ctx.tools.schemas()).toEqual([])
  })

  it('requires chat_id on whatsapp_send_message', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(entry => entry.name === 'whatsapp_send_message')
    const parameters = schema?.parameters as { properties?: Record<string, unknown>; required?: string[] }
    expect(Object.keys(parameters.properties ?? {}).sort()).toEqual(['chat_id', 'quoted_message_id', 'text'])
    expect(parameters.required).toContain('chat_id')
    expect(parameters.required).toContain('text')
  })

  it.each([
    ['listChatsMaxResults', { listChatsMaxResults: 0 }],
    ['readChatDefaultLimit', { readChatDefaultLimit: 1.5 }],
    ['readChatMaxLimit', { readChatMaxLimit: -1 }],
    ['sendMaxTextChars', { sendMaxTextChars: 0 }],
    ['timeoutMs', { timeoutMs: 0 }],
  ])('rejects a non-positive-integer %s', async (field, config) => {
    await expect(setup({ config })).rejects.toThrow(`tool-whatsapp: ${field} must be a positive integer`)
  })

  it('rejects a default read limit above the maximum', async () => {
    await expect(setup({ config: { readChatDefaultLimit: 50, readChatMaxLimit: 10 } }))
      .rejects.toThrow('readChatDefaultLimit (50) exceeds readChatMaxLimit (10)')
  })
})

describe('whatsapp_list_chats', () => {
  it('returns every known conversation with its chat_id', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'whatsapp_list_chats', {})
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(result.value).toEqual({
      chats: [
        { chat_id: anaId, name: 'Ana', kind: 'direct', unread_count: 2 },
        { chat_id: groupId, kind: 'group', unread_count: 0 },
      ],
      total: 2,
    })
    expect(value<ListChatsValue>(result).chats[1]).not.toHaveProperty('name')
    expect(text(result)).toContain(`- (unnamed) [chat_id: ${groupId}]`)
    expect(text(result)).toContain(`[chat_id: ${anaId}]`)
  })

  it('filters to unread conversations on request', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'whatsapp_list_chats', { unread_only: true })
    const listed = value<ListChatsValue>(result)
    expect(listed.chats).toHaveLength(1)
    expect(listed.total).toBe(1)
  })

  it('honors an explicit limit', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'whatsapp_list_chats', { limit: 1 })
    const listed = value<ListChatsValue>(result)
    expect(listed.chats).toHaveLength(1)
    expect(listed.total).toBe(2)
  })

  it('reports an empty index as observation, not as an account without chats', async () => {
    const { ctx } = await setup({ providerOverrides: { listChats: () => Promise.resolve([]) } })
    const result = await call(ctx, 'whatsapp_list_chats', {})
    expect(text(result)).toBe('No WhatsApp conversations observed on this connection yet.')
  })

  it('rejects a limit outside the configured bound', async () => {
    const { ctx } = await setup({ config: { listChatsMaxResults: 5 } })
    const result = await call(ctx, 'whatsapp_list_chats', { limit: 9 })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('invalid limit: expected an integer between 1 and 5, got 9')
  })
})

describe('whatsapp_read_chat', () => {
  it('returns the conversation history newest first', async () => {
    const { ctx, provider: scripted } = await setup()
    const result = await call(ctx, 'whatsapp_read_chat', { chat_id: anaId, limit: 5, before: 'M9' })
    const read = value<ReadChatValue>(result)
    expect(read.chat_name).toBe('Ana')
    expect(read.messages.map(message => message.message_id)).toEqual(['M2', 'M1'])
    expect(read.messages[1]?.text).toBe('[unsupported media: image/jpeg]')
    expect(scripted.calls[0]).toEqual({ chatId: anaId, limit: 5, before: 'M9' })
    expect(text(result)).toContain('(you)')
  })

  it('falls back to the configured default page size', async () => {
    const { ctx, provider: scripted } = await setup({ config: { readChatDefaultLimit: 7 } })
    await call(ctx, 'whatsapp_read_chat', { chat_id: anaId })
    expect(scripted.calls[0]).toEqual({ chatId: anaId, limit: 7 })
  })

  it('leaves an unnamed group visibly unnamed', async () => {
    const { ctx } = await setup({ providerOverrides: { fetchMessages: () => Promise.resolve([]) } })
    const result = await call(ctx, 'whatsapp_read_chat', { chat_id: groupId })
    expect(value<ReadChatValue>(result).chat_name).toBeUndefined()
    expect(text(result)).toBe(
      `No messages retained on this connection for (unnamed) [chat_id: ${groupId}]. The conversation is still writable.`,
    )
  })

  it('reads a conversation the connection-scoped index has not observed', async () => {
    const unobserved = WhatsAppChatId('5511777770000@s.whatsapp.net')
    const { ctx, provider: scripted } = await setup()
    const result = await call(ctx, 'whatsapp_read_chat', { chat_id: unobserved })
    const read = value<ReadChatValue>(result)
    expect(read.chat_id).toBe(unobserved)
    expect(read.chat_name).toBeUndefined()
    expect(scripted.calls[0]).toEqual({ chatId: unobserved, limit: 20 })
  })

  it('reads an id whose address space it cannot classify, because ids are opaque', async () => {
    const { ctx, provider: scripted } = await setup()
    const result = await call(ctx, 'whatsapp_read_chat', { chat_id: lidId })
    expect(result.isError).toBe(false)
    expect(scripted.calls[0]).toEqual({ chatId: lidId, limit: 20 })
  })

  it('surfaces the account refusing a value that names no conversation', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'whatsapp_read_chat', { chat_id: '   ' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('names no conversation')
  })
})

describe('whatsapp_mark_read', () => {
  it('marks the resolved conversation read', async () => {
    const { ctx, provider: scripted } = await setup()
    const result = await call(ctx, 'whatsapp_mark_read', { chat_id: anaId })
    if (result.isError) throw new Error('expected success')
    expect(result.value).toEqual({ chat_id: anaId, chat_name: 'Ana' })
    expect(scripted.calls[0]).toEqual({ markRead: anaId })
    expect(text(result)).toBe(`Marked Ana [chat_id: ${anaId}] read.`)
  })

  it('leaves an unnamed conversation visibly unnamed', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'whatsapp_mark_read', { chat_id: groupId })
    if (result.isError) throw new Error('expected success')
    expect(result.value).toEqual({ chat_id: groupId })
    expect(text(result)).toBe(`Marked (unnamed) [chat_id: ${groupId}] read.`)
  })

  it('surfaces the provider refusing an id it does not recognize', async () => {
    const { ctx } = await setup({
      providerOverrides: {
        markRead: () => Promise.reject(new WhatsAppError('no such conversation', 'WHATSAPP_UNKNOWN_CHAT')),
      },
    })
    const result = await call(ctx, 'whatsapp_mark_read', { chat_id: '5511777770000@s.whatsapp.net' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no such conversation')
  })
})

describe('whatsapp_send_message', () => {
  it('sends after approval and records the acknowledged message', async () => {
    const { ctx, provider: scripted } = await setup()
    const agent = agentWithSession('sender')
    const result = await call(ctx, 'whatsapp_send_message', { chat_id: anaId, text: 'ola', quoted_message_id: 'M2' }, { agent })
    if (result.isError) throw new Error('expected success')
    expect(result.value).toEqual({
      message_id: 'OUT1',
      chat_id: anaId,
      chat_name: 'Ana',
      timestamp: '2026-08-21T11:00:00.000Z',
    })
    expect(scripted.calls[0]).toEqual({ chatId: anaId, text: 'ola', quotedMessageId: 'M2' })
    const outbound = agent.session.events.filter(event => event.type === 'whatsapp/outbound')
    expect(outbound).toHaveLength(1)
    expect(outbound[0]?.data).toEqual({
      messageId: 'OUT1',
      chatId: anaId,
      chatName: 'Ana',
      text: 'ola',
      quotedMessageId: 'M2',
      timestamp: '2026-08-21T11:00:00.000Z',
    })
    expect(text(result)).toContain('Sent to Ana')
  })

  it('records a send to an unnamed chat without a chat name', async () => {
    const { ctx } = await setup()
    const agent = agentWithSession('sender-2')
    const result = await call(ctx, 'whatsapp_send_message', { chat_id: groupId, text: 'oi' }, { agent })
    expect(value<{ chat_name?: string }>(result).chat_name).toBeUndefined()
    expect(text(result)).toContain(`Sent to (unnamed) [chat_id: ${groupId}]`)
    const outbound = agent.session.events.find(event => event.type === 'whatsapp/outbound')
    expect(outbound?.data).toEqual({
      messageId: 'OUT1',
      chatId: groupId,
      text: 'oi',
      timestamp: '2026-08-21T11:00:00.000Z',
    })
  })

  it('names the destination chat in the approval prompt', async () => {
    const { ctx } = await setup()
    const agent = agentWithSession('prompted')
    await call(ctx, 'whatsapp_send_message', { chat_id: anaId, text: 'ola' }, { agent })
    const asked = agent.session.events.find(event => event.type === 'approval/asked')
    expect(asked?.data.toolName).toBe('whatsapp_send_message')
    expect(asked?.data.reason).toBe(`send a WhatsApp message to Ana (${anaId}): "ola"`)
  })

  it('elides a long body in the approval prompt', () => {
    const long = 'x'.repeat(tool.APPROVAL_PREVIEW_CHARS + 10)
    const reason = tool.approvalReason(chats[0] as WhatsAppChat, long)
    expect(reason).toContain(`${'x'.repeat(tool.APPROVAL_PREVIEW_CHARS)}…`)
    expect(reason).not.toContain('x'.repeat(tool.APPROVAL_PREVIEW_CHARS + 1))
  })

  it.each([
    ['rejected' as const, 'the user rejected sending this message to Ana'],
    ['cancelled' as const, 'approval for sending to Ana'],
  ])('refuses to send when the operator answers %s', async (outcome, expected) => {
    const { ctx, provider: scripted } = await setup({ approval: outcome })
    const result = await call(ctx, 'whatsapp_send_message', { chat_id: anaId, text: 'ola' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(expected)
    expect(scripted.calls).toEqual([])
  })

  it('fails closed when no answerer is composed', async () => {
    const { ctx } = await setup({ approval: 'none' })
    const result = await call(ctx, 'whatsapp_send_message', { chat_id: anaId, text: 'ola' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no approval channel is available')
  })

  it('fails closed when no approval service is composed', async () => {
    const { ctx } = await setup({ approval: 'absent' })
    const result = await call(ctx, 'whatsapp_send_message', { chat_id: anaId, text: 'ola' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no approval service is composed')
  })

  it('fails closed for an agent-less execution', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'whatsapp_send_message', { chat_id: anaId, text: 'ola' }, { agent: undefined })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no agent to route it through')
  })

  it('rejects an empty body before resolving the chat', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'whatsapp_send_message', { chat_id: anaId, text: '   ' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('must carry a non-empty body')
  })

  it('rejects a body above the configured bound', async () => {
    const { ctx } = await setup({ config: { sendMaxTextChars: 4 } })
    const result = await call(ctx, 'whatsapp_send_message', { chat_id: anaId, text: 'hello' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('at most 4 characters (got 5)')
  })

  it('sends to an address the index has not observed, stating the approval target is unnamed', async () => {
    const unobserved = WhatsAppChatId('5511777770000@s.whatsapp.net')
    const reasons: string[] = []
    const { ctx, provider: scripted } = await setup()
    ctx.on('approval/request', (request) => {
      reasons.push(request.reason ?? '')
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    }, true)
    const result = await call(ctx, 'whatsapp_send_message', { chat_id: unobserved, text: 'ola' })
    if (result.isError) throw new Error('expected success')
    expect(reasons[0]).toBe(`send a WhatsApp message to an unnamed conversation at ${unobserved}: "ola"`)
    expect(scripted.calls[0]).toEqual({ chatId: unobserved, text: 'ola' })
  })

  it('surfaces the provider refusing the destination, after the operator approved it', async () => {
    const { ctx } = await setup({
      providerOverrides: {
        send: () => Promise.reject(new WhatsAppError('no such conversation', 'WHATSAPP_UNKNOWN_CHAT')),
      },
    })
    const agent = agentWithSession('sender-unknown')
    const result = await call(ctx, 'whatsapp_send_message', { chat_id: anaId, text: 'ola' }, { agent })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no such conversation')
    expect(agent.session.events.filter(event => event.type === 'whatsapp/outbound')).toHaveLength(0)
  })

  it('surfaces the account refusing the address before asking the operator anything', async () => {
    const asked: string[] = []
    const { ctx } = await setup()
    ctx.on('approval/request', (request) => {
      asked.push(request.reason ?? '')
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    }, true)
    const result = await call(ctx, 'whatsapp_send_message', { chat_id: 'Ana', text: 'ola' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('names no conversation')
    expect(asked).toEqual([])
  })
})

describe('chat ids are opaque', () => {
  it.each([lidId, '5511999990000@newsletter', '99999@broadcast'])(
    'passes %s through untouched instead of classifying its address space',
    async (chatId) => {
      const { ctx, provider: scripted } = await setup()
      const result = await call(ctx, 'whatsapp_read_chat', { chat_id: chatId })
      expect(result.isError).toBe(false)
      expect(value<ReadChatValue>(result).chat_id).toBe(chatId)
      expect(scripted.calls[0]).toEqual({ chatId, limit: 20 })
    },
  )

  it('leaves an address with no domain to the account, which refuses it', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'whatsapp_mark_read', { chat_id: '5511999990000@' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('names no conversation')
  })

  it('fails before approval when the account is not online', async () => {
    const { ctx } = await setup({
      providerOverrides: {
        resolveChat: () => Promise.reject(new WhatsAppError('the account is not online', 'WHATSAPP_NOT_ONLINE')),
      },
    })
    const result = await call(ctx, 'whatsapp_send_message', { chat_id: anaId, text: 'ola' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('the account is not online')
  })
})

describe('render intent', () => {
  it('presents every WhatsApp call as a generic card naming its chat', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('whatsapp_list_chats')?.presentCall?.({}))
      .toEqual({ card: 'generic', title: 'List WhatsApp chats', kind: 'fetch' })
    expect(ctx.tools.get('whatsapp_list_chats')?.presentCall?.({ unread_only: true }))
      .toEqual({ card: 'generic', title: 'List unread WhatsApp chats', kind: 'fetch' })
    expect(ctx.tools.get('whatsapp_read_chat')?.presentCall?.({ chat_id: anaId }))
      .toEqual({ card: 'generic', title: `Read WhatsApp chat ${anaId}`, kind: 'fetch' })
    expect(ctx.tools.get('whatsapp_mark_read')?.presentCall?.({ chat_id: anaId }))
      .toEqual({ card: 'generic', title: `Mark WhatsApp chat ${anaId} read`, kind: 'other' })
    expect(ctx.tools.get('whatsapp_send_message')?.presentCall?.({ chat_id: anaId, text: 'ola' }))
      .toEqual({ card: 'generic', title: `Send WhatsApp message to ${anaId}`, kind: 'other', rawInput: 'ola' })
  })
})
