// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WhatsAppStatus } from '@deepseek-ai/dsh-whatsapp'
import { WhatsAppSettingsSection, StatusCard } from '../src/client/WhatsAppSettingsSection.tsx'
import type { WhatsAppSettingsSectionProps } from '../src/client/WhatsAppSettingsSection.tsx'
import type { ConversationsController } from '../src/client/conversations.ts'
import { en, type WhatsAppLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: WhatsAppLocaleKey): string => en[key]) as WhatsAppSettingsSectionProps['t']

/** A Workspace that serves no routing choice, so the section shows the pairing card alone. */
const absent = { phase: 'absent' as const, chats: 'all' as const, writable: false }
const noConversations = {
  read: () => absent,
  subscribe: () => () => {},
  select: () => {},
} as unknown as ConversationsController

function props(
  readStatus: WhatsAppSettingsSectionProps['readStatus'],
  pollIntervalMs = 2_000,
): WhatsAppSettingsSectionProps {
  return { t, readStatus, pollIntervalMs, conversations: noConversations } as WhatsAppSettingsSectionProps
}

function state(container: HTMLElement): string | null {
  return container.querySelector('[data-whatsapp-state]')?.getAttribute('data-whatsapp-state') ?? null
}

describe('WhatsAppSettingsSection', () => {
  it('shows the loading copy until the first read settles', async () => {
    const deferred = Promise.withResolvers<WhatsAppStatus>()
    const view = render(<WhatsAppSettingsSection {...props(() => deferred.promise)} />)
    expect(screen.getByText(en.loading)).toBeTruthy()
    expect(view.container.firstElementChild?.getAttribute('aria-busy')).toBe('true')

    await act(async () => { deferred.resolve({ state: 'offline' }) })
    expect(state(view.container)).toBe('offline')
    expect(screen.getByText(en.offlineBody)).toBeTruthy()
  })

  it('renders the pairing code with its warning', async () => {
    const view = render(<WhatsAppSettingsSection
      {...props(() => Promise.resolve({ state: 'pairing', qr: '2@fixture-code' }))}
    />)
    await waitFor(() => { expect(state(view.container)).toBe('pairing') })
    expect(screen.getByRole('heading', { name: en.pairingTitle })).toBeTruthy()
    expect(screen.getByRole('img', { name: en.qrLabel })).toBeTruthy()
    expect(view.container.querySelector('[data-whatsapp-qr]')).toBeTruthy()
    expect(screen.getByText(en.pairingRotates)).toBeTruthy()
    expect(screen.getByText(en.pairingWarning)).toBeTruthy()
  })

  it('names the account when the provider reported one', async () => {
    const view = render(<WhatsAppSettingsSection
      {...props(() => Promise.resolve({ state: 'online', accountId: '55119@s.whatsapp.net' }))}
    />)
    await waitFor(() => { expect(state(view.container)).toBe('online') })
    expect(view.container.querySelector('[data-whatsapp-account]')?.textContent).toBe('55119@s.whatsapp.net')
  })

  it('says so when the provider reported no account name', async () => {
    const view = render(<WhatsAppSettingsSection {...props(() => Promise.resolve({ state: 'online' }))} />)
    await waitFor(() => { expect(state(view.container)).toBe('online') })
    expect(screen.getByText(en.onlineUnknownAccount)).toBeTruthy()
    expect(view.container.querySelector('[data-whatsapp-account]')).toBeNull()
  })

  it('renders the connecting and logged-out arms', async () => {
    const connecting = render(<WhatsAppSettingsSection
      {...props(() => Promise.resolve({ state: 'connecting' }))}
    />)
    await waitFor(() => { expect(state(connecting.container)).toBe('connecting') })
    expect(screen.getByText(en.connectingBody)).toBeTruthy()
    cleanup()

    const out = render(<WhatsAppSettingsSection
      {...props(() => Promise.resolve({ state: 'logged-out', reason: 'device removed' }))}
    />)
    await waitFor(() => { expect(state(out.container)).toBe('logged-out') })
    expect(out.container.querySelector('[data-whatsapp-reason]')?.textContent).toBe('device removed')
  })

  it('refuses to render a state it does not know', () => {
    const rogue = { state: 'reconnecting' } as unknown as WhatsAppStatus
    expect(() => StatusCard({ status: rogue, t })).toThrow(
      'unhandled WhatsApp status: {"state":"reconnecting"}',
    )
  })

  it('drops a read that settles after the section left', async () => {
    vi.useFakeTimers()
    try {
      const deferred = Promise.withResolvers<WhatsAppStatus>()
      render(<WhatsAppSettingsSection {...props(() => deferred.promise)} />)
      await act(async () => {})
      cleanup()
      await act(async () => { deferred.resolve({ state: 'offline' }) })
      expect(vi.getTimerCount()).toBe(0)
      expect(screen.queryByText(en.offlineBody)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-reads on the poll cadence and stops on unmount', async () => {
    vi.useFakeTimers()
    try {
      const readings: WhatsAppStatus[] = [
        { state: 'connecting' },
        { state: 'pairing', qr: '2@first' },
        { state: 'online', accountId: 'a@b' },
      ]
      let call = 0
      const readStatus = vi.fn<(signal: AbortSignal) => Promise<WhatsAppStatus>>(
        () => Promise.resolve(readings[Math.min(call++, readings.length - 1)]!),
      )
      const view = render(<WhatsAppSettingsSection {...props(readStatus, 1_000)} />)
      await act(async () => {})
      expect(state(view.container)).toBe('connecting')

      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      expect(state(view.container)).toBe('pairing')
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      expect(state(view.container)).toBe('online')

      const settled = readStatus.mock.calls.length
      cleanup()
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(readStatus).toHaveBeenCalledTimes(settled)
      expect(readStatus.mock.calls[0]![0].aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers a retry after a failed read and keeps polling meanwhile', async () => {
    vi.useFakeTimers()
    try {
      const readStatus = vi.fn<(signal: AbortSignal) => Promise<WhatsAppStatus>>()
        .mockRejectedValueOnce(new Error('channel gone'))
        .mockResolvedValue({ state: 'offline' })
      const view = render(<WhatsAppSettingsSection {...props(readStatus, 1_000)} />)
      await act(async () => {})
      expect(screen.getByRole('alert').textContent).toBe(en.error)

      fireEvent.click(screen.getByRole('button', { name: en.retry }))
      expect(screen.getByText(en.loading)).toBeTruthy()
      await act(async () => {})
      expect(state(view.container)).toBe('offline')
    } finally {
      vi.useRealTimers()
    }
  })
})
