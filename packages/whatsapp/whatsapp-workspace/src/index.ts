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
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-whatsapp'
import type {} from '@deepseek-ai/dsh-workspace'
import { WhatsAppInboundRouter } from './router.ts'
import type { WhatsAppChatScope, WhatsAppInboundDelivery } from './types.ts'

export type {
  WhatsAppChatScope,
  WhatsAppInboundDelivery,
  WhatsAppInboundEvent,
  WhatsAppRouteTarget,
} from './types.ts'
export { WhatsAppSessionInbox, inboundEvent } from './inbox.ts'
export { renderThrown } from './diagnostics.ts'
export { WhatsAppInboundRouter } from './router.ts'
export { SeenMessages } from './seen.ts'
export { openSession } from './sessions.ts'
export {
  chatSessionId,
  chatTitle,
  isRoutedChat,
  isRoutedKind,
  renderInbound,
  routeMessage,
  summarizeInbound,
} from './routing.ts'

/** Cordis function-plugin name. */
export const name = 'whatsapp-workspace'

/**
 * Services required before the Workspace can be opened. The agent factory is
 * deliberately absent: injecting it would leave this plugin silently pending in
 * a composition without an agent-loop, while `ctx.agents.create` names the
 * missing loop outright.
 */
export const inject = [
  'agentDefaultModel',
  'agents',
  'sessionPersistence',
  'sessions',
  'sessionTitle',
  'whatsapp',
  'workspaceRegistry',
]

/** Settings namespace carrying the slice of this policy a running deployment can change. */
export const WHATSAPP_WORKSPACE_SETTINGS_NAMESPACE = settingsNamespace('whatsapp-workspace')

/** Which conversations open a session, as a schema field shared by the entry and the user layer. */
const ChatScope = z.union([z.const('all'), z.const('groups'), z.const('contacts')])

/** How a delivered message reaches the model, as a schema field shared by the entry and the user layer. */
const InboundDelivery = z.union([z.const('context'), z.const('turn')])

/**
 * Deployment policy for the WhatsApp Workspace. Every field is a validated
 * `Config` member rather than a constant: the directory, the display title, the
 * conversations that are answered, and the preset that answers them all vary
 * per deployment.
 */
export interface Config {
  /** Directory the Workspace owns. A leading `~` expands to the user's home; the resolved path must be absolute. */
  directory?: string
  /** Display title of the Workspace registration in the sidebar. */
  workspaceTitle?: string
  /** Which conversations open a session. Every routed conversation gets its own. */
  chats?: WhatsAppChatScope
  /** When non-empty, only these chat ids are routed; every other conversation is dropped. */
  allowChatIds?: string[]
  /** Chat ids never routed. Applied after `allowChatIds`, so a denied id stays denied. */
  denyChatIds?: string[]
  /**
   * How a delivered message reaches the model: as pending context the
   * operator's next prompt carries, or as its own follow-up turn.
   */
  inboundDelivery?: WhatsAppInboundDelivery
  /**
   * Agent preset mounted on each conversation session as it is created. Absent
   * composes nothing, which leaves the session with whatever the composition
   * gives every agent.
   */
  agentPreset?: string
  /** How many recently delivered message ids are remembered to suppress a provider's history replay. */
  seenMessageLimit?: number
}

/**
 * Complete policy after schemastery applies every field default. `agentPreset`
 * stays optional: a deployment that names no preset is the composition's own
 * agent, not a missing value.
 */
export type ResolvedConfig = Required<Omit<Config, 'agentPreset'>> & Pick<Config, 'agentPreset'>

/** Schemastery policy for the WhatsApp Workspace. */
export const Config: z<Config> = z.object({
  directory: z.string().default('~/.dsh/whatsapp'),
  workspaceTitle: z.string().default('WhatsApp'),
  chats: ChatScope.default('all'),
  allowChatIds: z.array(z.string()).default([]),
  denyChatIds: z.array(z.string()).default([]),
  inboundDelivery: InboundDelivery.default('context'),
  agentPreset: z.string(),
  seenMessageLimit: z.number().default(1000),
})

/**
 * The user-writable slice of the policy. `directory` and `workspaceTitle` are
 * deliberately absent: they decide the Workspace's identity, which is fixed
 * when the plugin loads and cannot change under sessions already attached to it.
 */
