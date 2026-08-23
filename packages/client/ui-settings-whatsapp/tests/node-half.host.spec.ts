import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type {
  ConnectionRpcHandler,
  ConnectionRpcHandlerOptions,
  HostConnectionHandle,
} from '@deepseek-ai/dsh-client-connection'
import type { WhatsAppStatus } from '@deepseek-ai/dsh-whatsapp'
import {
  WHATSAPP_WORKSPACE_SETTINGS_NAMESPACE,
  WhatsAppWorkspaceSettings,
} from '@deepseek-ai/dsh-whatsapp-workspace'
import { apply, decodeWhatsAppStatus, inject, name, STATUS_ENDPOINT, WHATSAPP_CHANNEL } from '../src/index.ts'
import {
  WHATSAPP_CHAT_SCOPES,
  WHATSAPP_CHATS_FIELD,
  WHATSAPP_WORKSPACE_NS,
} from '../src/workspace-settings.ts'

interface Registration {
  readonly channel: string
  readonly handler: ConnectionRpcHandler
  readonly options: ConnectionRpcHandlerOptions
}

/**
 * Mount the node half over doubles for the two services it injects.
 * @param status - the status the seam reports on every read.
 * @returns the sole channel registration plus the seam spy.
 */
async function mount(status: WhatsAppStatus): Promise<{ registration: Registration; read: () => number }> {
  const ctx = new Context()
  const registrations: Registration[] = []
  const connection: HostConnectionHandle = {
    rpc: {
      handle: (channel, handler, options) => {
        registrations.push({ channel, handler, options })
        return () => Promise.resolve()
      },
      intercept: () => () => Promise.resolve(),
    },
  }
  const statusSpy = vi.fn<() => WhatsAppStatus>(() => status)
  ctx.provide('connection', connection)
  ctx.provide('whatsapp', { status: statusSpy })
  await ctx.plugin({ name, inject: [...inject], apply }).await()
  return { registration: registrations[0]!, read: () => statusSpy.mock.calls.length }
}

describe('whatsapp pairing channel', () => {
  it('registers one loopback channel and waits for the seam', async () => {
    expect(inject).toEqual(['connection', 'whatsapp'])
    const { registration, read } = await mount({ state: 'offline' })
    expect(registration.channel).toBe(WHATSAPP_CHANNEL)
    expect(registration.options).toEqual({ authority: 'loopback' })
    // Registration alone must not read the account.
    expect(read()).toBe(0)
  })

  it('answers status with the seam reading of the moment', async () => {
    const { registration, read } = await mount({ state: 'pairing', qr: '2@code' })
    const signal = new AbortController().signal
    await expect(registration.handler(STATUS_ENDPOINT, {}, signal))
      .resolves.toEqual({ ok: true, value: { state: 'pairing', qr: '2@code' } })
    await registration.handler(STATUS_ENDPOINT, {}, signal)
    expect(read()).toBe(2)
  })

  it('rejects an endpoint this channel does not own', async () => {
    const { registration, read } = await mount({ state: 'online' })
    await expect(registration.handler('unlink', {}, new AbortController().signal)).resolves.toEqual({
      ok: false,
      error: {
        code: 'bad-request',
        message: 'unknown whatsapp endpoint "unlink"',
        details: { issues: [] },
      },
    })
    expect(read()).toBe(0)
  })
})

describe('decodeWhatsAppStatus', () => {
  it.each<[string, unknown, WhatsAppStatus]>([
    ['offline', { state: 'offline' }, { state: 'offline' }],
    ['connecting', { state: 'connecting' }, { state: 'connecting' }],
    ['pairing', { state: 'pairing', qr: '2@code' }, { state: 'pairing', qr: '2@code' }],
    ['online without an account', { state: 'online' }, { state: 'online' }],
    ['online with an account', { state: 'online', accountId: 'a@b' }, { state: 'online', accountId: 'a@b' }],
    ['logged-out', { state: 'logged-out', reason: 'gone' }, { state: 'logged-out', reason: 'gone' }],
  ])('accepts %s', (_label, wire, expected) => {
    expect(decodeWhatsAppStatus(wire)).toEqual(expected)
  })

  it.each<[string, unknown]>([
    ['a non-object', 'offline'],
    ['null', null],
    ['an unknown state', { state: 'reconnecting' }],
    ['a missing state', {}],
    ['pairing without a code', { state: 'pairing' }],
    ['pairing with an empty code', { state: 'pairing', qr: '' }],
    ['online with a non-string account', { state: 'online', accountId: 7 }],
    ['logged-out without a reason', { state: 'logged-out' }],
  ])('rejects %s', (_label, wire) => {
    expect(decodeWhatsAppStatus(wire)).toBeUndefined()
  })
})

describe('the Workspace settings section this page edits', () => {
  it('names the section the Workspace registers', () => {
    expect(WHATSAPP_WORKSPACE_NS).toBe(WHATSAPP_WORKSPACE_SETTINGS_NAMESPACE)
    expect(Object.keys(WhatsAppWorkspaceSettings.dict ?? {})).toContain(WHATSAPP_CHATS_FIELD)
  })

  it('offers every value that field accepts, and no other', () => {
    const chats = WhatsAppWorkspaceSettings.dict?.[WHATSAPP_CHATS_FIELD]
    expect(chats?.list?.map((arm): unknown => arm.value)).toEqual([...WHATSAPP_CHAT_SCOPES])
  })
})
