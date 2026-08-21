import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as OutboundInvariant from '@deepseek-ai/dsh-tool-whatsapp/invariant'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(OutboundInvariant)
  return ctx
}

function event(data: unknown): SessionEvent {
  return { type: 'whatsapp/outbound', seq: 0, time: 0, data } as SessionEvent
}

const valid = {
  messageId: 'OUT1',
  chatId: '5511999990000@s.whatsapp.net',
  chatName: 'Ana',
  text: 'ola',
  timestamp: '2026-08-21T11:00:00.000Z',
}

describe('whatsapp/outbound invariants', () => {
  it('accepts an acknowledged send and ignores unrelated events', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('session/event', {} as Session, event(valid))
      ctx.emit('tools/change')
      ctx.emit('session/event', {} as Session, {
        type: 'turn/start', seq: 0, time: 0, data: { turn: 1 },
      })
    }).not.toThrow()
  })

  it.each([
    [{ ...valid, messageId: '' }, /messageId must be a non-empty string/],
    [{ ...valid, chatId: 42 }, /chatId must be a non-empty string/],
    [{ ...valid, timestamp: undefined }, /timestamp must be a non-empty string/],
    [{ ...valid, text: '   ' }, /text must carry a non-whitespace body/],
    [{ ...valid, text: 7 }, /text must carry a non-whitespace body/],
  ])('rejects an incoherent durable send record', async (data, message) => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', {} as Session, event(data)) }).toThrow(message)
  })

  it('rejects an invalid stored record on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create().append('whatsapp/outbound', { ...valid, text: '' })
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(OutboundInvariant).then(() => undefined))
      .rejects.toThrow(/text must carry a non-whitespace body/)
  })
})
