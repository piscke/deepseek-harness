/**
 * Opening one routed conversation session: create it or resume it on the same
 * durable identity, account it to the WhatsApp Workspace, and pin its title so
 * automatic generation never renames a standing conversation.
 * @module @deepseek-ai/dsh-whatsapp-workspace/src/sessions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { WhatsAppRouteTarget } from './types.ts'

/**
 * Open one conversation session under the Workspace. A durable log for the same
 * identity is resumed rather than replaced, so a restart continues the
 * conversation instead of starting an empty one.
 *
 * A stored session whose recorded project directory is not this Workspace's
 * directory is misconfiguration — the deployment moved `directory` while logs
 * exist under the old one — and fails loud with both paths rather than
 * attaching a session the Workspace would then filter back out.
 * @param ctx - context carrying the agent registry, session persistence, and the title service.
 * @param workspace - the WhatsApp Workspace; its canonical path is the session's project directory.
 * @param target - the session identity and the title to pin.
 * @returns the owned agent handle for this session.
 */
export async function openSession(
  ctx: Context,
  workspace: Workspace,
  target: WhatsAppRouteTarget,
): Promise<AgentHandle> {
  const stored = (await ctx.sessionPersistence.list()).find(header => header.id === target.sessionId)
  const handle = stored === undefined
    ? await ctx.agents.create({ sessionId: target.sessionId, meta: { cwd: workspace.path } })
    : await ctx.agents.resume({ resumeSessionId: target.sessionId })
  const { cwd } = handle.agent.session.header
  if (cwd !== workspace.path) {
    await handle.dispose()
    throw new Error(
      `whatsapp-workspace: session "${target.sessionId}" is recorded under ${JSON.stringify(cwd)}, `
      + `not the WhatsApp directory ${JSON.stringify(workspace.path)}`,
    )
  }
  await workspace.attachSession(target.sessionId)
  // `rename` pins with the `user` source, which stops automatic generation for
  // good. Re-pinning an unchanged title would append a redundant event on
  // every restart, so the current fold decides.
  if (ctx.sessionTitle.get(handle.agent.session)?.title !== target.title) {
    ctx.sessionTitle.rename(handle.agent.session, target.title)
  }
  return handle
}