export interface WhatsAppWorkspaceSettings {
  /** Which conversations open a session; takes effect on the next observed message. */
  chats?: WhatsAppChatScope
  /** When non-empty, only these chat ids are routed. */
  allowChatIds?: string[]
  /** Chat ids never routed, applied after `allowChatIds`. */
  denyChatIds?: string[]
  /** How a delivered message reaches the model; takes effect on the next observed message. */
  inboundDelivery?: WhatsAppInboundDelivery
  /** Agent preset mounted on conversation sessions opened after the change. */
  agentPreset?: string
}

/** Runtime schema for the user-writable slice. */
export const WhatsAppWorkspaceSettings: z<WhatsAppWorkspaceSettings> = z.object({
  chats: ChatScope,
  allowChatIds: z.array(z.string()),
  denyChatIds: z.array(z.string()),
  inboundDelivery: InboundDelivery,
  agentPreset: z.string(),
})

/**
 * The composition entry's values for the user-writable slice, which the
 * settings registration layers the stored document over.
 * @param config - the resolved deployment policy.
 * @returns the entry's value for every field of the user-writable slice.
 */
export function settingsBase(config: ResolvedConfig): WhatsAppWorkspaceSettings {
  return {
    chats: config.chats,
    allowChatIds: config.allowChatIds,
    denyChatIds: config.denyChatIds,
    inboundDelivery: config.inboundDelivery,
    ...config.agentPreset === undefined ? {} : { agentPreset: config.agentPreset },
  }
}

/**
 * Fold one resolved section over the composition entry. A field the resolved
 * section leaves unset keeps the composed value, so removing a stored key
 * restores what the deployment shipped rather than clearing the field.
 * @param config - the resolved deployment policy.
 * @param settings - the currently authoritative user-writable slice.
 * @returns the policy the next routed message is judged by.
 */
export function applySettings(config: ResolvedConfig, settings: WhatsAppWorkspaceSettings): ResolvedConfig {
  return {
    ...config,
    ...settings.chats === undefined ? {} : { chats: settings.chats },
    ...settings.allowChatIds === undefined ? {} : { allowChatIds: settings.allowChatIds },
    ...settings.denyChatIds === undefined ? {} : { denyChatIds: settings.denyChatIds },
    ...settings.inboundDelivery === undefined ? {} : { inboundDelivery: settings.inboundDelivery },
    ...settings.agentPreset === undefined ? {} : { agentPreset: settings.agentPreset },
  }
}

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
 * an unusable directory, a Workspace the registry refuses — fails plugin load
 * with its own message, because a Workspace that silently never appears is
 * indistinguishable from a disconnected account.
 *
 * No session is opened here: a conversation's session is created the first time
 * that conversation is routed. The Workspace therefore starts empty on a fresh
 * deployment, and lists every conversation it has ever answered afterwards,
 * because the session-to-Workspace attachment is durable.
 * @param ctx - the plugin context.
 * @param config - the deployment's routing policy, after schemastery defaults.
 * @returns resolution after the Workspace exists and the inbound listener is attached.
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
  let current: () => WhatsAppWorkspaceSettings = () => settingsBase(resolved)
  installSettingsSection(
    ctx,
    WHATSAPP_WORKSPACE_SETTINGS_NAMESPACE,
    WhatsAppWorkspaceSettings,
    settingsBase(resolved),
    {
      setSource: (source) => {
        current = source
      },
      // Nothing is derived from the section: the router judges each message
      // against the source as it arrives, and a session already open keeps the
      // preset it was composed under.
      onChange: () => {},
    },
  )
  // `create` reuses the record already owning this canonical path and leaves
  // its title alone, so a title the operator changed in the UI survives.
  const workspace = await ctx.workspaceRegistry.create(directory, resolved.workspaceTitle)
  const router = new WhatsAppInboundRouter(ctx, () => applySettings(resolved, current()), workspace)
  ctx.effect(() => {
    const stop = ctx.on('whatsapp/message-received', (message) => { router.accept(message) })
    const renamed = ctx.on('whatsapp/chat-named', (chatId, chatName) => { router.rename(chatId, chatName) })
    return async () => {
      stop()
      renamed()
      await router.dispose()
    }
  }, 'whatsapp-workspace.router()')
}
