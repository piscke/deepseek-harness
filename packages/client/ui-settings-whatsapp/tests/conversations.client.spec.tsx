// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationsCard } from '../src/client/ConversationsCard.tsx'
import { ConversationsController, type WhatsAppWorkspaceSection } from '../src/client/conversations.ts'
import { en, type WhatsAppLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: WhatsAppLocaleKey): string => en[key]

/** One settings scope a test drives by hand, standing for the Host document. */
interface Fake {
  scope: SettingsScope<WhatsAppWorkspaceSection>
  /** Replace the served snapshot and notify, as an accepted Host view does. */
  publish(next: Partial<SettingsScopeSnapshot<WhatsAppWorkspaceSection>>): void
  /** Every `(field, value)` the card wrote. */
  writes: [string, unknown][]
}

function fake(initial: Partial<SettingsScopeSnapshot<WhatsAppWorkspaceSection>> = {}): Fake {
  const listeners = new Set<() => void>()
  const writes: [string, unknown][] = []
  let snapshot: SettingsScopeSnapshot<WhatsAppWorkspaceSection> = {
    status: 'ready',
    value: { chats: 'all' },
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host',
    ...initial,
  }
  return {
    writes,
    publish: (next) => {
      snapshot = { ...snapshot, ...next }
      for (const listener of listeners) listener()
    },
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      set: (field, value) => {
        writes.push([field, value])
        return Promise.resolve()
      },
      unset: () => Promise.resolve(),
    },
  }
}

function scopeOf(container: HTMLElement): string | null {
  return container.querySelector('[data-whatsapp-chats]')?.getAttribute('data-whatsapp-chats') ?? null
}

describe('ConversationsCard', () => {
  it('shows the routed conversations and writes the one the user picks', () => {
    const host = fake()
    const view = render(<ConversationsCard t={t} conversations={new ConversationsController(host.scope)} />)

    expect(scopeOf(view.container)).toBe('all')
    expect(screen.getByRole('radio', { name: en.chatsAll }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(en.chatsBody)).toBeTruthy()

    fireEvent.click(screen.getByRole('radio', { name: en.chatsGroups }))
    expect(host.writes).toEqual([['chats', 'groups']])

    // The card renders what the Host accepted, not what was clicked.
    expect(scopeOf(view.container)).toBe('all')
    act(() => { host.publish({ value: { chats: 'groups' } }) })
    expect(scopeOf(view.container)).toBe('groups')
    expect(screen.getByRole('radio', { name: en.chatsGroups }).getAttribute('aria-checked')).toBe('true')
  })

  it('writes nothing when the user picks what is already routed', () => {
    const host = fake({ value: { chats: 'contacts' } })
    render(<ConversationsCard t={t} conversations={new ConversationsController(host.scope)} />)

    fireEvent.click(screen.getByRole('radio', { name: en.chatsContacts }))
    expect(host.writes).toEqual([])
  })

  it('renders nothing where no Workspace serves the namespace', () => {
    const host = fake({ status: 'unavailable', value: undefined, writable: false })
    const view = render(<ConversationsCard t={t} conversations={new ConversationsController(host.scope)} />)
    expect(view.container.firstElementChild).toBeNull()

    // A Workspace that loads later brings the card with it.
    act(() => { host.publish({ status: 'ready', value: { chats: 'groups' }, writable: true }) })
    expect(scopeOf(view.container)).toBe('groups')
  })

  it('shows the deployment default while the first section is still loading', () => {
    const host = fake({ status: 'loading', value: undefined })
    const view = render(<ConversationsCard t={t} conversations={new ConversationsController(host.scope)} />)

    expect(scopeOf(view.container)).toBe('all')
    const option = screen.getByRole('radio', { name: en.chatsGroups })
    expect((option as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(option)
    expect(host.writes).toEqual([])
  })

  it('says why the choice cannot be changed on a page that stores no preferences', () => {
    const host = fake({ writable: false, mode: 'memory' })
    render(<ConversationsCard t={t} conversations={new ConversationsController(host.scope)} />)

    expect(screen.getByText(en.chatsReadOnly)).toBeTruthy()
    expect(screen.getByRole('radio', { name: en.chatsGroups })).toHaveProperty('disabled', true)
  })

  it('ignores a Host view that changed nothing this card renders', () => {
    const host = fake()
    const controller = new ConversationsController(host.scope)
    const view = render(<ConversationsCard t={t} conversations={controller} />)
    const before = controller.read()

    act(() => { host.publish({ revision: 2 }) })
    expect(controller.read()).toBe(before)
    expect(scopeOf(view.container)).toBe('all')
  })
})
