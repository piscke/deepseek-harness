/**
 * Wire vocabulary of the pairing channel, shared by this package's two halves.
 * The Host half answers on it; the browser half calls it and decodes what came
 * back. Both names live here so the channel cannot drift between the halves.
 * @module @deepseek-ai/dsh-client-ui-settings-whatsapp/src/channel
 */

import type { WhatsAppStatus } from '@deepseek-ai/dsh-whatsapp'

/**
 * Absolute Connection RPC channel owned by this package. Registered with
 * `authority: 'loopback'`, because a `pairing` payload is a credential: whoever
 * scans it links a device with full access to the account.
 */
export const WHATSAPP_CHANNEL = '/whatsapp'

/** The channel's only endpoint: read the account's current connection state. */
export const STATUS_ENDPOINT = 'status'

/**
 * Decode one `status` response received over the wire.
 *
 * The browser cannot trust the JSON it parsed to still match the union the Host
 * compiled against, so every arm is reconstructed field by field and anything
 * else is rejected rather than rendered.
 * @param value - the decoded JSON `value` of a successful RPC result.
 * @returns the status when the payload matches an arm, otherwise `undefined`.
 */
export function decodeWhatsAppStatus(value: unknown): WhatsAppStatus | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const { state } = record
  if (state === 'offline' || state === 'connecting') return { state }
  if (state === 'pairing') {
    return typeof record.qr === 'string' && record.qr.length > 0 ? { state, qr: record.qr } : undefined
  }
  if (state === 'online') {
    if (record.accountId === undefined) return { state }
    return typeof record.accountId === 'string' ? { state, accountId: record.accountId } : undefined
  }
  if (state === 'logged-out') {
    return typeof record.reason === 'string' ? { state, reason: record.reason } : undefined
  }
  return undefined
}
