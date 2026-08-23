import { describe, expect, it } from 'vitest'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { WhatsAppChatId, WhatsAppMessageId, type WhatsAppMessage } from '@deepseek-ai/dsh-whatsapp'
import {
  SeenMessages,
  applySettings,
  chatSessionId,
  chatTitle,
  isRoutedChat,
  isRoutedKind,
  renderInbound,
  resolveDirectory,
  routeMessage,
  settingsBase,
} from '../src/index.ts'
import type { ResolvedConfig } from '../src/index.ts'

const anaId = WhatsAppChatId('5511999990000@s.whatsapp.net')
const groupId = WhatsAppChatId('12036300000@g.us')

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    directory: '~/.dsh/whatsapp',
    workspaceTitle: 'WhatsApp',
    chats: 'all',
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
  it('gives every conversation its own session, keyed by a stable digest of the chat id', () => {
    expect(routeMessage(config(), message())).toBe(chatSessionId(anaId))
    expect(routeMessage(config(), message({ chatId: groupId, chatKind: 'group' }))).toBe(chatSessionId(groupId))
    expect(chatSessionId(anaId)).toBe(chatSessionId(anaId))
    expect(chatSessionId(anaId)).not.toBe(chatSessionId(groupId))
    expect(chatSessionId(anaId)).toMatch(/^whatsapp-chat-[0-9a-f]{16}$/)
  })

  it('answers only the conversation kinds the scope names', () => {
    expect(isRoutedKind(config(), 'group')).toBe(true)
    expect(isRoutedKind(config(), 'direct')).toBe(true)
    expect(isRoutedKind(config({ chats: 'groups' }), 'direct')).toBe(false)
    expect(isRoutedKind(config({ chats: 'contacts' }), 'group')).toBe(false)
    expect(routeMessage(config({ chats: 'groups' }), message())).toBeUndefined()
    expect(routeMessage(config({ chats: 'contacts' }), message({ chatId: groupId, chatKind: 'group' })))
      .toBeUndefined()
  })

  it('keeps an allowlisted conversation outside the scope unrouted', () => {
    expect(isRoutedChat(config({ chats: 'groups', allowChatIds: [anaId] }), anaId, 'direct')).toBe(false)
  })

  it('titles a conversation by the name the account resolved, then the message, then the address', () => {
    expect(chatTitle(message(), 'Ana Silva')).toBe('Ana Silva')
    expect(chatTitle(message())).toBe('Ana')
    expect(chatTitle(message({}, ['chatName']))).toBe(anaId)
  })

  it('never routes a message the account itself wrote', () => {
    expect(routeMessage(config(), message({ fromMe: true }))).toBeUndefined()
  })

  it.each(['imageMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'protocolMessage'])(
    'routes %s, because the seam publishes only what a person sent',
    (mediaType) => {
      expect(routeMessage(config(), message({ content: { kind: 'unsupported', mediaType } })))
        .toBe(chatSessionId(anaId))
    },
  )

  it('applies the denylist after the allowlist', () => {
    expect(isRoutedChat(config(), anaId, 'direct')).toBe(true)
    expect(isRoutedChat(config({ allowChatIds: [groupId] }), anaId, 'direct')).toBe(false)
    expect(isRoutedChat(config({ allowChatIds: [anaId] }), anaId, 'direct')).toBe(true)
    expect(isRoutedChat(config({ allowChatIds: [anaId], denyChatIds: [anaId] }), anaId, 'direct')).toBe(false)
    expect(routeMessage(config({ denyChatIds: [anaId] }), message())).toBeUndefined()
  })
})

describe('live settings', () => {
  it('offers the composition entry as the base layer of the user-writable slice', () => {
    expect(settingsBase(config({ chats: 'groups', denyChatIds: [anaId] })))
      .toEqual({ chats: 'groups', allowChatIds: [], denyChatIds: [anaId] })
    expect(settingsBase(config({ agentPreset: 'interpreter' })).agentPreset).toBe('interpreter')
  })

  it('folds a resolved section over the entry, keeping the composed value for what it leaves unset', () => {
    const entry = config({ chats: 'all', agentPreset: 'interpreter' })
    expect(applySettings(entry, { chats: 'contacts' }))
      .toEqual({ ...entry, chats: 'contacts' })
    expect(applySettings(entry, {})).toEqual(entry)
    expect(applySettings(entry, { allowChatIds: [anaId], denyChatIds: [groupId], agentPreset: 'other' }))
      .toEqual({ ...entry, allowChatIds: [anaId], denyChatIds: [groupId], agentPreset: 'other' })
  })

  it('judges the next message against the folded policy', () => {
    const entry = config()
    expect(routeMessage(applySettings(entry, { chats: 'groups' }), message())).toBeUndefined()
    expect(routeMessage(applySettings(entry, { chats: 'groups' }), message({ chatId: groupId, chatKind: 'group' })))
      .toBe(chatSessionId(groupId))
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
