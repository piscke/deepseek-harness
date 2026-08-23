#!/usr/bin/env node
/**
 * Snapshot-only Loader driver for the WhatsApp Workspace: publish one inbound
 * message on the seam, then prompt the session the router opens for it.
 *
 * Unlike the fixture-turn driver, no agent exists when the composition
 * settles — the conversation's session and its agent are what the router
 * produces, which is the behavior under snapshot.
 *
 * The run has two phases, because inbound delivery is passive by default: the
 * message accumulates as pending context and wakes nothing, and the operator's
 * prompt is what carries it into a model request. The driver asserts the idle
 * gap between them, so a regression that answers a message on its own fails
 * here rather than silently costing a turn per message.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { WhatsAppChatId, WhatsAppMessageId, type WhatsAppMessage } from '@deepseek-ai/dsh-whatsapp'

const NAME = 'whatsapp-inbound-driver'
const [configPath, prompt, ...textParts] = process.argv.slice(2)
if (configPath === undefined || prompt === undefined || prompt.trim() === ''
  || textParts.length === 0 || textParts.every(part => part.trim() === '')) {
  throw new Error(`${NAME}: expected <config-path> <operator prompt> <message text...>`)
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
  let delivered: () => void
  const pending = new Promise<void>((resolve) => { delivered = resolve })
  let answered: () => void
  const replied = new Promise<void>((resolve) => { answered = resolve })
  settled.on('session/event', (session: { id: string }, event: SessionEvent) => {
    process.stdout.write(`${JSON.stringify({ type: 'session_event', sessionId: session.id, event })}\n`)
    if (event.type === 'agent/inbox/spliced') delivered()
    if (event.type === 'assistant/message') answered()
  })

  settled.emit('whatsapp/message-received', message)
  const agent = await opened
  await pending
  // The whole point of passive delivery: the message is durably pending and no
  // driver is running, so nothing has reached a model yet.
  await agent.whenIdle()
  const waiting = agent.inbox.nextStep.length
  if (waiting !== 1 || agent.status !== 'idle') {
    throw new Error(`${NAME}: expected one pending context message and an idle agent, got ${waiting} and "${agent.status}"`)
  }

  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
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
