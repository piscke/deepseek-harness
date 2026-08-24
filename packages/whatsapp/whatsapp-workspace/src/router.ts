/**
 * Routing of the account's inbound stream onto sessions: one conversation
 * session is opened at most once, replayed message ids are dropped, and every
 * accepted message is handed to that session's queue.
 * @module @deepseek-ai/dsh-whatsapp-workspace/src/router
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WhatsAppChatId, WhatsAppMessage } from '@deepseek-ai/dsh-whatsapp'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { WhatsAppSessionInbox } from './inbox.ts'
import { renderThrown } from './diagnostics.ts'
import { chatSessionId, chatTitle, routeMessage } from './routing.ts'
import { SeenMessages } from './seen.ts'
import { openSession, pinTitle } from './sessions.ts'
import type { OpenedSession } from './sessions.ts'
import type { ResolvedConfig } from './index.ts'

/** One opened conversation session: the agent it runs on and its delivery queue. */
interface RoutedSession {
  readonly opened: OpenedSession
  readonly inbox: WhatsAppSessionInbox
}

/** The account's inbound stream, projected onto the Workspace's sessions. */
export class WhatsAppInboundRouter {
  private readonly sessions = new Map<SessionId, Promise<RoutedSession>>()
  private readonly seen: SeenMessages

  /**
   * @param ctx - context carrying the agent registry, persistence, title service, WhatsApp seam, and logger.
   * @param policy - the currently authoritative routing policy, re-read per message so a
   * settings change applies to the next one without reloading this plugin.
   * @param workspace - the WhatsApp Workspace every routed session is accounted to.
   */
  constructor(
    private readonly ctx: Context,
    private readonly policy: () => ResolvedConfig,
    private readonly workspace: Workspace,
  ) {
    // The replay window is a process-lifetime buffer, so it is entry-only: a
    // resized window mid-run would forget ids it is still suppressing.
    this.seen = new SeenMessages(policy().seenMessageLimit)
  }

  /**
   * Route one observed message. The deployment's own answers coming back,
   * filtered conversations, and ids already delivered end here; everything else
   * is queued against its conversation's session, opening that session on first
   * use. A conversation the operator archived is restored to the sidebar as its
   * message is routed.
   *
   * The echo claim runs before the routing policy, so a send into a
   * conversation this deployment does not route still consumes its record
   * rather than leaving it to match a later message.
   *
   * A message that arrives while this router is being disposed is dropped by
   * the target queue, which stops accepting before its drain is awaited.
   * @param message - the observed message, as the seam normalized it.
   */
  accept(message: WhatsAppMessage): void {
    if (this.ctx.whatsapp.claimOwnEcho(message)) return
    const config = this.policy()
    const sessionId = routeMessage(config, message)
    if (sessionId === undefined) return
    if (!this.seen.admit(message.id)) return
    this.restore(sessionId)
    void this.open(sessionId, message, config).then(
      (session) => { session.inbox.enqueue(message, config.inboundDelivery) },
      (error: unknown) => {
        this.ctx.logger.warn(
          `whatsapp-workspace: could not open session "${sessionId}" for chat "${message.chatId}": `
          + renderThrown(error),
        )
      },
    )
  }

  /**
   * Retitle the open session of a conversation the account has just named. A
   * group's subject is rarely known when its first message arrives, and a
   * conversation can be renamed at any time, so the title follows the name
   * rather than being fixed at the moment the session was opened.
   * @param chatId - the conversation that was named.
   * @param name - its new display name.
   */
  rename(chatId: WhatsAppChatId, name: string): void {
    const pending = this.sessions.get(chatSessionId(chatId))
    if (pending === undefined) return
    void pending.then(
      (session) => { pinTitle(this.ctx, session.opened.agent.session, name) },
      // A failed open is already reported by the `accept` that attempted it,
      // and nothing here can retry it.
      () => {},
    )
  }

  /** Drain every queue and release every session this router owns. */
  async dispose(): Promise<void> {
    const opened = [...this.sessions.values()]
    this.sessions.clear()
    await Promise.allSettled(opened.map(async (pending) => {
      const session = await pending
      await session.inbox.dispose()
      // Only the agents this router opened are its to tear down; one it merely
      // delivered into belongs to whoever published it.
      await session.opened.handle?.dispose()
    }))
  }

  /**
   * Return one conversation to the grouping surfaces before its message is
   * delivered. An archived conversation that speaks again is active again: the
   * agent answers it whether or not its row is visible, so leaving it hidden
   * would hide a live exchange from the operator, with no surface to find it
   * through. A conversation that is not archived reads the set synchronously
   * and writes nothing, so this costs a lookup per message.
   *
   * The durable write is not awaited: the row reappearing is display state, and
   * making delivery wait on it would delay the model for a sidebar update.
   */
  private restore(sessionId: SessionId): void {
    const registry = this.ctx.workspaceRegistry
    if (!registry.archivedSessionIds.includes(sessionId)) return
    void registry.unarchiveSession(sessionId).catch((error: unknown) => {
      this.ctx.logger.warn(
        `whatsapp-workspace: could not unarchive session "${sessionId}": ` + renderThrown(error),
      )
    })
  }

  /** Open one session once; a failed open is forgotten so a later message retries it. */
  private open(sessionId: SessionId, message: WhatsAppMessage, config: ResolvedConfig): Promise<RoutedSession> {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const opening = this.openConversation(sessionId, message, config)
      .catch((error: unknown) => {
        this.sessions.delete(sessionId)
        throw error
      })
    this.sessions.set(sessionId, opening)
    return opening
  }

  /** Title the conversation from the account, then open its session and its queue. */
  private async openConversation(
    sessionId: SessionId,
    message: WhatsAppMessage,
    config: ResolvedConfig,
  ): Promise<RoutedSession> {
    const title = chatTitle(message, await this.resolveName(message.chatId))
    const opened = await openSession(this.ctx, this.workspace, { sessionId, title }, config.agentPreset)
    return { opened, inbox: new WhatsAppSessionInbox(this.ctx, opened.agent) }
  }

  /**
   * What the account calls this conversation. A disconnected or failing
   * connection leaves the conversation unnamed rather than unrouted: the
   * message still has to reach its session, and `whatsapp/chat-named` retitles
   * it once the name is resolvable.
   */
  private async resolveName(chatId: WhatsAppChatId): Promise<string | undefined> {
    try {
      return (await this.ctx.whatsapp.resolveChat(chatId)).name
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `whatsapp-workspace: could not resolve a name for chat "${chatId}": ` + renderThrown(error),
      )
      return undefined
    }
  }
}
