/**
 * `@deepseek-ai/dsh-whatsapp-baileys`: registers a Baileys-backed
 * `WhatsAppProvider` with `ctx.whatsapp` and publishes the connection's status
 * transitions and observed messages as harness events.
 *
 * `baileys` is NOT a dependency of this package in any field: it carries a
 * GPL-3.0 transitive dependency resolved from git, which this MIT repository's
 * supply-chain policy rejects. The deployment installs it and names it through
 * `moduleSpecifier`; this package loads it with a dynamic `import()` at connect
 * time, so a deployment without it simply has no usable WhatsApp provider.
 *
 * @module @deepseek-ai/dsh-whatsapp-baileys
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-whatsapp'
import { BaileysProvider } from './provider.ts'
import { providerDeps } from './deps.ts'
import { baileysOpener } from './socket.ts'

export { BaileysProvider } from './provider.ts'
export { providerDeps } from './deps.ts'
export type { BaileysProviderConfig, BaileysProviderDeps } from './provider.ts'
export { baileysOpener, loadBaileys } from './socket.ts'
export type {
  BaileysConnectionUpdate,
  BaileysKey,
  BaileysLoader,
  BaileysMessage,
  BaileysModule,
  BaileysRosterEntry,
  BaileysRosterEvent,
  BaileysSocket,
  BaileysSocketOptions,
  SocketEvent,
  WhatsAppSocket,
  WhatsAppSocketOpener,
} from './socket.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'whatsapp-baileys'

/** The WhatsApp seam this provider registers into. */
export const inject = ['whatsapp']

/** Plugin config: where the library and credentials live, and how the connection is kept up. */
export interface Config {
  /** Module specifier of the Baileys library the deployment installed. */
  moduleSpecifier?: string
  /** Directory holding the multi-file auth state that resumes a paired account. */
  authDir?: string
  /** Device name shown in WhatsApp's linked-devices list. */
  deviceName?: string
  /** Milliseconds to wait before reopening a connection that closed unexpectedly. */
  reconnectDelay?: number
  /** Consecutive reopen attempts before the provider gives up until it is reloaded. */
  maxReconnectAttempts?: number
  /** Messages retained per conversation for `fetchMessages`. */
  historyPerChat?: number
}

export const Config: z<Config> = z.object({
  moduleSpecifier: z.string().default('baileys'),
  authDir: z.string().default('.dsh/whatsapp/auth'),
  deviceName: z.string().default('DeepSeek Harness'),
  reconnectDelay: z.number().default(5_000),
  maxReconnectAttempts: z.number().default(5),
  historyPerChat: z.number().default(200),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** A positive finite bound; a non-positive one would disable the behavior it names. */
function assertPositiveFinite(field: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`whatsapp-baileys: ${field} must be a positive finite number`)
  }
}

/** A retry budget is a count, and zero legitimately means "never reconnect". */
function assertNonNegativeInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`whatsapp-baileys: ${field} must be a non-negative integer`)
  }
}

/**
 * Register the Baileys WhatsApp provider with `ctx.whatsapp`.
 * @param ctx - the fiber this provider is loaded into.
 * @param config - credential directory and connection-keeping behavior.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveFinite('reconnectDelay', resolved.reconnectDelay)
  assertPositiveFinite('historyPerChat', resolved.historyPerChat)
  assertNonNegativeInteger('maxReconnectAttempts', resolved.maxReconnectAttempts)

  const deps = providerDeps(
    ctx,
    baileysOpener({
      moduleSpecifier: resolved.moduleSpecifier,
      authDir: resolved.authDir,
      browser: [resolved.deviceName, 'Chrome', '1.0.0'],
    }),
    {
      reconnectDelay: resolved.reconnectDelay,
      maxReconnectAttempts: resolved.maxReconnectAttempts,
      historyPerChat: resolved.historyPerChat,
    },
  )
  const provider = new BaileysProvider(deps)
  ctx.effect(function* () {
    // Teardown is LIFO: the provider's connection closes before its
    // registration is withdrawn, so nothing can dispatch onto a closing socket.
    yield () => provider.dispose()
    yield ctx.whatsapp.register(provider)
  }, 'whatsapp-baileys lifecycle')
  // The connection is opened eagerly and reports its own progress; a failure to
  // start is the provider's to route, so nothing here awaits it.
  void provider.start()
}
