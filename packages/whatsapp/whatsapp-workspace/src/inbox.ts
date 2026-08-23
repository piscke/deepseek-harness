/**
 * Queued delivery of inbound messages into one session. A message that arrives
 * while the agent is mid-turn waits: delivery claims the agent's idle phase
 * through `runMaintenance`, so the framing enters the log and the inbox between
 * turns and never joins the turn in flight.
 * @module @deepseek-ai/dsh-whatsapp-workspace/src/inbox
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assertNever, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { WhatsAppMessage } from '@deepseek-ai/dsh-whatsapp'
import { renderThrown } from './diagnostics.ts'
import { renderInbound, summarizeInbound } from './routing.ts'
import type { WhatsAppInboundDelivery, WhatsAppInboundEvent } from './types.ts'

/** One queued message and the delivery mode in force when it was routed. */
interface PendingDelivery {
  readonly message: WhatsAppMessage
  readonly delivery: WhatsAppInboundDelivery
}

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
  private readonly pending: PendingDelivery[] = []
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
   * Queue one message for delivery.
   * @param message - the routed message, already deduplicated by the router.
   * @param delivery - how this message reaches the model, per the policy that routed it.
   */
  enqueue(message: WhatsAppMessage, delivery: WhatsAppInboundDelivery): void {
    if (this.stopping) return
    this.pending.push({ message, delivery })
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
        for (const entry of batch) this.deliver(entry)
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
   * Log the provenance, then hand the framing to the agent. Appending first
   * keeps model-visible ⟺ logged in the failing direction: a message the log
   * could not record never reaches the model. One message's failure is
   * contained so a single unloggable message cannot block the conversation
   * behind it.
   *
   * `context` leaves the framing pending at the next-step boundary and wakes
   * nothing, so the operator's next prompt in this conversation is what carries
   * it into a request. `turn` opens a follow-up turn for it, which is how an
   * account answers without an operator present. The idle claim above is what
   * keeps the `context` arm out of a turn already in flight, which would
   * otherwise consume it at that turn's next step boundary.
   *
   * The framing declares the `notice` form: a message arriving is a one-off
   * account that supersedes nothing, and its summary is what makes a message
   * still waiting for the operator readable without expanding its row.
   */
  private deliver({ message, delivery }: PendingDelivery): void {
    try {
      this.agent.session.append('whatsapp/inbound', inboundEvent(message))
      const framing = createUserMessage({
        content: [{ type: 'text', text: renderInbound(message) }],
        source: {
          kind: 'plugin',
          plugin: 'whatsapp-workspace',
          form: 'notice',
          summary: summarizeInbound(message),
        },
      })
      switch (delivery) {
        case 'context':
          this.agent.inject(framing)
          break
        case 'turn':
          this.agent.followup(framing)
          break
        /* v8 ignore next -- WhatsAppInboundDelivery is closed and every member is handled above. */
        default: assertNever(delivery, 'WhatsAppInboundDelivery')
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `whatsapp-workspace: dropped message "${message.id}" for session "${this.agent.id}": ${renderThrown(error)}`,
      )
    }
  }
}
