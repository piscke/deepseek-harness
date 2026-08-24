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
import { OutboundEchoes } from './echoes.ts'
import type { WhatsAppChatId } from './brand.ts'

export {
  OutboundEchoes,
} from './echoes.ts'
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
 * How many dispatched sends stay claimable as echoes at once. This is a
 * mechanism depth, not a deployment choice: it only has to exceed the sends
 * whose echo has not been observed yet, and one send per approved tool call
 * never approaches it. A provider that publishes no echo of its own traffic
 * leaves its records to be evicted by the ones that follow.
 */
export const OUTBOUND_ECHO_RECALL = 64

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
 *
 * It also remembers what it dispatched, so `claimOwnEcho` can tell the
 * deployment's own answer coming back apart from the account writing from its
 * paired phone.
 */
export class WhatsAppRuntime extends Service {
  private provider: WhatsAppProvider | undefined
  private readonly echoes = new OutboundEchoes(OUTBOUND_ECHO_RECALL)

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
   *
   * The body is recorded as claimable before the provider is asked, because a
   * provider that republishes the account's own traffic can publish this send's
   * echo before this call returns; a record written afterwards would arrive
   * behind the consumer that already routed it. The record survives a rejected
   * send, since a send can fail after WhatsApp already relayed it.
   * @param request - the target chat, the non-empty body, and an optional quoted message.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the acknowledged message identity and send time.
   */
  async send(request: WhatsAppSendRequest, signal?: AbortSignal): Promise<WhatsAppSentMessage> {
    if (request.text.trim() === '') {
      throw new WhatsAppError('a WhatsApp message must carry text', 'WHATSAPP_EMPTY_MESSAGE')
    }
    const provider = this.requireOnline()
    this.echoes.record(request.chatId, request.text)
    const sent = await provider.send(request, signal)
    this.ctx.emit('whatsapp/message-sent', sent)
    return sent
  }

  /**
   * Claim one observed message as the echo of a send this service dispatched.
   *
   * A provider republishes the account's own traffic, so a consumer that acts
   * on what the account writes — the operator typing from the paired phone —
   * has to drop the deployment's own answers coming back, which would otherwise
   * wake the agent with its own words. A message the account did not write, and
   * a body no dispatched send carries, are never claimed.
   *
   * The claim is consumed: the first message matching a dispatched send answers
   * `true`, and an identical message after it is the account writing that text
   * itself.
   * @param message - the observed message, as the provider normalized it.
   * @returns whether this message is a send this service dispatched.
   */
  claimOwnEcho(message: WhatsAppMessage): boolean {
    if (!message.fromMe || message.content.kind !== 'text') return false
    return this.echoes.claim(message.chatId, message.content.text)
  }

  /**
   * Resolve one conversation address into the conversation it names.
   *
   * A chat id is opaque: WhatsApp addresses conversations through several
   * domains and adds more over time, so only the provider can say what an
   * address means. It answers for an address the connection has never
   * observed — naming it when it has — because a consumer must be able to
   * address a conversation it learned about from an incoming message or from
   * the operator, and the connection-scoped index is not a roster.
   * @param chatId - the conversation address to resolve.
   * @param signal - optional cancellation signal forwarded to the provider.
   * @returns the conversation, named when this connection observed it.
   */
  async resolveChat(chatId: WhatsAppChatId, signal?: AbortSignal): Promise<WhatsAppChat> {
    return this.requireOnline().resolveChat(chatId, signal)
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
