/**
 * Host loader entry: publish the WhatsApp account's connection state to the
 * loopback browser, so the pairing QR has a home in Settings instead of a side
 * channel of its own.
 *
 * The channel is registered by this package rather than added to the shared
 * `/api` plane on purpose. A `pairing` status carries a credential, and
 * `authority: 'loopback'` pins it to the same fence the rest of the
 * configuration plane uses, declared by the feature that owns the secret.
 * @module @deepseek-ai/dsh-client-ui-settings-whatsapp
 */

import type { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
// Type-only: pulls the Host `ctx.connection` merge into this program.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the `ctx.whatsapp` seam merge into this program.
import type {} from '@deepseek-ai/dsh-whatsapp'
import { STATUS_ENDPOINT, WHATSAPP_CHANNEL } from './channel.ts'

export { decodeWhatsAppStatus, STATUS_ENDPOINT, WHATSAPP_CHANNEL } from './channel.ts'

/** Cordis plugin name. */
export const name = 'client-ui-settings-whatsapp'

/**
 * Required services. `whatsapp` is a real edge: without the seam there is no
 * status to publish, and the channel must not answer with a fabricated one.
 */
export const inject = ['connection', 'whatsapp']

/**
 * Reject an endpoint this channel does not own.
 * @param endpoint - the channel-relative endpoint the browser asked for.
 * @returns the `bad-request` result returned verbatim to the caller.
 */
function unknownEndpoint(endpoint: string): RpcResult<never> {
  return {
    ok: false,
    error: {
      code: 'bad-request',
      message: `unknown whatsapp endpoint ${JSON.stringify(endpoint)}`,
      details: { issues: [] },
    },
  }
}

/**
 * Register the loopback pairing channel; it leaves with this plugin's fiber.
 * @param ctx - Host context carrying the Connection registry and the seam.
 */
export function apply(ctx: Context): void {
  ctx.connection.rpc.handle(
    WHATSAPP_CHANNEL,
    // The payload carries no request fields: `status` is a parameterless read,
    // so the envelope's endpoint match is the whole request validation.
    endpoint => Promise.resolve(
      endpoint === STATUS_ENDPOINT
        ? { ok: true, value: ctx.whatsapp.status() }
        : unknownEndpoint(endpoint),
    ),
    { authority: 'loopback' },
  )
}
