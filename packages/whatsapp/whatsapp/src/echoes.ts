/**
 * Recall of the sends this seam dispatched, so a consumer can tell the account
 * typing from the echo of a message the deployment itself sent.
 * @module @deepseek-ai/dsh-whatsapp/src/echoes
 */

/** One dispatched send, held until an observed message claims it. */
interface DispatchedSend {
  readonly chatId: string
  readonly text: string
}

/**
 * Oldest-first recall of dispatched sends, capped at a fixed size.
 *
 * A send is matched by its conversation and its exact body, because a provider
 * reports the echo of a send under a message id the sender only learns from the
 * acknowledgement — which a provider that publishes the echo before its `send`
 * resolves has not returned yet.
 */
export class OutboundEchoes {
  private readonly dispatched: DispatchedSend[] = []

  /**
   * @param limit - how many unclaimed sends stay claimable; the oldest is forgotten first.
   */
  constructor(private readonly limit: number) {}

  /**
   * Record one send about to leave, before it is dispatched.
   * @param chatId - the conversation the send is addressed to.
   * @param text - the body exactly as it goes on the network.
   */
  record(chatId: string, text: string): void {
    this.dispatched.push({ chatId, text })
    if (this.dispatched.length > this.limit) this.dispatched.splice(0, this.dispatched.length - this.limit)
  }

  /**
   * Claim one observed body as the echo of a recorded send, consuming the
   * record so the same body observed again is the account writing it itself.
   * @param chatId - the conversation the message was observed in.
   * @param text - the observed body.
   * @returns whether a recorded send matched.
   */
  claim(chatId: string, text: string): boolean {
    const index = this.dispatched.findIndex(entry => entry.chatId === chatId && entry.text === text)
    if (index === -1) return false
    this.dispatched.splice(index, 1)
    return true
  }
}
