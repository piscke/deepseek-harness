import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { WhatsAppChatId, WhatsAppMessageId, type WhatsAppMessage } from '@deepseek-ai/dsh-whatsapp'
import { WhatsAppSessionInbox, inboundEvent } from '../src/index.ts'

const anaId = WhatsAppChatId('5511999990000@s.whatsapp.net')

/**
 * A message with the given id.
 * @param id - the provider message id.
 * @param overrides - fields replacing the defaults.
 * @param omit - optional fields to drop, as a chat or sender without a display name arrives.
 * @returns the assembled message.
 */
function message(
  id: string,
  overrides: Partial<WhatsAppMessage> = {},
  omit: readonly ('chatName' | 'senderName')[] = [],
): WhatsAppMessage {
  const merged: WhatsAppMessage = {
    id: WhatsAppMessageId(id),
    chatId: anaId,
    chatKind: 'direct',
    chatName: 'Ana',
    senderId: anaId,
    senderName: 'Ana',
    fromMe: false,
    timestamp: '2026-08-21T10:00:00.000Z',
    content: { kind: 'text', text: `body ${id}` },
    ...overrides,
  }
  return Object.fromEntries(Object.entries(merged).filter(([key]) => !omit.includes(key as 'chatName'))) as WhatsAppMessage
}

/**
 * An Agent stand-in exposing exactly the phase control the inbox drives:
 * `busy` refuses the maintenance claim the way a turn-driving agent does, and
 * `releaseIdle` publishes the idle boundary the inbox parks on. `inject` and
 * `followup` are recorded apart so a test can tell pending context from a
 * framing that woke a turn, and together in arrival order.
 */
class FakeAgent {
  readonly id = SessionId('whatsapp-contacts')
  readonly session = Session.create(SessionId('whatsapp-contacts'))
  readonly delivered: UserMessage[] = []
  readonly followups: UserMessage[] = []
  readonly injections: UserMessage[] = []
  busy = false
  maintenanceCalls = 0
  private idle = Promise.withResolvers<undefined>()

  followup(message: UserMessage): void {
    this.followups.push(message)
    this.delivered.push(message)
  }

  inject(message: UserMessage): void {
    this.injections.push(message)
    this.delivered.push(message)
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.maintenanceCalls += 1
    if (this.busy) throw new Error('agent is driving a turn')
    return task(new AbortController().signal)
  }

  whenIdle(): Promise<void> {
    return this.idle.promise
  }

  releaseIdle(): void {
    this.idle.resolve(undefined)
    this.idle = Promise.withResolvers<undefined>()
  }

  /** The text of every framing this agent received, in delivery order. */
  texts(): string[] {
    return this.delivered.map(entry => entry.content.map(block => block.type === 'text' ? block.text : '').join(''))
  }

  /** The `whatsapp/inbound` message ids recorded on this agent's session. */
  logged(): string[] {
    return [...this.session.events]
      .filter(event => event.type === 'whatsapp/inbound')
      .map(event => (event.data as { messageId: string }).messageId)
  }

  asAgent(): Agent {
    return this as unknown as Agent
  }
}

function harness(agent = new FakeAgent()) {
  const ctx = new Context()
  const warnings: string[] = []
  ctx.logger.warn = ((text: string) => { warnings.push(text) }) as typeof ctx.logger.warn
  return { ctx, agent, warnings, inbox: new WhatsAppSessionInbox(ctx, agent.asAgent()) }
}

