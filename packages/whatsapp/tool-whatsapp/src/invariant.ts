/** Package-owned durable WhatsApp-outbound invariants. @module @deepseek-ai/dsh-tool-whatsapp/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-whatsapp'

/** Report a field that must be a non-empty string. */
function requireText(value: unknown, field: string, fail: InvariantFailure): void {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`whatsapp/outbound ${field} must be a non-empty string`)
  }
}

/**
 * Validate one acknowledged send's durable record.
 *
 * Deliberately silent on length: `sendMaxTextChars` is the tool's per-deployment
 * bound, and a log written under a wider bound must still replay after a
 * deployment tightens it.
 */
function validateOutbound(data: Record<string, unknown>, fail: InvariantFailure): void {
  requireText(data.messageId, 'messageId', fail)
  requireText(data.chatId, 'chatId', fail)
  requireText(data.timestamp, 'timestamp', fail)
  // A recorded send that carries no body would claim the account said nothing.
  if (typeof data.text !== 'string' || data.text.trim().length === 0) {
    fail('whatsapp/outbound text must carry a non-whitespace body')
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'whatsapp/outbound') validateOutbound(event.data as unknown as Record<string, unknown>, fail)
}

/** Install validation for loaded and newly appended outbound records. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateEvent(event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/** Cordis companion plugin name. */
export const name = 'tool-whatsapp-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Register the WhatsApp tool invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
