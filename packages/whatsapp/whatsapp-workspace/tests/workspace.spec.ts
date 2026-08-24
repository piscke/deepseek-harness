import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentFactory, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
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
  type WhatsAppChat,
  type WhatsAppMessage,
  type WhatsAppProvider,
} from '@deepseek-ai/dsh-whatsapp'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as workspacePlugin from '../src/index.ts'
import { chatSessionId } from '../src/index.ts'

const anaId = WhatsAppChatId('5511999990000@s.whatsapp.net')
const groupId = WhatsAppChatId('12036300000@g.us')

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.allSettled(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Message fields a test replaces, including the ones it drops by naming `undefined`. */
type MessageOverrides = { [K in keyof WhatsAppMessage]?: WhatsAppMessage[K] | undefined }

function message(id: string, overrides: MessageOverrides = {}): WhatsAppMessage {
  const built: Record<string, unknown> = {
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
  // An override of `undefined` means the provider reported no such field, which
  // an optional field carries by being absent rather than by holding undefined.
  const present = Object.entries(built).filter(([, value]) => value !== undefined)
  return Object.fromEntries(present) as unknown as WhatsAppMessage
}

/**
 * A provider that never publishes on its own; tests emit the inbound stream
 * directly and decide what the account can name.
 * @param names - display name per chat id; a conversation absent from it resolves unnamed.
 */
function provider(names: Record<string, string>): WhatsAppProvider {
  return {
    id: 'scripted',
    available: () => true,
    status: () => ({ state: 'online', accountId: '5511888880000' }),
    listChats: () => Promise.resolve([]),
    resolveChat: (chatId) => {
      const name = names[chatId]
      if (name === undefined) return Promise.reject(new Error('this conversation has no name here'))
      return Promise.resolve({ id: chatId, kind: 'direct', name, unreadCount: 0 } satisfies WhatsAppChat)
    },
    fetchMessages: () => Promise.resolve([]),
    send: () => Promise.reject(new Error('sending is not part of this test')),
    markRead: () => Promise.resolve(),
  }
}

/** A live agent stand-in exposing the phase control the inbox drives. */
class StubAgent {
  /** Every framing this agent received, whichever delivery mode carried it. */
  readonly delivered: UserMessage[] = []
  readonly followups: UserMessage[] = []
  readonly injections: UserMessage[] = []

  constructor(readonly id: SessionId, readonly session: Session) {}

  followup(message: UserMessage): void {
    this.followups.push(message)
    this.delivered.push(message)
  }

  inject(message: UserMessage): void {
    this.injections.push(message)
    this.delivered.push(message)
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
  /** Display name the account answers with, per chat id. */
  names?: Record<string, string>
  /** Compose a preset roster, so conversation sessions are composed from it. */
  presets?: boolean
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
  await ctx.plugin(AgentDefaultModel, { provider: 'stub-provider', model: 'stub-model' })
  await ctx.plugin(SessionTitle, { fallbackMaxWords: 8, fallbackMaxBytes: 120, maxTitleBytes: 200 })
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend()
  ctx.storage.backend.register('memory', backend)
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  const stored = options.stored?.(root) ?? []
  ctx.provide('sessionPersistence', { list: () => Promise.resolve(stored) } as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(WhatsAppRuntime)
  ctx.whatsapp.register(provider(options.names ?? {}))

  const mounted: (string | undefined)[] = []
  if (options.presets === true) {
    ctx.provide('agentPresets', {
      resolve: (id?: string) => Promise.resolve({ id: id ?? 'roster-default' }),
      mount: (_agentCtx: Context, id?: string) => {
        mounted.push(id)
        return Promise.resolve({ id })
      },
    } as never)
  }

  const agents = new Map<SessionId, StubAgent>()
  const selections: (AgentOptions | undefined)[] = []
  const open = (session: Session): AgentHandle => {
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
  /** Publish one agent and run the caller's composition over it, as the real factory does. */
  const publish = async (session: Session, setup?: (agentCtx: Context) => unknown): Promise<AgentHandle> => {
    const handle = open(session)
    await setup?.(ctx.extend({ agent: handle.agent }))
    return handle
  }
  const factory: AgentFactory = {
    createAgent: (_ownerCtx, createOptions) => {
      selections.push(createOptions.agentOptions)
      return publish(
        ctx.sessions.create(createOptions.sessionId, createOptions.meta === undefined ? {} : { meta: createOptions.meta }),
        createOptions.setup,
      )
    },
    resume: (_ownerCtx, resumeOptions) => {
      const header = stored.find(entry => entry.id === resumeOptions.resumeSessionId)
      if (header === undefined) throw new Error(`no stored session "${resumeOptions.resumeSessionId}"`)
      const session = ctx.sessions.create(header.id, {
        meta: {
          ...header.cwd === undefined ? {} : { cwd: header.cwd },
          ...header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset },
        },
      })
      const title = options.storedTitles?.[header.id]
      if (title !== undefined) ctx.sessionTitle.rename(session, title)
      return publish(session, resumeOptions.setup)
    },
  }
  ctx.agents.setFactory(factory)

  const directory = options.directory?.(root) ?? root
  const fiber = await ctx.plugin(workspacePlugin, { directory, ...options.config })
  return { ctx, root, fiber, agents, warnings, mounted, open, selections, pool: backend.pool }
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
  it('registers the directory as a Workspace and opens no session before a conversation arrives', async () => {
    const { ctx, root, agents } = await harness()

    const [workspace] = ctx.workspaceRegistry.list()
    expect(workspace?.path).toBe(root)
    expect(workspace?.title).toBe('WhatsApp')
    expect(workspace?.sessionIds).toEqual([])
    expect(agents.size).toBe(0)
  })

  it('opens one session per conversation, titled by the name the account resolved', async () => {
    const { ctx, root, agents } = await harness({ names: { [anaId]: 'Ana Silva' } })

    ctx.emit('whatsapp/message-received', message('M1'))
    ctx.emit('whatsapp/message-received', message('M2', { chatId: groupId, chatKind: 'group', chatName: 'Time' }))
    await settle()

    const ana = agents.get(chatSessionId(anaId))
    expect(ana?.logged()).toEqual(['M1'])
    expect(ana?.session.header.cwd).toBe(root)
    expect(ctx.sessionTitle.get(ana?.session as Session)?.title).toBe('Ana Silva')
    const text = ana?.delivered[0]?.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain(`[chat_id: ${anaId}]`)
    // The account named no group here, so the message's own name is the title.
    expect(ctx.sessionTitle.get(agents.get(chatSessionId(groupId))?.session as Session)?.title).toBe('Time')
    // Two conversations open concurrently, so the Workspace lists them in
    // whatever order their names resolved in.
    expect([...ctx.workspaceRegistry.list()[0]?.sessionIds ?? []].sort())
      .toEqual([chatSessionId(anaId), chatSessionId(groupId)].sort())
  })

  it('keeps one session per conversation across messages', async () => {
    const { ctx, agents } = await harness()

    ctx.emit('whatsapp/message-received', message('M1'))
    await settle()
    ctx.emit('whatsapp/message-received', message('M2'))
    await settle()

    expect(agents.size).toBe(1)
    expect(agents.get(chatSessionId(anaId))?.logged()).toEqual(['M1', 'M2'])
  })

  it('restores an archived conversation to the sidebar when it speaks again', async () => {
    const { ctx, agents } = await harness()
    const sessionId = chatSessionId(anaId)

    ctx.emit('whatsapp/message-received', message('M1'))
    await settle()
    await ctx.workspaceRegistry.archiveSession(sessionId)
    expect(ctx.workspaceRegistry.archivedSessionIds).toEqual([sessionId])

    ctx.emit('whatsapp/message-received', message('M2'))
    await settle()

    // The agent answers a hidden conversation either way, so the row comes back.
    expect(ctx.workspaceRegistry.archivedSessionIds).toEqual([])
    expect(agents.get(sessionId)?.logged()).toEqual(['M1', 'M2'])
  })

  it('warns and still delivers when the archive set cannot be written', async () => {
    const { ctx, agents, warnings, pool } = await harness()
    const sessionId = chatSessionId(anaId)

    ctx.emit('whatsapp/message-received', message('M1'))
    await settle()
    await ctx.workspaceRegistry.archiveSession(sessionId)
    pool.failNextWrites = 1

    ctx.emit('whatsapp/message-received', message('M2'))
    await settle()

    expect(warnings.some(text => text.includes(`could not unarchive session "${sessionId}"`))).toBe(true)
    // Delivery never waits on the display write, so the message still lands.
    expect(agents.get(sessionId)?.logged()).toEqual(['M1', 'M2'])
    expect(ctx.workspaceRegistry.archivedSessionIds).toEqual([sessionId])
  })

  it('answers only the conversation kinds the scope names', async () => {
    const { ctx, agents } = await harness({ config: { chats: 'groups' } })

    ctx.emit('whatsapp/message-received', message('M1'))
    ctx.emit('whatsapp/message-received', message('M2', { chatId: groupId, chatKind: 'group' }))
    await settle()

    expect(agents.has(chatSessionId(anaId))).toBe(false)
    expect(agents.get(chatSessionId(groupId))?.logged()).toEqual(['M2'])
  })

  it('delivers a replayed id once and never the account\'s own message', async () => {
    const { ctx, agents } = await harness()

    ctx.emit('whatsapp/message-received', message('M1'))
    ctx.emit('whatsapp/message-received', message('M1'))
    ctx.emit('whatsapp/message-received', message('M3', { fromMe: true }))
    await settle()

    expect(agents.get(chatSessionId(anaId))?.logged()).toEqual(['M1'])
  })

  it('drops a conversation the deployment filtered out', async () => {
    const { ctx, agents } = await harness({ config: { denyChatIds: [anaId] } })

    ctx.emit('whatsapp/message-received', message('M1'))
    await settle()

    expect(agents.size).toBe(0)
  })

  it('routes an unnameable conversation anyway, reporting why it has no name', async () => {
    const { ctx, agents, warnings } = await harness()

    ctx.emit('whatsapp/message-received', message('M1', { chatName: undefined }))
    await settle()

    const session = agents.get(chatSessionId(anaId))?.session as Session
    expect(ctx.sessionTitle.get(session)?.title).toBe(anaId)
    expect(warnings[0]).toMatch(/could not resolve a name for chat/)
  })

  it('retitles a conversation the account names after its session was opened', async () => {
    const { ctx, agents } = await harness()

    ctx.emit('whatsapp/message-received', message('M1', { chatId: groupId, chatKind: 'group', chatName: undefined }))
    await settle()
    ctx.emit('whatsapp/chat-named', groupId, 'Equipe de Vendas')
    await settle()

    const session = agents.get(chatSessionId(groupId))?.session as Session
    expect(titles(session)).toEqual([groupId, 'Equipe de Vendas'])
  })

  it('names no conversation it never opened', async () => {
    const { ctx, agents } = await harness()

    ctx.emit('whatsapp/chat-named', anaId, 'Ana Silva')
    await settle()

    expect(agents.size).toBe(0)
  })

  it('composes a new conversation session from the configured preset and records it', async () => {
    const { ctx, agents, mounted } = await harness({ presets: true, config: { agentPreset: 'interpreter' } })

    ctx.emit('whatsapp/message-received', message('M1'))
    await settle()

    expect(mounted).toEqual(['interpreter'])
    expect(agents.get(chatSessionId(anaId))?.session.header.agentPreset).toBe('interpreter')
  })

  it('composes the roster default when the deployment names no preset', async () => {
    const { ctx, mounted } = await harness({ presets: true })

    ctx.emit('whatsapp/message-received', message('M1'))
    await settle()

    expect(mounted).toEqual(['roster-default'])
  })

  it('composes nothing when no preset roster is loaded', async () => {
    const { ctx, agents } = await harness({ config: { agentPreset: 'interpreter' } })

    ctx.emit('whatsapp/message-received', message('M1'))
    await settle()

    expect(agents.get(chatSessionId(anaId))?.session.header.agentPreset).toBeUndefined()
  })

  it('opens the conversation on the composed default model selection', async () => {
    const { ctx, selections } = await harness()

    ctx.emit('whatsapp/message-received', message('M1'))
    await settle()

    expect(selections).toEqual([{ provider: 'stub-provider', model: 'stub-model' }])
  })

  it('resumes a stored conversation under the preset its history was produced with', async () => {
    const { ctx, mounted, agents } = await harness({
      presets: true,
      config: { agentPreset: 'interpreter' },
      stored: root => [{
        version: 0,
        id: chatSessionId(anaId),
        createdAt: 0,
        cwd: root,
        agentPreset: 'as-recorded',
      }],
      storedTitles: { [chatSessionId(anaId)]: 'Ana' },
    })

    ctx.emit('whatsapp/message-received', message('M1'))
    await settle()

    expect(mounted).toEqual(['as-recorded'])
    // A pinned title that already matches is left alone.
    expect(titles(agents.get(chatSessionId(anaId))?.session as Session)).toEqual(['Ana'])
  })

  it('delivers into the agent already published for that conversation', async () => {
    const { ctx, agents, open, root } = await harness()
    const sessionId = chatSessionId(anaId)
    open(ctx.sessions.create(sessionId, { meta: { cwd: root } }))

    ctx.emit('whatsapp/message-received', message('M1'))
    await settle()

    expect(agents.size).toBe(1)
    expect(agents.get(sessionId)?.logged()).toEqual(['M1'])
  })

  it('reports a conversation whose session cannot be opened, without dropping the account', async () => {
    const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-whatsapp-elsewhere-')))
    roots.push(elsewhere)
    const { ctx, agents, warnings } = await harness({
      names: { [anaId]: 'Ana', [groupId]: 'Time' },
      stored: () => [{ version: 0, id: chatSessionId(anaId), createdAt: 0, cwd: elsewhere }],
    })

    ctx.emit('whatsapp/message-received', message('M1'))
    ctx.emit('whatsapp/message-received', message('M2', { chatId: groupId, chatKind: 'group', chatName: 'Time' }))
    await settle()

    expect(warnings[0]).toMatch(/could not open session .* for chat/)
    expect(warnings[0]).toMatch(/is recorded under .* not the WhatsApp directory/)
    // The conversation that failed is forgotten, so a later message retries it,
    // and every other conversation keeps being answered.
    expect(agents.get(chatSessionId(groupId))?.logged()).toEqual(['M2'])
    ctx.emit('whatsapp/message-received', message('M3'))
    await settle()
    expect(warnings).toHaveLength(2)
  })

  it('stops routing once the plugin is unloaded', async () => {
    const { ctx, fiber, agents } = await harness()
    await fiber.dispose()

    ctx.emit('whatsapp/message-received', message('M1'))
    await settle()

    expect(agents.size).toBe(0)
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
