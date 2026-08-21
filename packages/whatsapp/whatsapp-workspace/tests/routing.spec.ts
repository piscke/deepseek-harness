import { describe, expect, it } from 'vitest'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { WhatsAppChatId, WhatsAppMessageId, type WhatsAppMessage } from '@deepseek-ai/dsh-whatsapp'
import {
  CONTACTS_SESSION_ID,
  CONVERSATIONS_SESSION_ID,
  GROUPS_SESSION_ID,
  SeenMessages,
  chatSessionId,
  isRoutedChat,
  renderInbound,
  resolveDirectory,
  routeMessage,
  standingTargets,
} from '../src/index.ts'
import type { ResolvedConfig } from '../src/index.ts'

const anaId = WhatsAppChatId('5511999990000@s.whatsapp.net')
const groupId = WhatsAppChatId('12036300000@g.us')

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    directory: '~/.dsh/whatsapp',
    workspaceTitle: 'WhatsApp',
    route: 'category',
    groupsTitle: 'Groups',
    contactsTitle: 'Contacts',
    conversationsTitle: 'Conversations',
    allowChatIds: [],
    denyChatIds: [],
    seenMessageLimit: 1000,
    ...overrides,
  }
}

/**
 * A message with the default direct-chat framing.
 * @param overrides - fields replacing the defaults.
 * @param omit - optional fields to drop, as a chat or sender without a display name arrives.
 * @returns the assembled message.
 */
function message(
  overrides: Partial<WhatsAppMessage> = {},
  omit: readonly ('chatName' | 'senderName')[] = [],
): WhatsAppMessage {
  const merged: WhatsAppMessage = {
    id: WhatsAppMessageId('M1'),
    chatId: anaId,
    chatKind: 'direct',
    chatName: 'Ana',
    senderId: anaId,
    senderName: 'Ana',
    fromMe: false,
    timestamp: '2026-08-21T10:00:00.000Z',
    content: { kind: 'text', text: 'oi' },
    ...overrides,
  }
  return Object.fromEntries(Object.entries(merged).filter(([key]) => !omit.includes(key as 'chatName'))) as WhatsAppMessage
}

describe('routing', () => {
  it('routes a direct chat and a group to the category sessions', () => {
    expect(routeMessage(config(), message())).toEqual({ sessionId: CONTACTS_SESSION_ID, title: 'Contacts' })
    expect(routeMessage(config(), message({ chatId: groupId, chatKind: 'group' })))
      .toEqual({ sessionId: GROUPS_SESSION_ID, title: 'Groups' })
  })

  it('routes every conversation to one session under the single route', () => {
    const target = routeMessage(config({ route: 'single' }), message({ chatKind: 'group' }))
    expect(target).toEqual({ sessionId: CONVERSATIONS_SESSION_ID, title: 'Conversations' })
  })

  it('derives a stable per-chat session identity and titles it by display name', () => {
    const target = routeMessage(config({ route: 'per-chat' }), message())
    expect(target).toEqual({ sessionId: chatSessionId(anaId), title: 'Ana' })
    expect(chatSessionId(anaId)).toBe(chatSessionId(anaId))
    expect(chatSessionId(anaId)).not.toBe(chatSessionId(groupId))
    expect(chatSessionId(anaId)).toMatch(/^whatsapp-chat-[0-9a-f]{16}$/)
  })

  it('falls back to the chat id when a per-chat conversation has no display name', () => {
    const target = routeMessage(config({ route: 'per-chat' }), message({}, ['chatName']))
    expect(target?.title).toBe(anaId)
  })

  it('never routes a message the account itself wrote', () => {
    expect(routeMessage(config(), message({ fromMe: true }))).toBeUndefined()
  })

  it.each(['imageMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'protocolMessage'])(
    'routes %s, because the seam publishes only what a person sent',
    (mediaType) => {
      const target = routeMessage(config(), message({ content: { kind: 'unsupported', mediaType } }))
      expect(target).toEqual({ sessionId: CONTACTS_SESSION_ID, title: 'Contacts' })
    },
  )

  it('applies the denylist after the allowlist', () => {
    expect(isRoutedChat(config(), anaId)).toBe(true)
    expect(isRoutedChat(config({ allowChatIds: [groupId] }), anaId)).toBe(false)
    expect(isRoutedChat(config({ allowChatIds: [anaId] }), anaId)).toBe(true)
    expect(isRoutedChat(config({ allowChatIds: [anaId], denyChatIds: [anaId] }), anaId)).toBe(false)
    expect(routeMessage(config({ denyChatIds: [anaId] }), message())).toBeUndefined()
  })

  it('opens the standing sessions each route keeps populated', () => {
    expect(standingTargets(config()).map(target => target.sessionId))
      .toEqual([GROUPS_SESSION_ID, CONTACTS_SESSION_ID])
    expect(standingTargets(config({ route: 'single' })).map(target => target.sessionId))
      .toEqual([CONVERSATIONS_SESSION_ID])
    expect(standingTargets(config({ route: 'per-chat' }))).toEqual([])
  })
})

describe('inbound framing', () => {
  it('identifies the chat, the sender, and the send time', () => {
    expect(renderInbound(message())).toBe([
      `WhatsApp message in direct chat "Ana" [chat_id: ${anaId}]`,
      `From: Ana (${anaId})`,
      'Sent: 2026-08-21T10:00:00.000Z',
      '',
      'oi',
    ].join('\n'))
  })

  it('falls back to addresses when neither display name is known', () => {
    const text = renderInbound(message({}, ['chatName', 'senderName']))
    expect(text).toContain(`WhatsApp message in direct chat [chat_id: ${anaId}]`)
    expect(text).toContain(`From: ${anaId}`)
  })

  it('names the media type of a body the seam cannot represent', () => {
    expect(renderInbound(message({ content: { kind: 'unsupported', mediaType: 'image/jpeg' } })))
      .toContain('[unsupported media: image/jpeg]')
  })
})

describe('seen message recall', () => {
  it('admits an id once', () => {
    const seen = new SeenMessages(4)
    expect(seen.admit('a')).toBe(true)
    expect(seen.admit('a')).toBe(false)
  })

  it('forgets the oldest id past the limit', () => {
    const seen = new SeenMessages(2)
    expect(seen.admit('a')).toBe(true)
    expect(seen.admit('b')).toBe(true)
    expect(seen.admit('c')).toBe(true)
    expect(seen.admit('a')).toBe(true)
    expect(seen.admit('c')).toBe(false)
  })
})

describe('resolveDirectory', () => {
  it('expands a leading home marker', () => {
    expect(resolveDirectory('~/.dsh/whatsapp')).toBe(join(homedir(), '.dsh', 'whatsapp'))
    expect(resolveDirectory('~')).toBe(homedir())
    expect(resolveDirectory(`~${sep}.dsh`)).toBe(join(homedir(), '.dsh'))
  })

  it('keeps an absolute path, trimming surrounding whitespace', () => {
    const absolute = join(tmpdir(), 'whatsapp-workspace-resolve')
    expect(resolveDirectory(`  ${absolute}  `)).toBe(absolute)
  })

  it('rejects an empty or relative directory', () => {
    expect(() => resolveDirectory('   ')).toThrow(/must not be empty/)
    expect(() => resolveDirectory('relative/whatsapp')).toThrow(/must be absolute/)
    expect(() => resolveDirectory('~notme/whatsapp')).toThrow(/must be absolute/)
  })
})
