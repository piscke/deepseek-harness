import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WhatsAppRuntime, { WhatsAppChatId, WhatsAppMessageId } from '@deepseek-ai/dsh-whatsapp'
import type { WhatsAppMessage, WhatsAppStatus } from '@deepseek-ai/dsh-whatsapp'
import { providerDeps } from '@deepseek-ai/dsh-whatsapp-baileys'
import type { BaileysProviderDeps, WhatsAppSocket } from '@deepseek-ai/dsh-whatsapp-baileys'

const chatId = WhatsAppChatId('5511999990000@s.whatsapp.net')

const port: WhatsAppSocket = {
  sendText: () => Promise.reject(new Error('unused')),
  markRead: () => Promise.resolve(),
  close: () => Promise.resolve(),
}

/** Compose the collaborators over a mounted seam. */
async function deps(): Promise<{ ctx: Context; composed: BaileysProviderDeps }> {
  const ctx = new Context()
  await ctx.plugin(WhatsAppRuntime)
  return {
    ctx,
    composed: providerDeps(ctx, () => Promise.resolve(port), {
      reconnectDelay: 1,
      maxReconnectAttempts: 1,
      historyPerChat: 10,
    }),
  }
}

describe('provider collaborators', () => {
  it('publishes a status transition on the fiber', async () => {
    const { ctx, composed } = await deps()
    const seen: WhatsAppStatus[] = []
    ctx.on('whatsapp/status', status => seen.push(status))
    composed.onStatus({ state: 'connecting' })
    expect(seen).toEqual([{ state: 'connecting' }])
  })

  it('publishes an observed message on the fiber', async () => {
    const { ctx, composed } = await deps()
    const seen: WhatsAppMessage[] = []
    ctx.on('whatsapp/message-received', message => seen.push(message))
    const message: WhatsAppMessage = {
      id: WhatsAppMessageId('M1'),
      chatId,
      chatKind: 'direct',
      senderId: chatId,
      fromMe: false,
      timestamp: '2026-01-01T10:00:00.000Z',
      content: { kind: 'text', text: 'oi' },
    }
    composed.onMessage(message)
    expect(seen).toEqual([message])
  })

  it('routes a fatal failure to the fiber log', async () => {
    const { ctx, composed } = await deps()
    const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    const failure = new Error('unusable')
    composed.onFatal(failure)
    expect(error).toHaveBeenCalledWith(failure)
  })

  it('runs a scheduled reconnection', async () => {
    const { composed } = await deps()
    const callback = vi.fn()
    composed.setTimer(callback, 1)
    await vi.waitFor(() => { expect(callback).toHaveBeenCalledOnce() })
  })

  it('cancels a reconnection that is no longer wanted', async () => {
    const { composed } = await deps()
    const callback = vi.fn()
    composed.setTimer(callback, 1)()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(callback).not.toHaveBeenCalled()
  })

  it('carries the configured behavior through unchanged', async () => {
    const { composed } = await deps()
    expect(composed.config).toEqual({ reconnectDelay: 1, maxReconnectAttempts: 1, historyPerChat: 10 })
    await expect(composed.open(() => {})).resolves.toBe(port)
  })
})
