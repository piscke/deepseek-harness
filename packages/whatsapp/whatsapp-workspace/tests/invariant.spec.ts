import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as InboundInvariant from '@deepseek-ai/dsh-whatsapp-workspace/invariant'
import type { WhatsAppInboundEvent } from '@deepseek-ai/dsh-whatsapp-workspace'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(InboundInvariant)
  return ctx
}

function event(data: unknown): SessionEvent {
  return { type: 'whatsapp/inbound', seq: 0, time: 0, data } as SessionEvent
}

const valid = {
  messageId: 'M1',
  chatId: '5511999990000@s.whatsapp.net',
  chatKind: 'direct',
  chatName: 'Ana',
  senderId: '5511999990000@s.whatsapp.net',
  senderName: 'Ana',
  timestamp: '2026-08-21T10:00:00.000Z',
  content: { kind: 'text', text: 'oi' },
}

describe('whatsapp/inbound invariants', () => {
  it('accepts a delivered message and ignores unrelated events', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('session/event', {} as Session, event(valid))
      ctx.emit('session/event', {} as Session, event({
        ...valid,
        chatKind: 'group',
        content: { kind: 'unsupported', mediaType: 'image/jpeg' },
      }))
      ctx.emit('session/event', {} as Session, {
        type: 'turn/start', seq: 0, time: 0, data: { turn: 1 },
      })
    }).not.toThrow()
  })

  it.each([
    [{ ...valid, messageId: '' }, /messageId must be a non-empty string/],
    [{ ...valid, chatId: 42 }, /chatId must be a non-empty string/],
    [{ ...valid, senderId: undefined }, /senderId must be a non-empty string/],
    [{ ...valid, timestamp: null }, /timestamp must be a non-empty string/],
    [{ ...valid, chatKind: 'broadcast' }, /unknown chatKind "broadcast"/],
    [{ ...valid, chatKind: 7 }, /unknown chatKind 7/],
    [{ ...valid, content: null }, /content must be an object/],
    [{ ...valid, content: { kind: 'text', text: '' } }, /content\.text must be a non-empty string/],
    [{ ...valid, content: { kind: 'unsupported' } }, /content\.mediaType must be a non-empty string/],
    [{ ...valid, content: { kind: 'sticker' } }, /unknown content kind "sticker"/],
  ])('rejects an incoherent durable inbound record', async (data, message) => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, event(data)) }).toThrow(message)
  })

  it('rejects an invalid stored record on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create().append('whatsapp/inbound', { ...valid, messageId: '' } as WhatsAppInboundEvent)
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(InboundInvariant).then(() => undefined))
      .rejects.toThrow(/messageId must be a non-empty string/)
  })
})
