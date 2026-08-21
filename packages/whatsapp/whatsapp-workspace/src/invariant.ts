/** Package-owned durable WhatsApp-inbound invariants. @module @deepseek-ai/dsh-whatsapp-workspace/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const PACKAGE_NAME = '@deepseek-ai/dsh-whatsapp-workspace'
const CHAT_KINDS = new Set(['direct', 'group'])

/** Report a field that must be a non-empty string. */
function requireText(value: unknown, field: string, fail: InvariantFailure): void {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`whatsapp/inbound ${field} must be a non-empty string`)
  }
}

/**
 * Validate one delivered inbound message's durable provenance.
 *
 * Deliberately silent on routing: which session a message landed in is the
 * deployment's `route` policy, and a log written under one route must still
 * replay after the deployment changes it.
 */
function validateInbound(data: Record<string, unknown>, fail: InvariantFailure): void {
  requireText(data.messageId, 'messageId', fail)
  requireText(data.chatId, 'chatId', fail)
  requireText(data.senderId, 'senderId', fail)
  requireText(data.timestamp, 'timestamp', fail)
  if (typeof data.chatKind !== 'string' || !CHAT_KINDS.has(data.chatKind)) {
    fail(`whatsapp/inbound carries unknown chatKind ${JSON.stringify(data.chatKind)}`)
  }
  const content = data.content
  if (typeof content !== 'object' || content === null) {
    fail('whatsapp/inbound content must be an object')
    return
  }
  const { kind, text, mediaType } = content as Record<string, unknown>
  if (kind === 'text') requireText(text, 'content.text', fail)
  else if (kind === 'unsupported') requireText(mediaType, 'content.mediaType', fail)
  else fail(`whatsapp/inbound carries unknown content kind ${JSON.stringify(kind)}`)
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'whatsapp/inbound') validateInbound(event.data as unknown as Record<string, unknown>, fail)
}

/** Install validation for loaded and newly appended inbound records. */
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
export const name = 'whatsapp-workspace-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Register the WhatsApp Workspace invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
