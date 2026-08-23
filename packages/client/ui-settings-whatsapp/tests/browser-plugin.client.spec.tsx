// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import z from '@deepseek-ai/schemastery'
import type { RpcResult } from '@deepseek-ai/dsh-client-connection/client'
import { apply, inject, NS, WHATSAPP_WORKSPACE_NS } from '../src/client/index.ts'
import type { WhatsAppSettingsSectionInjected } from '../src/client/index.ts'
import { WhatsAppSettingsSection } from '../src/client/WhatsAppSettingsSection.tsx'
import { WHATSAPP_CHAT_SCOPES, WHATSAPP_CHATS_FIELD } from '../src/workspace-settings.ts'
import { STATUS_ENDPOINT, WHATSAPP_CHANNEL } from '../src/channel.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

type Call = (
  channel: string,
  endpoint: string,
  payload: unknown,
  signal?: AbortSignal,
) => Promise<RpcResult<unknown>>

/** Mount the browser half over a Connection double, a real slot ledger, and the real settings transport. */
async function bench(call: Call, settings: object = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  // The plugin injects `remote`; forwarded settings invalidation reaches the
  // mirror through the same `$dispatch` handoff the connection sink makes.
  new TestRemote(ctx)
  ctx.provide('connection', { rpc: { call }, api: { settings }, isLoopback: true } as never)
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
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

    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'settingsScope'])
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

  it('edits the routing choice through the Workspace settings namespace', async () => {
    const stored = { chats: 'all', revision: 1 }
    // The section the Host serves for this namespace. `node-half.host.spec.ts`
    // proves it is still the slice the Workspace registers.
    const schema = z.object({
      [WHATSAPP_CHATS_FIELD]: z.union([...WHATSAPP_CHAT_SCOPES]),
    }).toJSON()
    const view = () => ({
      ns: WHATSAPP_WORKSPACE_NS,
      schema,
      value: { chats: stored.chats },
      applies: 'live' as const,
      secrets: [],
      revision: stored.revision,
    })
    const settings = {
      describe: vi.fn(() => Promise.resolve({
        rpcId: 'whatsapp-describe' as never,
        result: {
          ok: true as const,
          value: { writable: true, hasDocument: true, namespaces: [view()] },
        },
      })),
      mutate: vi.fn((request: { ns: string; ops: { path: string[]; value?: unknown }[] }) => {
        stored.chats = request.ops[0]?.value as string
        stored.revision += 1
        return Promise.resolve({ rpcId: 'whatsapp-mutate' as never, result: { ok: true as const, value: view() } })
      }),
    }
    const b = await bench(vi.fn<Call>().mockResolvedValue(ONLINE), settings)
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = (b.slots.entries('settings.section')[0]!.inject as unknown as () => WhatsAppSettingsSectionInjected)()

    // One controller identity across renders: a fresh one would drop the
    // subscription the card is rendering from.
    expect(face.conversations).toBe(
      (b.slots.entries('settings.section')[0]!.inject as unknown as () => WhatsAppSettingsSectionInjected)().conversations,
    )
    await vi.waitFor(() => {
      expect(face.conversations.read()).toEqual({ phase: 'ready', chats: 'all', writable: true })
    })

    face.conversations.select('groups')
    await vi.waitFor(() => {
      expect(settings.mutate).toHaveBeenCalledWith(expect.objectContaining({
        ns: WHATSAPP_WORKSPACE_NS,
        ops: [{ op: 'set', path: [WHATSAPP_CHATS_FIELD], value: 'groups' }],
        expectedRevision: 1,
      }))
    })

    // Picking what is already in force writes nothing.
    await vi.waitFor(() => { expect(face.conversations.read().chats).toBe('groups') })
    settings.mutate.mockClear()
    face.conversations.select('groups')
    expect(settings.mutate).not.toHaveBeenCalled()
    await b.ctx.fiber.dispose()
  })

  it('reports no routing choice where the deployment composed no Workspace', async () => {
    const b = await bench(vi.fn<Call>().mockResolvedValue(ONLINE), {
      describe: vi.fn(() => Promise.resolve({
        rpcId: 'whatsapp-describe-empty' as never,
        result: { ok: true as const, value: { writable: true, hasDocument: true, namespaces: [] } },
      })),
    })
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const face = (b.slots.entries('settings.section')[0]!.inject as unknown as () => WhatsAppSettingsSectionInjected)()

    await vi.waitFor(() => { expect(face.conversations.read().phase).toBe('absent') })
    await b.ctx.fiber.dispose()
  })
})
