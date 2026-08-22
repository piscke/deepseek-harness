// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { apply, inject, NS } from '../src/client/index.ts'
import type { WhatsAppSettingsSectionInjected } from '../src/client/index.ts'
import { WhatsAppSettingsSection } from '../src/client/WhatsAppSettingsSection.tsx'
import { STATUS_ENDPOINT, WHATSAPP_CHANNEL } from '../src/channel.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

type Call = (
  channel: string,
  endpoint: string,
  payload: unknown,
  signal?: AbortSignal,
) => Promise<RpcResult<unknown>>

/** Mount the browser half over a Connection double and a real slot ledger. */
async function bench(call: Call) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  ctx.provide('connection', { rpc: { call } })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

const ONLINE: RpcResult<unknown> = { ok: true, value: { state: 'online', accountId: 'a@b' } }

describe('ui-settings-whatsapp browser plugin', () => {
  it('registers a localized settings page without reading the channel eagerly', async () => {
    const call = vi.fn<Call>().mockResolvedValue(ONLINE)
    const b = await bench(call)
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    expect(inject).toEqual(['slots', 'locale', 'connection'])
    const entry = b.slots.entries('settings.section')[0]!
    expect(entry.component).toBe(WhatsAppSettingsSection)
    expect(entry.options).toMatchObject({ id: 'whatsapp', order: 25 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('WhatsApp')
    expect(call).not.toHaveBeenCalled()

    const face = entry.inject as unknown as () => WhatsAppSettingsSectionInjected
    expect(face().pollIntervalMs).toBeGreaterThan(0)
    // One reader identity across renders: a fresh one would restart the poll.
    expect(face().readStatus).toBe(face().readStatus)

    const signal = new AbortController().signal
    await expect(face().readStatus(signal)).resolves.toEqual({ state: 'online', accountId: 'a@b' })
    expect(call).toHaveBeenCalledWith(WHATSAPP_CHANNEL, STATUS_ENDPOINT, {}, signal)
    await b.ctx.fiber.dispose()
  })

  it('reports a channel error and an unreadable payload as failures', async () => {
    const call = vi.fn<Call>()
      .mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'seam gone', details: {} } as never })
      .mockResolvedValueOnce({ ok: true, value: { state: 'reconnecting' } })
    const b = await bench(call)
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = (b.slots.entries('settings.section')[0]!.inject as unknown as () => WhatsAppSettingsSectionInjected)()
    const signal = new AbortController().signal

    await expect(face.readStatus(signal)).rejects.toThrow('whatsapp status failed: internal: seam gone')
    await expect(face.readStatus(signal)).rejects.toThrow('whatsapp status returned an unreadable status')
    await b.ctx.fiber.dispose()
  })

  it('follows locale and leaves with its fiber', async () => {
    const b = await bench(vi.fn<Call>().mockResolvedValue(ONLINE))
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('settings.section')).toHaveLength(0)

    declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.section')).toHaveLength(1) })
    b.locale.setLocale('en')
    expect(resolveSlotLabel(b.slots.entries('settings.section')[0]!.options.label)).toBe('WhatsApp')

    await fiber.dispose()
    expect(b.slots.entries('settings.section')).toHaveLength(0)
    await b.ctx.fiber.dispose()
  })
})
