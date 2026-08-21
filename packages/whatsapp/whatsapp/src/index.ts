/**
 * Service Definition for the WhatsApp capability seam (`ctx.whatsapp`): one
 * registered provider, the operations a consumer performs against a connected
 * account, and the events the account produces. A registration owns a specific
 * authenticated account, so the seam holds exactly one provider and rejects a
 * second instead of choosing between accounts.
 * @module @deepseek-ai/dsh-whatsapp
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  WhatsAppChat,
  WhatsAppHistoryRequest,
  WhatsAppMessage,
  WhatsAppProvider,
  WhatsAppSendRequest,
  WhatsAppSentMessage,
  WhatsAppStatus,
} from './types.ts'
import { WhatsAppError } from './types.ts'
import type { WhatsAppChatId } from './brand.ts'

export {
  WhatsAppChatId,
  WhatsAppMessageId,
} from './brand.ts'
export {
  WhatsAppError,
} from './types.ts'
export type {
  WhatsAppChat,
  WhatsAppChatKind,
  WhatsAppContent,
  WhatsAppHistoryRequest,
  WhatsAppMessage,
  WhatsAppProvider,
  WhatsAppSendRequest,
  WhatsAppSentMessage,
  WhatsAppStatus,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    whatsapp: WhatsAppRuntime
  }
}

/**
 * The WhatsApp access service. Registered as `ctx.whatsapp` (one instance per
 * context).
 *
 * Every operation resolves the provider at call time and rejects when the
 * capability cannot run:
 * - no provider registered → `WHATSAPP_PROVIDER_UNAVAILABLE`.
 * - a registered provider whose account is not `online` → `WHATSAPP_NOT_ONLINE`.
 *
 * The provider emits `whatsapp/status` and `whatsapp/message-received`; this
 * service emits `whatsapp/message-sent` after a send it dispatched is
 * acknowledged, so an outbound acknowledgement exists even for a provider that
 * observes no echo of its own traffic.
 */
export class WhatsAppRuntime extends Service {
  private provider: WhatsAppProvider | undefined

  constructor(ctx: Context) {
    super(ctx, 'whatsapp')
  }

  /**
   * Register the sole provider. Throws {@link WhatsAppError}
   * `WHATSAPP_PROVIDER_ALREADY_REGISTERED` while another registration is live.
   * Returns a disposer; disposed with the calling fiber.
   * @param provider - the backend owning one authenticated account.
   * @returns the disposer that unregisters the provider.
   */
  register(provider: WhatsAppProvider): () => void {
    if (this.provider !== undefined) {
      throw new WhatsAppError(
        `a WhatsApp provider ("${this.provider.id}") is already registered; one account per seam`,
        'WHATSAPP_PROVIDER_ALREADY_REGISTERED',
      )
    }
    const dispose = this.ctx.effect(function* (this: WhatsAppRuntime) {
      this.provider = provider
      yield () => {
        this.provider = undefined
      }
    }.bind(this), 'whatsapp.register()')
    // ctx.effect's disposer returns Promise<void>; this disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  /**
   * Current connection state of the registered account.
   * @returns the provider's state, or `offline` while no provider is registered.
   */
  status(): WhatsAppStatus {
    return this.provider?.status() ?? { state: 'offline' }
  }

  /**
   * List the conversations the connected account knows about.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the known conversations in provider order.
   */
  async listChats(signal?: AbortSignal): Promise<readonly WhatsAppChat[]> {
    return this.requireOnline().listChats(signal)
  }

  /**
   * Read one page of a chat's history, newest first.
   * @param request - the chat, an optional positive-integer `limit`, and an optional paging cursor.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the page the provider retained for that chat.
   */
  async fetchMessages(request: WhatsAppHistoryRequest, signal?: AbortSignal): Promise<readonly WhatsAppMessage[]> {
    assertLimit(request.limit)
    return this.requireOnline().fetchMessages(request, signal)
  }

  /**
   * Send one text message and announce the acknowledgement on
   * `whatsapp/message-sent`. A rejected send emits nothing.
   * @param request - the target chat, the non-empty body, and an optional quoted message.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the acknowledged message identity and send time.
   */
  async send(request: WhatsAppSendRequest, signal?: AbortSignal): Promise<WhatsAppSentMessage> {
    if (request.text.trim() === '') {
      throw new WhatsAppError('a WhatsApp message must carry text', 'WHATSAPP_EMPTY_MESSAGE')
    }
    const sent = await this.requireOnline().send(request, signal)
    this.ctx.emit('whatsapp/message-sent', sent)
    return sent
  }

  /**
   * Mark one chat read up to its newest message.
   * @param chatId - the conversation to mark.
   * @param signal - optional cancellation signal forwarded to the provider.
   */
  async markRead(chatId: WhatsAppChatId, signal?: AbortSignal): Promise<void> {
    return this.requireOnline().markRead(chatId, signal)
  }

  /** Resolve the provider or throw the matching {@link WhatsAppError}. */
  private requireOnline(): WhatsAppProvider {
    const { provider } = this
    if (provider === undefined) {
      throw new WhatsAppError('no WhatsApp provider is registered', 'WHATSAPP_PROVIDER_UNAVAILABLE')
    }
    const status = provider.status()
    if (status.state !== 'online') {
      throw new WhatsAppError(
        `the WhatsApp account is ${status.state}, not online`,
        'WHATSAPP_NOT_ONLINE',
      )
    }
    return provider
  }
}

/** A history page size must be a positive integer when the caller supplies one. */
function assertLimit(limit: number | undefined): void {
  if (limit === undefined) return
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new WhatsAppError(`history limit must be a positive integer, got ${limit}`, 'WHATSAPP_INVALID_LIMIT')
  }
}

export default WhatsAppRuntime
