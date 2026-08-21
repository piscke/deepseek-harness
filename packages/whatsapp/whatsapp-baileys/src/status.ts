/**
 * Status comparison shared by the provider's transition collapsing and its
 * invariant companion, which must agree on what counts as a repeat.
 * @module @deepseek-ai/dsh-whatsapp-baileys/src/status
 */

import type { WhatsAppStatus } from '@deepseek-ai/dsh-whatsapp'

/**
 * Whether two status values report the same thing.
 * @param left - the previously reported status.
 * @param right - the status about to be reported.
 * @returns true when both the state and its payload are equal, so reporting
 * `right` after `left` would tell a consumer about a change that did not occur.
 */
export function sameStatus(left: WhatsAppStatus, right: WhatsAppStatus): boolean {
  if (left.state !== right.state) return false
  if (left.state === 'pairing' && right.state === 'pairing') return left.qr === right.qr
  if (left.state === 'online' && right.state === 'online') return left.accountId === right.accountId
  if (left.state === 'logged-out' && right.state === 'logged-out') return left.reason === right.reason
  return true
}
