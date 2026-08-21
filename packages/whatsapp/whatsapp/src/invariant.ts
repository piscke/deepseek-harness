/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-whatsapp`.
 * @module @deepseek-ai/dsh-whatsapp/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-whatsapp'

/** Cordis companion plugin name. */
export const name = 'whatsapp-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the provider slot is private, connection state is read
 * from the provider on each call, and the seam owns no durable record or
 * independent observation stream to replay.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
