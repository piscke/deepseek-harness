/**
 * Routing of the account's inbound stream onto sessions: one conversation
 * session is opened at most once, replayed message ids are dropped, and every
 * accepted message is handed to that session's queue.
 * @module @deepseek-ai/dsh-whatsapp-workspace/src/router
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WhatsAppMessage } from '@deepseek-ai/dsh-whatsapp'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { WhatsAppSessionInbox } from './inbox.ts'
import { renderThrown } from './diagnostics.ts'
import { routeMessage, standingTargets } from './routing.ts'
import { SeenMessages } from './seen.ts'
import { openSession } from './sessions.ts'
import type { ResolvedConfig } from './index.ts'
import type { WhatsAppRouteTarget } from './types.ts'

/** One opened conversation session: the owned agent and its delivery queue. */
interface RoutedSession {
  readonly handle: AgentHandle
  readonly inbox: WhatsAppSessionInbox
}

/** The account's inbound stream, projected onto the Workspace's sessions. */
export class WhatsAppInboundRouter {
  private readonly sessions = new Map<SessionId, Promise<RoutedSession>>()
  private readonly seen: SeenMessages

  /**
   * @param ctx - context carrying the agent registry, persistence, title service, and logger.
   * @param config - the resolved routing policy.
   * @param workspace - the WhatsApp Workspace every routed session is accounted to.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
    private readonly workspace: Workspace,
  ) {
    this.seen = new SeenMessages(config.seenMessageLimit)
  }

  /**
   * Open the sessions this route keeps standing, so the Workspace is populated
   * before any message arrives. A failure here fails plugin load: a Workspace
   * whose sessions could not be opened would show as empty with no explanation.
   * @returns resolution after every standing session is opened, attached, and titled.
   */
  async openStandingSessions(): Promise<void> {
    for (const target of standingTargets(this.config)) await this.open(target)
  }

  /**
   * Route one observed message. Filtered conversations, the account's own
   * messages, and ids already delivered end here; everything else is queued
   * against its session, opening that session on first use.
   *
   * A message that arrives while this router is being disposed is dropped by
   * the target queue, which stops accepting before its drain is awaited.
   * @param message - the observed message, as the seam normalized it.
   */
  accept(message: WhatsAppMessage): void {
    const target = routeMessage(this.config, message)
    if (target === undefined) return
    if (!this.seen.admit(message.id)) return
    void this.open(target).then(
      (session) => { session.inbox.enqueue(message) },
      (error: unknown) => {
        this.ctx.logger.warn(
          `whatsapp-workspace: could not open session "${target.sessionId}" for chat "${message.chatId}": `
          + renderThrown(error),
        )
      },
    )
  }

  /** Drain every queue and release every session this router owns. */
  async dispose(): Promise<void> {
    const opened = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.allSettled(opened.map(async (pending) => {
      const session = await pending
      await session.inbox.dispose()
      await session.handle.dispose()
    }))
  }

  /** Open one session once; a failed open is forgotten so a later message retries it. */
  private open(target: WhatsAppRouteTarget): Promise<RoutedSession> {
    const existing = this.sessions.get(target.sessionId)
    if (existing !== undefined) return existing
    const opening = openSession(this.ctx, this.workspace, target)
      .then(handle => ({ handle, inbox: new WhatsAppSessionInbox(this.ctx, handle.agent) }))
      .catch((error: unknown) => {
        this.sessions.delete(target.sessionId)
        throw error
      })
    this.sessions.set(target.sessionId, opening)
    return opening
  }
}