/** Let every already-scheduled microtask settle. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

describe('inboundEvent', () => {
  it('carries the identity the framing text cannot be parsed back into', () => {
    expect(inboundEvent(message('M1'))).toEqual({
      messageId: 'M1',
      chatId: anaId,
      chatKind: 'direct',
      chatName: 'Ana',
      senderId: anaId,
      senderName: 'Ana',
      timestamp: '2026-08-21T10:00:00.000Z',
      content: { kind: 'text', text: 'body M1' },
    })
  })

  it('omits display names the account has never resolved', () => {
    const event = inboundEvent(message('M1', {}, ['chatName', 'senderName']))
    expect(event).not.toHaveProperty('chatName')
    expect(event).not.toHaveProperty('senderName')
  })
})

describe('WhatsAppSessionInbox', () => {
  it('logs then leaves each queued message pending as context, waking no turn', async () => {
    const { agent, inbox } = harness()
    inbox.enqueue(message('M1'), 'context')
    await settle()

    expect(agent.logged()).toEqual(['M1'])
    expect(agent.texts()[0]).toContain('body M1')
    expect(agent.followups).toEqual([])
    expect(agent.injections[0]?.source).toEqual({
      kind: 'plugin',
      plugin: 'whatsapp-workspace',
      form: 'notice',
      summary: 'Ana: body M1',
    })
    await inbox.dispose()
  })

  it('logs then delivers each queued message as its own follow-up under turn delivery', async () => {
    const { agent, inbox } = harness()
    inbox.enqueue(message('M1'), 'turn')
    inbox.enqueue(message('M2'), 'turn')
    await settle()

    expect(agent.logged()).toEqual(['M1', 'M2'])
    expect(agent.injections).toEqual([])
    expect(agent.followups).toHaveLength(2)
    expect(agent.texts()[0]).toContain('body M1')
    await inbox.dispose()
  })

  it('honours the mode captured per message, so a settings change mid-queue applies from there on', async () => {
    const { agent, inbox } = harness()
    agent.busy = true
    inbox.enqueue(message('M1'), 'context')
    await settle()
    inbox.enqueue(message('M2'), 'turn')
    await settle()

    agent.busy = false
    agent.releaseIdle()
    await settle()

    expect(agent.injections).toHaveLength(1)
    expect(agent.followups).toHaveLength(1)
    expect(agent.texts().map(text => text.includes('body M1'))).toEqual([true, false])
    await inbox.dispose()
  })

  it('delivers messages queued during one drain in arrival order', async () => {
    const { agent, inbox } = harness()
    inbox.enqueue(message('M1'), 'context')
    inbox.enqueue(message('M2'), 'context')
    await settle()

    expect(agent.logged()).toEqual(['M1', 'M2'])
    await inbox.dispose()
  })

  it('delivers everything waiting at one idle boundary as a single claim', async () => {
    const { agent, inbox } = harness()
    agent.busy = true
    inbox.enqueue(message('M1'), 'context')
    await settle()
    inbox.enqueue(message('M2'), 'context')
    await settle()

    agent.busy = false
    agent.maintenanceCalls = 0
    agent.releaseIdle()
    await settle()

    expect(agent.logged()).toEqual(['M1', 'M2'])
    expect(agent.maintenanceCalls).toBe(1)
    await inbox.dispose()
  })

  it('waits for the idle boundary rather than joining a running turn', async () => {
    const { agent, inbox } = harness()
    agent.busy = true
    inbox.enqueue(message('M1'), 'context')
    await settle()
    expect(agent.logged()).toEqual([])

    inbox.enqueue(message('M2'), 'context')
    await settle()
    expect(agent.logged()).toEqual([])

    agent.busy = false
    agent.releaseIdle()
    await settle()
    expect(agent.logged()).toEqual(['M1', 'M2'])
    await inbox.dispose()
  })

  it('parks on one idle boundary at a time', async () => {
    const { agent, inbox } = harness()
    agent.busy = true
    inbox.enqueue(message('M1'), 'context')
    await settle()
    inbox.enqueue(message('M2'), 'context')
    await settle()

    // Both attempts share the single park: the second claim is refused while
    // the first wait is outstanding, so no second `whenIdle` is registered.
    agent.busy = false
    agent.releaseIdle()
    await settle()
    expect(agent.logged()).toEqual(['M1', 'M2'])
    await inbox.dispose()
  })

  it('contains one unloggable message without blocking the rest', async () => {
    const agent = new FakeAgent()
    // Bound through a loose alias: `Session.append` is generic over the event
    // map, and a bound copy of it cannot be called with an erased key.
    const append = agent.session.append.bind(agent.session) as unknown as (type: string, data: unknown) => unknown
    vi.spyOn(agent.session, 'append').mockImplementation(((type: string, data: unknown) => {
      if ((data as { messageId?: string }).messageId === 'M1') throw new Error('log is full')
      return append(type, data)
    }) as typeof agent.session.append)
    const { inbox, warnings } = harness(agent)

    inbox.enqueue(message('M1'), 'context')
    inbox.enqueue(message('M2'), 'context')
    await settle()

    expect(agent.logged()).toEqual(['M2'])
    expect(agent.texts()).toHaveLength(1)
    expect(warnings[0]).toMatch(/dropped message "M1".*log is full/)
    await inbox.dispose()
  })

  it('reports a delivery loop that fails outright', async () => {
    const agent = new FakeAgent()
    agent.runMaintenance = () => Promise.reject(new Error('agent went away'))
    const { inbox, warnings } = harness(agent)

    inbox.enqueue(message('M1'), 'context')
    await settle()
    expect(warnings[0]).toMatch(/delivery loop failed.*agent went away/)
    await inbox.dispose()
  })

  it('reports an idle wait that fails', async () => {
    const agent = new FakeAgent()
    agent.busy = true
    agent.whenIdle = () => Promise.reject(new Error('agent disposed'))
    const { inbox, warnings } = harness(agent)

    inbox.enqueue(message('M1'), 'context')
    await settle()
    expect(warnings[0]).toMatch(/idle wait failed.*agent disposed/)
    await inbox.dispose()
  })

  it('drops what never left the queue on disposal', async () => {
    const { agent, inbox } = harness()
    agent.busy = true
    inbox.enqueue(message('M1'), 'context')
    await settle()

    await inbox.dispose()
    agent.busy = false
    agent.releaseIdle()
    await settle()

    expect(agent.logged()).toEqual([])
    inbox.enqueue(message('M2'), 'context')
    await settle()
    expect(agent.logged()).toEqual([])
    await inbox.dispose()
  })

  it('renders a non-Error failure', async () => {
    const agent = new FakeAgent()
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the scenario under test.
    agent.runMaintenance = () => Promise.reject('plain rejection')
    const { inbox, warnings } = harness(agent)

    inbox.enqueue(message('M1'), 'context')
    await settle()
    expect(warnings[0]).toMatch(/plain rejection/)
    await inbox.dispose()
  })
})
