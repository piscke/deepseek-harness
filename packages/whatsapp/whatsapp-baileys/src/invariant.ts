/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-whatsapp-baileys`.
 * @module @deepseek-ai/dsh-whatsapp-baileys/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { WhatsAppStatus } from '@deepseek-ai/dsh-whatsapp'
import { sameStatus } from './status.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-whatsapp-baileys'

/** Cordis companion plugin name. */
export const name = 'whatsapp-baileys-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Watch the status stream this provider owns. A connection reaches `online`
 * only by working through `connecting` or `pairing`, and the provider collapses
 * a transition into the state already reported, so a repeat means a display or
 * a consumer counting reconnections is being told something that did not
 * happen.
 */
const install: InvariantInstaller = (ctx, fail) => {
  let previous: WhatsAppStatus | undefined
  ctx.on('whatsapp/status', (status) => {
    if (previous !== undefined && sameStatus(previous, status)) {
      fail(`whatsapp/status repeated ${status.state} (no-op transition)`)
    }
    if (status.state === 'online' && previous !== undefined && !reachesOnline(previous)) {
      fail(`whatsapp/status reached online from ${previous.state} without connecting`)
    }
    previous = status
  }, { global: true })
}

/** Whether a connection may report `online` directly after this state. */
function reachesOnline(previous: WhatsAppStatus): boolean {
  return previous.state === 'connecting' || previous.state === 'pairing'
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
