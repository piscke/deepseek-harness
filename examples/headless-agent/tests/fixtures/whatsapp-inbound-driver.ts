#!/usr/bin/env node
/**
 * Snapshot-only Loader driver for the WhatsApp Workspace: publish one inbound
 * message on the seam and stream the session the router opens for it.
 *
 * Unlike the fixture-turn driver, no agent exists when the composition
 * settles — the conversation's session and its agent are what the router
 * produces, which is the behavior under snapshot.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { WhatsAppChatId, WhatsAppMessageId, type WhatsAppMessage } from '@deepseek-ai/dsh-whatsapp'

const NAME = 'whatsapp-inbound-driver'
const [configPath, ...textParts] = process.argv.slice(2)
if (configPath === undefined || textParts.length === 0 || textParts.every(part => part.trim() === '')) {
  throw new Error(`${NAME}: expected <config-path> <message text...>`)
}

const CHAT_ID = WhatsAppChatId('5511999990000@s.whatsapp.net')

const message: WhatsAppMessage = {
  id: WhatsAppMessageId('ana-inbound-1'),
  chatId: CHAT_ID,
  chatKind: 'direct',
  senderId: CHAT_ID,
  senderName: 'Ana',
  fromMe: false,
  timestamp: '2026-08-22T10:10:00.000Z',
  content: { kind: 'text', text: textParts.join(' ') },
}

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
try {
  loadEnv(NAME)
  ctx = await boot(NAME, resolveConfigPath(configPath, undefined))
  const settled = ctx

  const opened = new Promise<Agent>((resolve) => {
    settled.on('agent/created', (payload: { agent: Agent }) => { resolve(payload.agent) })
  })
  // The turn is driven by the router's delivery, so the observable end of the
  // run is the assistant message rather than a task this driver submitted.
  let answered: () => void
  const replied = new Promise<void>((resolve) => { answered = resolve })
  settled.on('session/event', (session: { id: string }, event: SessionEvent) => {
    process.stdout.write(`${JSON.stringify({ type: 'session_event', sessionId: session.id, event })}\n`)
    if (event.type === 'assistant/message') answered()
  })

  settled.emit('whatsapp/message-received', message)
  const agent = await opened
  await replied
  await agent.whenIdle()
  await settled.sessions.flush(agent.session)
  process.stdout.write(`${JSON.stringify({
    type: 'result',
    sessionId: agent.session.id,
    title: settled.sessionTitle.get(agent.session)?.title ?? '',
    output: 'WHATSAPP_ROUTED',
  })}\n`)
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
