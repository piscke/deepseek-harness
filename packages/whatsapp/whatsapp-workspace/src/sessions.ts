/**
 * Opening one routed conversation session: create it or resume it on the same
 * durable identity, compose the agent that answers it, account it to the
 * WhatsApp Workspace, and pin its title so automatic generation never renames a
 * conversation the operator recognizes by name.
 * @module @deepseek-ai/dsh-whatsapp-workspace/src/sessions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { WhatsAppRouteTarget } from './types.ts'

/** One conversation session the router delivers into. */
export interface OpenedSession {
  /** The live agent, whether this open produced it or found it already published. */
  readonly agent: Agent
  /**
   * The handle to release on teardown, present only when this open produced the
   * agent. An agent published by another owner — the Web surface with that
   * conversation open — outlives this Workspace's routing and is not this
   * caller's to dispose.
   */
  readonly handle?: AgentHandle
}

/**
 * Compose one conversation agent from the preset roster, when a roster is
 * composed at all. Without one nothing is mounted and the session runs on the
 * host composition, which is the behavior before presets existed.
 * @param ctx - context that may carry the preset roster.
 * @param presetId - the preset to mount, or `undefined` for the roster's default.
 * @returns the preset id to record on the header and the agent setup callback.
 */
async function composeConversation(ctx: Context, presetId: string | undefined): Promise<{
  agentPreset?: string
  setup?: (agentCtx: Context) => Promise<void>
}> {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) return {}
  const resolved = (await presets.resolve(presetId)).id
  return {
    agentPreset: resolved,
    setup: async (agentCtx: Context) => {
      await presets.mount(agentCtx, resolved)
    },
  }
}

/**
 * Resume one conversation session under the composition its history was
 * produced with. The preset is read from the LOG rather than from the
 * deployment's current `agentPreset`: the turns already in that session were
 * produced under the composition it recorded, and rebuilding it differently
 * would strand tool calls the model can no longer make.
 * @param ctx - context carrying the agent registry and, optionally, the preset roster.
 * @param sessionId - the persisted identity to resume.
 * @returns the owned handle.
 */
async function resumeSession(ctx: Context, sessionId: SessionId): Promise<AgentHandle> {
  return await ctx.agents.resume({
    resumeSessionId: sessionId,
    setup: async (agentCtx: Context) => {
      const presets = agentCtx.get('agentPresets')
      if (presets === undefined) return
      const agent = agentCtx.agent
      if (agent === undefined) throw new Error('whatsapp-workspace: agent setup has no scoped agent')
      await presets.mount(agentCtx, resolveSessionPreset(agent.session))
    },
  })
}

/**
 * Pin one session's display title. `rename` pins with the `user` source, which
 * stops automatic generation for good. Re-pinning an unchanged title would
 * append a redundant event on every restart, so the current fold decides.
 * @param ctx - context carrying the title service.
 * @param session - the session to title.
 * @param title - the name this conversation is known by.
 */
export function pinTitle(ctx: Context, session: Session, title: string): void {
  if (ctx.sessionTitle.get(session)?.title === title) return
  ctx.sessionTitle.rename(session, title)
}

/**
 * Open one conversation session under the Workspace. A durable log for the same
 * identity is resumed rather than replaced, so a restart continues the
 * conversation instead of starting an empty one; and an agent already published
 * on that identity — the operator has the conversation open in the Web UI — is
 * delivered into rather than resumed a second time over the same log.
 *
 * A stored session whose recorded project directory is not this Workspace's
 * directory is misconfiguration — the deployment moved `directory` while logs
 * exist under the old one — and fails loud with both paths rather than
 * attaching a session the Workspace would then filter back out.
 * @param ctx - context carrying the agent registry, session persistence, the title service, and any preset roster.
 * @param workspace - the WhatsApp Workspace; its canonical path is the session's project directory.
 * @param target - the session identity and the title to pin.
 * @param presetId - the preset a newly created conversation session is composed from.
 * @returns the live agent, plus the handle when this call is what opened it.
 */
export async function openSession(
  ctx: Context,
  workspace: Workspace,
  target: WhatsAppRouteTarget,
  presetId?: string,
): Promise<OpenedSession> {
  const opened = await adopt(ctx, workspace, target, presetId)
  const { cwd } = opened.agent.session.header
  if (cwd !== workspace.path) {
    await opened.handle?.dispose()
    throw new Error(
      `whatsapp-workspace: session "${target.sessionId}" is recorded under ${JSON.stringify(cwd)}, `
      + `not the WhatsApp directory ${JSON.stringify(workspace.path)}`,
    )
  }
  await workspace.attachSession(target.sessionId)
  pinTitle(ctx, opened.agent.session, target.title)
  return opened
}

/** The live agent for this identity: the published one, a resumed log, or a newly created session. */
async function adopt(
  ctx: Context,
  workspace: Workspace,
  target: WhatsAppRouteTarget,
  presetId: string | undefined,
): Promise<OpenedSession> {
  const live = ctx.agents.get(target.sessionId)
  if (live !== undefined) return { agent: live }
  const stored = (await ctx.sessionPersistence.list()).find(header => header.id === target.sessionId)
  if (stored !== undefined) {
    const handle = await resumeSession(ctx, target.sessionId)
    return { agent: handle.agent, handle }
  }
  const composition = await composeConversation(ctx, presetId)
  const handle = await ctx.agents.create({
    sessionId: target.sessionId,
    // The conversation is answered by whatever model a new session gets here;
    // a routed message has no operator in front of it to pick one.
    agentOptions: ctx.agentDefaultModel.currentSelection(),
    meta: {
      cwd: workspace.path,
      ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
    },
    ...composition.setup === undefined ? {} : { setup: composition.setup },
  })
  return { agent: handle.agent, handle }
}
