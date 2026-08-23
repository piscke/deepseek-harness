/**
 * The collaborators the plugin composes its provider from. Kept apart from
 * `index.ts` so the timer, the event publications, and the failure route are
 * exercised without a live WhatsApp connection.
 * @module @deepseek-ai/dsh-whatsapp-baileys/src/deps
 */

import type { Context } from '@deepseek-ai/cordis'
import type { BaileysProviderConfig, BaileysProviderDeps } from './provider.ts'
import type { WhatsAppSocketOpener } from './socket.ts'

/**
 * Compose the provider's collaborators over one fiber.
 * @param ctx - the fiber that publishes the provider's observations.
 * @param open - opens one connection.
 * @param forgetPairing - discards the stored pairing after a logged-out close.
 * @param config - the provider's connection-keeping behavior.
 * @returns the collaborators a {@link BaileysProvider} runs on.
 */
export function providerDeps(
  ctx: Context,
  open: WhatsAppSocketOpener,
  forgetPairing: () => Promise<void>,
  config: BaileysProviderConfig,
): BaileysProviderDeps {
  return {
    open,
    forgetPairing,
    onStatus: (status) => { ctx.emit('whatsapp/status', status) },
    onMessage: (message) => { ctx.emit('whatsapp/message-received', message) },
    onChatNamed: (chatId, name) => { ctx.emit('whatsapp/chat-named', chatId, name) },
    onNameFailure: (chatId, error) => {
      ctx.logger.warn(`whatsapp-baileys: could not read the subject of group ${chatId}: ${String(error)}`)
    },
    onFatal: (error) => { ctx.logger.error(error) },
    setTimer: (callback, delay) => {
      // `.unref()` so a pending reconnection never keeps the process alive.
      const timer = setTimeout(callback, delay)
      timer.unref()
      return () => {
        clearTimeout(timer)
      }
    },
    config,
  }
}
