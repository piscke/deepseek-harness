/**
 * Queued delivery of inbound messages into one session. A message that arrives
 * while the agent is mid-turn waits: delivery claims the agent's idle phase
 * through `runMaintenance`, so the framing enters the log and the inbox between
 * turns and never interrupts the turn in flight.
 * @module @deepseek-ai/dsh-whatsapp-workspace/src/inbox
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { WhatsAppMessage } from '@deepseek-ai/dsh-whatsapp'
import { renderThrown } from './diagnostics.ts'
import { renderInbound } from './routing.ts'
import type { WhatsAppInboundEvent } from './types.ts'

/**
 * Project one observed message onto its durable provenance record.
 * @param message - the observed message, as the seam normalized it.
 * @returns the `whatsapp/inbound` payload for this message.
 */
export function inboundEvent(message: WhatsAppMessage): WhatsAppInboundEvent {
  return {
    messageId: message.id,
    chatId: message.chatId,
    chatKind: message.chatKind,
    ...message.chatName === undefined ? {} : { chatName: message.chatName },
    senderId: message.senderId,
    ...message.senderName === undefined ? {} : { senderName: message.senderName },
    timestamp: message.timestamp,
    content: message.content,
  }
}

/** One session's inbound queue and its serial, coalesced delivery loop. */
export class WhatsAppSessionInbox {
  private readonly pending: WhatsAppMessage[] = []
  private readonly stop = Promise.withResolvers<void>()
  private run: Promise<void> | undefined
  private idleWait: Promise<void> | undefined
  private requested = false
  private stopping = false

  /**
   * @param ctx - context supplying the logger for contained delivery failures.
   * @param agent - the exact live agent this queue delivers into.
   */
  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
  ) {}

  /**
   * Queue one message for delivery as its own follow-up turn.
   * @param message - the routed message, already deduplicated by the router.
   */
  enqueue(message: WhatsAppMessage): void {
    if (this.stopping) return
    this.pending.push(message)
    this.requestDrive()
  }

  /**
   * Stop future delivery, drop what never left the queue, and await the drain
   * already in flight. Idempotent.
   * @returns resolution once no delivery of this queue is still running.
   */
  async dispose(): Promise<void> {
    this.stopping = true
    this.requested = false
    this.pending.length = 0
    this.stop.resolve()
    await Promise.allSettled([this.run, this.idleWait])
  }

  /** Start the serial drain, or mark that the running one has more to do. */
  private requestDrive(): void {
    if (this.stopping) return
    this.requested = true
    if (this.run !== undefined) return
    this.run = this.drain()
  }

  /**
   * Drain coalesced triggers serially, then release the slot. Clearing `run`
   * in `finally` closes the wakeup gap: `requested` cannot be set between the
   * loop's last check and the slot reopening, so no trigger is dropped.
   */
  private async drain(): Promise<void> {
    try {
      while (this.requested && !this.stopping) {
        this.requested = false
        await this.driveOnce()
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `whatsapp-workspace: delivery loop failed for session "${this.agent.id}": ${renderThrown(error)}`,
      )
    } finally {
      this.run = undefined
    }
  }

  /** Claim the idle phase once and deliver everything queued at that moment. */
  private async driveOnce(): Promise<void> {
    const batch = this.pending.splice(0, this.pending.length)
    let maintenance: Promise<void>
    try {
      maintenance = this.agent.runMaintenance(() => {
        for (const message of batch) this.deliver(message)
        return Promise.resolve()
      })
    } catch (_busy: unknown) {
      // `runMaintenance` throws synchronously only while a turn or another
      // maintenance task owns the agent. The batch goes back at the head so
      // arrival order survives, and the next idle boundary retries it.
      this.pending.unshift(...batch)
      this.waitForIdle()
      return
    }
    await maintenance
  }

  /** Await one public idle boundary, or disposal, without holding the queue open. */
  private waitForIdle(): void {
    if (this.idleWait !== undefined) return
    this.idleWait = Promise.race([this.agent.whenIdle(), this.stop.promise]).then(
      () => {
        this.idleWait = undefined
        this.requestDrive()
      },
      (error: unknown) => {
        this.idleWait = undefined
        this.ctx.logger.warn(
          `whatsapp-workspace: idle wait failed for session "${this.agent.id}": ${renderThrown(error)}`,
        )
      },
    )
  }

  /**
   * Log the provenance, then queue the framing. Appending first keeps
   * model-visible ⟺ logged in the failing direction: a message the log could
   * not record never reaches the model. One message's failure is contained so a
   * single unloggable message cannot block the conversation behind it.
   */
  private deliver(message: WhatsAppMessage): void {
    try {
      this.agent.session.append('whatsapp/inbound', inboundEvent(message))
      this.agent.followup(createUserMessage({
        content: [{ type: 'text', text: renderInbound(message) }],
        source: { kind: 'plugin', plugin: 'whatsapp-workspace' },
      }))
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `whatsapp-workspace: dropped message "${message.id}" for session "${this.agent.id}": ${renderThrown(error)}`,
      )
    }
  }
}
