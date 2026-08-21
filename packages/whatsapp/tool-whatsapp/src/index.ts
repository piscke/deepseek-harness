/**
 * Model-facing WhatsApp tools over `ctx.whatsapp`: `whatsapp_list_chats`,
 * `whatsapp_read_chat`, `whatsapp_mark_read`, and the approval-gated
 * `whatsapp_send_message`. This package owns schemas, bounds, prompt guidance,
 * approval choreography, and presentation, never a concrete provider.
 * @module @deepseek-ai/dsh-tool-whatsapp
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-whatsapp'
import { applyListChatsTool, applyMarkReadTool, applyReadChatTool } from './read-tools.ts'
import { applySendMessageTool } from './send-tool.ts'

// The `whatsapp/outbound` declaration lives in src/types.ts (its one home);
// this re-export projects the type face onto the package root AND keeps the
// module edge in the emitted index.d.ts, so aggregate programs consuming the
// declarations still receive the SessionEventMap merge.
export type * from './types.ts'
export { chatOutput, describeChat, messageOutput, renderBody, resolveChat } from './chats.ts'
export type { ChatOutput, MessageOutput } from './chats.ts'
export { applyListChatsTool, applyMarkReadTool, applyReadChatTool, resolveLimit } from './read-tools.ts'
export { APPROVAL_PREVIEW_CHARS, applySendMessageTool, approvalReason, approveSend } from './send-tool.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-whatsapp'

/**
 * Services required by the WhatsApp tool suite. `approval` is deliberately
 * absent: it is resolved per call so a composition that drops the approval
 * channel still registers the read tools and refuses only the send.
 */
export const inject = ['tools', 'whatsapp']

/** Default cooperative tool-call timeout budget (ms) for the WhatsApp tools. */
export const DEFAULT_WHATSAPP_TOOL_TIMEOUT_MS = 30_000

/** Plugin config: which WhatsApp tools to register and their per-call bounds. */
export interface Config {
  /** Register `whatsapp_send_message`. Defaults to true. */
  send?: boolean
  /** Register `whatsapp_list_chats`. Defaults to true. */
  listChats?: boolean
  /** Register `whatsapp_read_chat`. Defaults to true. */
  readChat?: boolean
  /** Register `whatsapp_mark_read`. Defaults to true. */
  markRead?: boolean
  /** Upper bound on conversations returned by one `whatsapp_list_chats` call. Defaults to 100. */
  listChatsMaxResults?: number
  /** History page size when `whatsapp_read_chat` is called without a limit. Defaults to 20. */
  readChatDefaultLimit?: number
  /** Upper bound on messages returned by one `whatsapp_read_chat` call. Defaults to 100. */
  readChatMaxLimit?: number
  /** Upper bound on one `whatsapp_send_message` body, in characters. Defaults to 4096. */
  sendMaxTextChars?: number
  /** Cooperative timeout budget (ms) for every WhatsApp tool. Defaults to 30000. */
  timeoutMs?: number
}

/** Schemastery configuration for the WhatsApp tool consumer. */
export const Config: z<Config> = z.object({
  send: z.boolean().default(true),
  listChats: z.boolean().default(true),
  readChat: z.boolean().default(true),
  markRead: z.boolean().default(true),
  listChatsMaxResults: z.number().default(100),
  readChatDefaultLimit: z.number().default(20),
  readChatMaxLimit: z.number().default(100),
  sendMaxTextChars: z.number().default(4096),
  timeoutMs: z.number().default(DEFAULT_WHATSAPP_TOOL_TIMEOUT_MS),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Configured count, character, and timeout caps must be positive integers. */
function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-whatsapp: ${field} must be a positive integer, got ${value}`)
  }
}

/**
 * Register the enabled WhatsApp tools. Every tool defaults to registered; a
 * deployment that wants read-only WhatsApp access disables `send`. The tools'
 * disposers are fiber-scoped, so no manual teardown is needed.
 * @param ctx - registrant context carrying the tool registry and `ctx.whatsapp`.
 * @param config - the deployment's tool selection and bounds, after schemastery defaults.
 */
export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveInteger('listChatsMaxResults', resolved.listChatsMaxResults)
  assertPositiveInteger('readChatDefaultLimit', resolved.readChatDefaultLimit)
  assertPositiveInteger('readChatMaxLimit', resolved.readChatMaxLimit)
  assertPositiveInteger('sendMaxTextChars', resolved.sendMaxTextChars)
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)
  if (resolved.readChatDefaultLimit > resolved.readChatMaxLimit) {
    throw new Error(
      `tool-whatsapp: readChatDefaultLimit (${resolved.readChatDefaultLimit}) exceeds `
      + `readChatMaxLimit (${resolved.readChatMaxLimit})`,
    )
  }
  if (resolved.listChats) applyListChatsTool(ctx, resolved.listChatsMaxResults, resolved.timeoutMs)
  if (resolved.readChat) {
    applyReadChatTool(ctx, resolved.readChatDefaultLimit, resolved.readChatMaxLimit, resolved.timeoutMs)
  }
  if (resolved.markRead) applyMarkReadTool(ctx, resolved.timeoutMs)
  if (resolved.send) applySendMessageTool(ctx, resolved.sendMaxTextChars, resolved.timeoutMs)
}
