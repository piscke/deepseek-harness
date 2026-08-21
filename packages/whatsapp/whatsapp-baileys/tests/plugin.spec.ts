import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WhatsAppRuntime from '@deepseek-ai/dsh-whatsapp'
import type { WhatsAppStatus } from '@deepseek-ai/dsh-whatsapp'
import * as baileys from '@deepseek-ai/dsh-whatsapp-baileys'
import type { Config } from '@deepseek-ai/dsh-whatsapp-baileys'

/** A specifier no deployment can resolve, so no test reaches a real library. */
const ABSENT_LIBRARY = './tests/no-such-whatsapp-library.js'

/** Mount the seam and this provider, capturing the status stream and log. */
async function mount(config: Partial<Config> = {}): Promise<{
  ctx: Context
  unload: () => Promise<void>
  statuses: WhatsAppStatus[]
  logged: unknown[]
}> {
  const ctx = new Context()
  const statuses: WhatsAppStatus[] = []
  const logged: unknown[] = []
  vi.spyOn(ctx.logger, 'error').mockImplementation((error) => {
    logged.push(error)
  })
  ctx.on('whatsapp/status', status => statuses.push(status))
  await ctx.plugin(WhatsAppRuntime)
  const fork = await ctx.plugin(baileys, { moduleSpecifier: ABSENT_LIBRARY, ...config })
  return { ctx, unload: async () => { await fork.dispose() }, statuses, logged }
}

describe('config validation', () => {
  it.each([
    ['reconnectDelay', { reconnectDelay: 0 }],
    ['reconnectDelay', { reconnectDelay: Number.POSITIVE_INFINITY }],
    ['historyPerChat', { historyPerChat: -1 }],
    ['maxReconnectAttempts', { maxReconnectAttempts: 1.5 }],
  ])('refuses a %s that disables the behavior it names', async (field, config: Partial<Config>) => {
    await expect(mount(config)).rejects.toThrow(new RegExp(`whatsapp-baileys: ${field}`))
  })

  it('accepts a zero retry budget, which never reconnects', async () => {
    await expect(mount({ maxReconnectAttempts: 0 })).resolves.toBeDefined()
  })
})

describe('registration', () => {
  it('registers the provider with the seam and withdraws it on disposal', async () => {
    const { ctx, unload } = await mount()
    expect(ctx.whatsapp.status()).not.toEqual({ state: 'offline' })
    await unload()
    expect(ctx.whatsapp.status()).toEqual({ state: 'offline' })
  })

  it('publishes the connection attempt as a harness event', async () => {
    const { statuses } = await mount()
    expect(statuses[0]).toEqual({ state: 'connecting' })
  })

  it('reports an absent library through the logger instead of failing the load', async () => {
    const { logged } = await mount()
    await vi.waitFor(() => { expect(logged).toHaveLength(1) })
    expect(logged[0]).toMatchObject({ code: 'WHATSAPP_BAILEYS_MISSING' })
  })

  it('stops reporting once the plugin is unloaded', async () => {
    const { unload, statuses } = await mount()
    await unload()
    expect(statuses.at(-1)).toEqual({ state: 'offline' })
  })
})
