/**
 * Bounded recall of delivered message ids. A provider replays history after a
 * reconnection and repeats ids it already published, so the seam requires a
 * consumer that must act once to keep its own processed set.
 * @module @deepseek-ai/dsh-whatsapp-workspace/src/seen
 */

/** Oldest-first recall of message ids, capped at a deployment-chosen size. */
export class SeenMessages {
  private readonly ids = new Set<string>()

  /**
   * @param limit - how many ids stay remembered; the oldest is forgotten first.
   */
  constructor(private readonly limit: number) {}

  /**
   * Record one message id and report whether it is new.
   * @param id - the provider message id observed on `whatsapp/message-received`.
   * @returns `true` the first time this id is admitted, `false` for a replay.
   */
  admit(id: string): boolean {
    if (this.ids.has(id)) return false
    this.ids.add(id)
    for (const oldest of this.ids) {
      if (this.ids.size <= this.limit) break
      this.ids.delete(oldest)
    }
    return true
  }
}
