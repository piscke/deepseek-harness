/**
 * The WhatsApp Workspace: a dedicated directory registered as a Workspace, the
 * conversation sessions inside it, and the delivery of the account's inbound
 * stream into those sessions as queued follow-up turns.
 *
 * This is a Consumer of `ctx.whatsapp`. It registers no provider and no tool —
 * answering a conversation is `@deepseek-ai/dsh-tool-whatsapp`.
 * @module @deepseek-ai/dsh-whatsapp-workspace
 */

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-whatsapp'
import type {} from '@deepseek-ai/dsh-workspace'
import { WhatsAppInboundRouter } from './router.ts'
import type { WhatsAppRouteMode } from './types.ts'

export type {
  WhatsAppInboundEvent,
  WhatsAppRouteMode,
  WhatsAppRouteTarget,
} from './types.ts'
export { WhatsAppSessionInbox, inboundEvent } from './inbox.ts'
export { renderThrown } from './diagnostics.ts'
export { WhatsAppInboundRouter } from './router.ts'
export { SeenMessages } from './seen.ts'
export { openSession } from './sessions.ts'
export {
  CONTACTS_SESSION_ID,
  CONVERSATIONS_SESSION_ID,
  GROUPS_SESSION_ID,
  chatSessionId,
  isRoutedChat,
  renderInbound,
  routeMessage,
  standingTargets,
} from './routing.ts'

/** Cordis function-plugin name. */
export const name = 'whatsapp-workspace'

/**
 * Services required before the Workspace can be opened. The agent factory is
 * deliberately absent: injecting it would leave this plugin silently pending in
 * a composition without an agent-loop, while `ctx.agents.create` names the
 * missing loop outright.
 */
export const inject = ['agents', 'sessionPersistence', 'sessions', 'sessionTitle', 'whatsapp', 'workspaceRegistry']

/**
 * Deployment policy for the WhatsApp Workspace. Every field is a validated
 * `Config` member rather than a constant: the directory, the display titles,
 * and the routing shape all vary per deployment and per language.
 */
export interface Config {
  /** Directory the Workspace owns. A leading `~` expands to the user's home; the resolved path must be absolute. */
  directory?: string
  /** Display title of the Workspace registration in the sidebar. */
  workspaceTitle?: string
  /** How inbound conversations map onto sessions. Required: no routing shape is right for every deployment. */
  route: WhatsAppRouteMode
  /** Title pinned on the `category` route's group session. */
  groupsTitle?: string
  /** Title pinned on the `category` route's direct-chat session. */
  contactsTitle?: string
  /** Title pinned on the `single` route's one session. */
  conversationsTitle?: string
  /** When non-empty, only these chat ids are routed; every other conversation is dropped. */
  allowChatIds?: string[]
  /** Chat ids never routed. Applied after `allowChatIds`, so a denied id stays denied. */
  denyChatIds?: string[]
  /** How many recently delivered message ids are remembered to suppress a provider's history replay. */
  seenMessageLimit?: number
}

/** Complete policy after schemastery applies every field default. */
export type ResolvedConfig = Required<Config>

/** Schemastery policy for the WhatsApp Workspace. */
export const Config: z<Config> = z.object({
  directory: z.string().default('~/.dsh/whatsapp'),
  workspaceTitle: z.string().default('WhatsApp'),
  route: z.union([z.const('category'), z.const('per-chat'), z.const('single')]).required(),
  groupsTitle: z.string().default('Groups'),
  contactsTitle: z.string().default('Contacts'),
  conversationsTitle: z.string().default('Conversations'),
  allowChatIds: z.array(z.string()).default([]),
  denyChatIds: z.array(z.string()).default([]),
  seenMessageLimit: z.number().default(1000),
})

/**
 * Resolve the configured directory to an absolute path. A leading `~` expands
 * to the user's home; anything still relative afterwards is rejected, because a
 * session's project directory is resolved against the host process's working
 * directory and would follow whatever launched it.
 * @param directory - the configured `directory` value.
 * @returns the absolute, normalized directory path.
 */
export function resolveDirectory(directory: string): string {
  const trimmed = directory.trim()
  if (trimmed === '') throw new Error('whatsapp-workspace: directory must not be empty')
  const expanded = trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')
    ? join(homedir(), trimmed.slice(1))
    : trimmed
  if (!isAbsolute(expanded)) {
    throw new Error(`whatsapp-workspace: directory must be absolute, got ${JSON.stringify(directory)}`)
  }
  return resolve(expanded)
}

/**
 * Open the Workspace and start routing. Every step that cannot be completed —
 * an unusable directory, a Workspace the registry refuses, a standing session
 * that will not open — fails plugin load with its own message, because a
 * Workspace that silently never appears is indistinguishable from a
 * disconnected account.
 * @param ctx - the plugin context.
 * @param config - the deployment's routing policy, after schemastery defaults.
 * @returns resolution after the Workspace, its standing sessions, and the inbound listener exist.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  if (!Number.isInteger(resolved.seenMessageLimit) || resolved.seenMessageLimit < 1) {
    throw new Error(`whatsapp-workspace: seenMessageLimit must be a positive integer, got ${resolved.seenMessageLimit}`)
  }
  const directory = resolveDirectory(resolved.directory)
  try {
    await mkdir(directory, { recursive: true })
  } catch (error: unknown) {
    throw new Error(`whatsapp-workspace: could not create directory ${JSON.stringify(directory)}`, { cause: error })
  }
  // `create` reuses the record already owning this canonical path and leaves
  // its title alone, so a title the operator changed in the UI survives.
  const workspace = await ctx.workspaceRegistry.create(directory, resolved.workspaceTitle)
  const router = new WhatsAppInboundRouter(ctx, resolved, workspace)
  ctx.effect(() => {
    const stop = ctx.on('whatsapp/message-received', (message) => { router.accept(message) })
    return async () => {
      stop()
      await router.dispose()
    }
  }, 'whatsapp-workspace.router()')
  // After the listener, so a message observed while the standing sessions open
  // is queued rather than missed.
  await router.openStandingSessions()
}
