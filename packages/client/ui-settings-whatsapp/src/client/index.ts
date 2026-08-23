/**
 * WhatsApp pairing section, browser half. It registers one Settings page that
 * reads the account's connection state over this package's loopback RPC
 * channel and renders the live pairing QR while the account is pairing.
 *
 * The section exists only where the overlay composed this package, so its
 * presence is the capability check: a harness without WhatsApp shows no
 * WhatsApp page rather than an empty one.
 * @module @deepseek-ai/dsh-client-ui-settings-whatsapp/client
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry) and
// the ctx.settingsScope Context merge. Cross-plugin collaboration goes through
// the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.remote Context merge carrying forwarded settings invalidation.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { WhatsAppStatus } from '@deepseek-ai/dsh-whatsapp'
import { decodeWhatsAppStatus, STATUS_ENDPOINT, WHATSAPP_CHANNEL } from '../channel.ts'
import { WhatsAppSettingsSection, type WhatsAppSettingsSectionInjected } from './WhatsAppSettingsSection.tsx'
import { ConversationsController, WHATSAPP_WORKSPACE_NS, type WhatsAppWorkspaceSection } from './conversations.ts'
import { en, zh, type WhatsAppLocaleKey } from './locales.ts'

export type { WhatsAppSettingsSectionInjected, WhatsAppSettingsSectionProps } from './WhatsAppSettingsSection.tsx'
export type { ConversationsCardProps } from './ConversationsCard.tsx'
export type {
  ConversationsState, WhatsAppChatScope, WhatsAppWorkspaceSection,
} from './conversations.ts'
export { ConversationsController, WHATSAPP_WORKSPACE_NS } from './conversations.ts'
export { ConversationsCard } from './ConversationsCard.tsx'
export type { WhatsAppLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** WhatsApp pairing page copy. */
    'settings.whatsapp': WhatsAppLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.whatsapp'

/**
 * Delay between two status reads while the page is open. This is a UI cadence,
 * not a deployment choice: the read returns a process-local field, and the
 * bound that matters is how quickly a rotated code must replace the one a human
 * is pointing a phone at. Nothing polls while the page is closed.
 */
const POLL_INTERVAL_MS = 2_000

/** Nav position, after Models (10) and Plugins (15). */
const SECTION_ORDER = 25

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/**
 * Read one status over the pairing channel.
 * @param connection - the browser Connection handle owning the RPC caller.
 * @param signal - cancellation from the caller's effect teardown.
 * @returns the decoded status.
 * @throws when the channel answered with an error or an unreadable payload.
 */
async function readStatus(connection: ConnectionHandle, signal: AbortSignal): Promise<WhatsAppStatus> {
  const result = await connection.rpc.call(WHATSAPP_CHANNEL, STATUS_ENDPOINT, {}, signal)
  if (!result.ok) {
    throw new Error(`whatsapp ${STATUS_ENDPOINT} failed: ${result.error.code}: ${result.error.message}`)
  }
  const status = decodeWhatsAppStatus(result.value)
  if (status === undefined) {
    throw new Error(`whatsapp ${STATUS_ENDPOINT} returned an unreadable status`)
  }
  return status
}

/**
 * Register the WhatsApp page once the `settings.section` declaration is on the
 * ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-whatsapp: copy dictionaries')

  const connection = ctx.get('connection') as ConnectionHandle
  const t = ctx.locale.bind(NS)
  // One stable identity: the face is rebuilt per render, and a fresh reader
  // each time would restart the poll on every render.
  const read = (signal: AbortSignal): Promise<WhatsAppStatus> => readStatus(connection, signal)
  const conversations = new ConversationsController(
    ctx.settingsScope.bind<WhatsAppWorkspaceSection>({ namespace: WHATSAPP_WORKSPACE_NS }),
  )
  const injected = (): WhatsAppSettingsSectionInjected => ({
    readStatus: read,
    pollIntervalMs: POLL_INTERVAL_MS,
    conversations,
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'whatsapp',
    order: SECTION_ORDER,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, WhatsAppSettingsSection))
}
