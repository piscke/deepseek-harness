import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import type {} from '@deepseek-ai/dsh-whatsapp'
import * as WhatsAppBaileysInvariant from '@deepseek-ai/dsh-whatsapp-baileys/invariant'

/** Mount the invariant registry and this package's companion. */
async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(WhatsAppBaileysInvariant)
  return ctx
}

describe('whatsapp status invariants', () => {
  it('accepts a pairing connection that comes online and drops', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('whatsapp/status', { state: 'connecting' })
      ctx.emit('whatsapp/status', { state: 'pairing', qr: 'QR-1' })
      ctx.emit('whatsapp/status', { state: 'pairing', qr: 'QR-2' })
      ctx.emit('whatsapp/status', { state: 'online', accountId: '5511888880000' })
      ctx.emit('whatsapp/status', { state: 'offline' })
    }).not.toThrow()
  })

  it('rejects a repeated state', async () => {
    const ctx = await setup()
    ctx.emit('whatsapp/status', { state: 'connecting' })
    expect(() => { ctx.emit('whatsapp/status', { state: 'connecting' }) }).toThrow(/no-op transition/)
  })

  it('rejects a repeated pairing payload', async () => {
    const ctx = await setup()
    ctx.emit('whatsapp/status', { state: 'pairing', qr: 'QR-1' })
    expect(() => { ctx.emit('whatsapp/status', { state: 'pairing', qr: 'QR-1' }) }).toThrow(/no-op transition/)
  })

  it('rejects reaching online without connecting', async () => {
    const ctx = await setup()
    ctx.emit('whatsapp/status', { state: 'offline' })
    expect(() => { ctx.emit('whatsapp/status', { state: 'online', accountId: '5511888880000' }) })
      .toThrow(/reached online from offline/)
  })

  it('accepts the first status a fiber reports', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('whatsapp/status', { state: 'online', accountId: '5511888880000' }) }).not.toThrow()
  })

  it('rejects an account swap that never reconnected', async () => {
    const ctx = await setup()
    ctx.emit('whatsapp/status', { state: 'connecting' })
    ctx.emit('whatsapp/status', { state: 'online', accountId: 'a' })
    expect(() => { ctx.emit('whatsapp/status', { state: 'online', accountId: 'b' }) })
      .toThrow(/reached online from online/)
  })

  it('distinguishes one logout reason from the next', async () => {
    const ctx = await setup()
    ctx.emit('whatsapp/status', { state: 'logged-out', reason: 'device removed' })
    expect(() => { ctx.emit('whatsapp/status', { state: 'logged-out', reason: 'session replaced' }) })
      .not.toThrow()
  })
})
