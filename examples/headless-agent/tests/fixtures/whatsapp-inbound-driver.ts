#!/usr/bin/env node
/**
 * Snapshot-only Loader driver for the WhatsApp Workspace: publish the account's
 * inbound stream on the seam, then prompt the session the router opens for it.
 *
 * Unlike the fixture-turn driver, no agent exists when the composition
 * settles — the conversation's session and its agent are what the router
 * produces, which is the behavior under snapshot.
 *
 * Three messages are published: one from the contact, one the deployment itself
 * sent coming back as the account's own traffic, and one the operator wrote
 * from the paired phone. Two of them are the conversation; the deployment's own
 * answer is claimed as an echo and never reaches the session, which is what
 * keeps the agent from being woken by its own words.
 *
 * The run has two phases, because inbound delivery is passive by default: the
 * messages accumulate as pending context and wake nothing, and the operator's
 * prompt is what carries them into a model request. The driver asserts the idle
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
/** The answer this deployment sends, which the account observes again as its own. */
const AGENT_ANSWER = 'confirmado, obrigado'
/** What the operator writes into the same conversation from the paired phone. */
const OPERATOR_TEXT = 'era isso mesmo?'
/** How many messages the session is expected to hold: the contact and the operator, never the echo. */
const ROUTED_MESSAGES = 2

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

/** One message the account itself wrote, as a provider republishes its own traffic. */
function ownMessage(id: string, text: string, timestamp: string): WhatsAppMessage {
  return {
    id: WhatsAppMessageId(id),
    chatId: CHAT_ID,
    chatKind: 'direct',
    senderId: CHAT_ID,
    // The account's own display name, which is what a provider reports for the
    // traffic it wrote, whichever device wrote it.
    senderName: 'Marina',
    fromMe: true,
    timestamp,
    content: { kind: 'text', text },
  }
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
  let spliced = 0
  let answered: () => void
  const replied = new Promise<void>((resolve) => { answered = resolve })
  settled.on('session/event', (session: { id: string }, event: SessionEvent) => {
    process.stdout.write(`${JSON.stringify({ type: 'session_event', sessionId: session.id, event })}\n`)
    if (event.type === 'agent/inbox/spliced') {
      spliced += 1
      if (spliced >= ROUTED_MESSAGES) delivered()
    }
    if (event.type === 'assistant/message') answered()
  })

  settled.emit('whatsapp/message-received', message)
  const agent = await opened
  // Dispatched through the seam, so the account's own traffic below is this
  // deployment's answer coming back rather than a person writing.
  await settled.whatsapp.send({ chatId: CHAT_ID, text: AGENT_ANSWER })
  settled.emit('whatsapp/message-received', ownMessage('ana-echo-1', AGENT_ANSWER, '2026-08-22T10:10:05.000Z'))
  settled.emit('whatsapp/message-received', ownMessage('ana-own-1', OPERATOR_TEXT, '2026-08-22T10:10:10.000Z'))
  await pending
  // The whole point of passive delivery: the messages are durably pending and no
  // driver is running, so nothing has reached a model yet.
  await agent.whenIdle()
  const waiting = agent.inbox.nextStep.length
  if (waiting !== ROUTED_MESSAGES || agent.status !== 'idle') {
    throw new Error(
      `${NAME}: expected ${ROUTED_MESSAGES} pending context messages and an idle agent, `
      + `got ${waiting} and "${agent.status}"`,
    )
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
