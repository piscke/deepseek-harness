import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import WhatsAppRuntime, {
  WhatsAppChatId,
  WhatsAppMessageId,
  type WhatsAppMessage,
  type WhatsAppProvider,
} from '@deepseek-ai/dsh-whatsapp'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as workspacePlugin from '../src/index.ts'
import { CONTACTS_SESSION_ID, GROUPS_SESSION_ID, chatSessionId } from '../src/index.ts'

const anaId = WhatsAppChatId('5511999990000@s.whatsapp.net')
const groupId = WhatsAppChatId('12036300000@g.us')

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.allSettled(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function message(id: string, overrides: Partial<WhatsAppMessage> = {}): WhatsAppMessage {
  return {
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
}

/** A provider that never publishes on its own; tests emit the inbound stream directly. */
function provider(): WhatsAppProvider {
  return {
    id: 'scripted',
    available: () => true,
    status: () => ({ state: 'online', accountId: '5511888880000' }),
    listChats: () => Promise.resolve([]),
    resolveChat: () => Promise.reject(new Error('resolving is not part of this test')),
    fetchMessages: () => Promise.resolve([]),
    send: () => Promise.reject(new Error('sending is not part of this test')),
    markRead: () => Promise.resolve(),
  }
}

/** A live agent stand-in exposing the phase control the inbox drives. */
class StubAgent {
  readonly followups: UserMessage[] = []

  constructor(readonly id: SessionId, readonly session: Session) {}

  followup(message: UserMessage): void {
    this.followups.push(message)
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return task(new AbortController().signal)
  }

  whenIdle(): Promise<void> {
    return Promise.resolve()
  }

  /** The `whatsapp/inbound` message ids recorded on this agent's session. */
  logged(): string[] {
    return [...this.session.events]
      .filter(event => event.type === 'whatsapp/inbound')
      .map(event => (event.data as { messageId: string }).messageId)
  }
}

interface HarnessOptions {
  config?: Partial<workspacePlugin.Config>
  /** Session headers persistence reports, so the plugin resumes instead of creating. */
  stored?: (root: string) => SessionHeader[]
  /** Title a resumed log already carries, per session id. */
  storedTitles?: Record<string, string>
  /** Directory the plugin is pointed at, when it is not the harness root. */
  directory?: (root: string) => string
}

/** Compose real Session, Agent, Title, Storage, Domain, Workspace, and WhatsApp services. */
async function harness(options: HarnessOptions = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-whatsapp-workspace-')))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  const warnings: string[] = []
  ctx.logger.warn = ((text: string) => { warnings.push(text) }) as typeof ctx.logger.warn

  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionTitle, { fallbackMaxWords: 8, fallbackMaxBytes: 120, maxTitleBytes: 200 })
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  const stored = options.stored?.(root) ?? []
  ctx.provide('sessionPersistence', { list: () => Promise.resolve(stored) } as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(WhatsAppRuntime)
  ctx.whatsapp.register(provider())

  const agents = new Map<SessionId, StubAgent>()
  const open = (session: Session) => {
    const agent = new StubAgent(session.id, session)
    agents.set(session.id, agent)
    const unregister = ctx.agents.register(agent as unknown as Agent)
    return {
      agent: agent as unknown as Agent,
      dispose: () => {
        unregister()
        return Promise.resolve()
      },
    }
  }
  const factory: AgentFactory = {
    createAgent: (_ownerCtx, createOptions) => Promise.resolve(open(
      ctx.sessions.create(createOptions.sessionId, createOptions.meta === undefined ? {} : { meta: createOptions.meta }),
    )),
    resume: (_ownerCtx, resumeOptions) => {
      const header = stored.find(entry => entry.id === resumeOptions.resumeSessionId)
      if (header === undefined) throw new Error(`no stored session "${resumeOptions.resumeSessionId}"`)
      const session = ctx.sessions.create(header.id, { meta: header.cwd === undefined ? {} : { cwd: header.cwd } })
      const title = options.storedTitles?.[header.id]
      if (title !== undefined) ctx.sessionTitle.rename(session, title)
      return Promise.resolve(open(session))
    },
  }
  ctx.agents.setFactory(factory)

  const directory = options.directory?.(root) ?? root
  const fiber = await ctx.plugin(workspacePlugin, { route: 'category', directory, ...options.config })
  return { ctx, root, fiber, agents, warnings }
}

/** Let the router's opening (which touches the filesystem) and delivery settle. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 30) })

/** Titles recorded on one session, in append order. */
function titles(session: Session): string[] {
  return [...session.events]
    .filter(event => event.type === 'session/title')
    .map(event => (event.data as { title: string }).title)
}

describe('the WhatsApp Workspace', () => {
  it('registers the directory as a Workspace holding the category sessions', async () => {
    const { ctx, root, agents } = await harness()

    const [workspace] = ctx.workspaceRegistry.list()
    expect(workspace?.path).toBe(root)
    expect(workspace?.title).toBe('WhatsApp')
    expect(workspace?.sessionIds).toEqual([CONTACTS_SESSION_ID, GROUPS_SESSION_ID])

    const groups = agents.get(GROUPS_SESSION_ID)
    expect(groups?.session.header.cwd).toBe(root)
    expect(ctx.sessionTitle.get(groups?.session as Session)?.title).toBe('Groups')
    expect(ctx.sessionTitle.get(agents.get(CONTACTS_SESSION_ID)?.session as Session)?.title).toBe('Contacts')
  })

  it('honors the configured category titles', async () => {
    const { ctx, agents } = await harness({ config: { groupsTitle: 'Grupos', contactsTitle: 'Contatos' } })
    expect(ctx.sessionTitle.get(agents.get(GROUPS_SESSION_ID)?.session as Session)?.title).toBe('Grupos')
    expect(ctx.sessionTitle.get(agents.get(CONTACTS_SESSION_ID)?.session as Session)?.title).toBe('Contatos')
  })

  it('delivers an inbound message to its category session, identifying the chat', async () => {
    const { ctx, agents } = await harness()

    ctx.emit('whatsapp/message-received', message('M1'))
    ctx.emit('whatsapp/message-received', message('M2', { chatId: groupId, chatKind: 'group', chatName: 'Time' }))
    await settle()

    const contacts = agents.get(CONTACTS_SESSION_ID)
    expect(contacts?.logged()).toEqual(['M1'])
    const text = contacts?.followups[0]?.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain(`[chat_id: ${anaId}]`)
    expect(agents.get(GROUPS_SESSION_ID)?.logged()).toEqual(['M2'])
  })

  it('delivers a replayed id once and never the account\'s own message', async () => {
    const { ctx, agents } = await harness()

    ctx.emit('whatsapp/message-received', message('M1'))
    ctx.emit('whatsapp/message-received', message('M1'))
    ctx.emit('whatsapp/message-received', message('M3', { fromMe: true }))
    await settle()

    expect(agents.get(CONTACTS_SESSION_ID)?.logged()).toEqual(['M1'])
  })

  it('drops a conversation the deployment filtered out', async () => {
    const { ctx, agents } = await harness({ config: { denyChatIds: [anaId] } })

    ctx.emit('whatsapp/message-received', message('M1'))
    await settle()

    expect(agents.get(CONTACTS_SESSION_ID)?.logged()).toEqual([])
  })

  it('opens no standing session under the per-chat route and one per conversation on demand', async () => {
    const { ctx, agents } = await harness({ config: { route: 'per-chat' } })
    expect(agents.size).toBe(0)

    ctx.emit('whatsapp/message-received', message('M1'))
    await settle()

    const sessionId = chatSessionId(anaId)
    expect(agents.get(sessionId)?.logged()).toEqual(['M1'])
    expect(ctx.sessionTitle.get(agents.get(sessionId)?.session as Session)?.title).toBe('Ana')
    expect(ctx.workspaceRegistry.list()[0]?.sessionIds).toEqual([sessionId])
  })

  it('keeps one session per conversation across messages', async () => {
    const { ctx, agents } = await harness({ config: { route: 'per-chat' } })

    ctx.emit('whatsapp/message-received', message('M1'))
    await settle()
    ctx.emit('whatsapp/message-received', message('M2'))
    await settle()

    expect(agents.size).toBe(1)
    expect(agents.get(chatSessionId(anaId))?.logged()).toEqual(['M1', 'M2'])
  })

  it('resumes a stored session instead of starting an empty one', async () => {
    const { agents, ctx } = await harness({
      stored: root => [
        { version: 0, id: GROUPS_SESSION_ID, createdAt: 0, cwd: root },
        { version: 0, id: CONTACTS_SESSION_ID, createdAt: 0, cwd: root },
      ],
      storedTitles: { [GROUPS_SESSION_ID]: 'Groups', [CONTACTS_SESSION_ID]: 'Renamed' },
    })

    // A pinned title that already matches is left alone; a divergent one is re-pinned.
    expect(titles(agents.get(GROUPS_SESSION_ID)?.session as Session)).toEqual(['Groups'])
    expect(titles(agents.get(CONTACTS_SESSION_ID)?.session as Session)).toEqual(['Renamed', 'Contacts'])
    expect(ctx.workspaceRegistry.list()[0]?.sessionIds).toHaveLength(2)
  })

  it('fails loud when a stored session lives outside the WhatsApp directory', async () => {
    const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-whatsapp-elsewhere-')))
    roots.push(elsewhere)

    await expect(harness({
      stored: () => [{ version: 0, id: GROUPS_SESSION_ID, createdAt: 0, cwd: elsewhere }],
    })).rejects.toThrow(/is recorded under .* not the WhatsApp directory/)
  })

  it('reports a conversation whose session cannot be opened, without dropping the account', async () => {
    const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-whatsapp-elsewhere-')))
    roots.push(elsewhere)
    const { ctx, warnings } = await harness({
      config: { route: 'per-chat' },
      stored: () => [{ version: 0, id: chatSessionId(anaId), createdAt: 0, cwd: elsewhere }],
    })

    ctx.emit('whatsapp/message-received', message('M1'))
    await settle()

    expect(warnings[0]).toMatch(/could not open session .* for chat/)
  })

  it('stops routing once the plugin is unloaded', async () => {
    const { ctx, fiber, agents } = await harness()
    await fiber.dispose()

    ctx.emit('whatsapp/message-received', message('M1'))
    await settle()

    expect(agents.get(CONTACTS_SESSION_ID)?.logged()).toEqual([])
  })

  it('rejects a directory it cannot own', async () => {
    const blocked = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-whatsapp-blocked-')))
    roots.push(blocked)
    writeFileSync(join(blocked, 'file'), 'not a directory')

    await expect(harness({ directory: () => join(blocked, 'file', 'nested') }))
      .rejects.toThrow(/could not create directory/)
    await expect(harness({ directory: () => 'relative/whatsapp' }))
      .rejects.toThrow(/must be absolute/)
  })

  it('rejects a recall bound that cannot suppress a replay', async () => {
    await expect(harness({ config: { seenMessageLimit: 0 } }))
      .rejects.toThrow(/seenMessageLimit must be a positive integer/)
    await expect(harness({ config: { seenMessageLimit: 2.5 } }))
      .rejects.toThrow(/seenMessageLimit must be a positive integer/)
  })
})
