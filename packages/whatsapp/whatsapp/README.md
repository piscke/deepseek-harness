# @deepseek-ai/dsh-whatsapp

English | [中文](README.zh.md)

The WhatsApp capability seam (`ctx.whatsapp`): connection status, conversations, message history, and sending, over exactly one authenticated account.

This is the **definition** package. It owns the vocabulary, the events, and the single provider slot; it opens no connection. [`dsh-whatsapp-baileys`](../whatsapp-baileys/README.md) provides one.

## Service

| Member | Meaning |
|---|---|
| `register(provider)` | Registers the sole provider; a second registration throws `WHATSAPP_PROVIDER_ALREADY_REGISTERED`. Returns the disposer, disposed with the calling fiber. |
| `status()` | The account's connection state; `offline` while no provider is registered. Never throws. |
| `listChats(signal?)` | Conversations the connected account knows about. |
| `resolveChat(chatId, signal?)` | The conversation one address names, kind decided by the provider and named when the connection observed it. Rejects a value that names no conversation with `WHATSAPP_UNKNOWN_CHAT`. |
| `fetchMessages(request, signal?)` | One page of a chat's history, newest first. |
| `send(request, signal?)` | Sends one text message and emits `whatsapp/message-sent` once acknowledged. |
| `markRead(chatId, signal?)` | Marks a chat read up to its newest message. |

An account is one long-lived connection, so status belongs to the capability rather than to a call result. Every operation except `status()` and `register()` requires the account to be `online`: no registered provider fails with `WHATSAPP_PROVIDER_UNAVAILABLE`, and a provider whose account is connecting, pairing, or logged out fails with `WHATSAPP_NOT_ONLINE`.

`send` rejects an empty or whitespace-only body (`WHATSAPP_EMPTY_MESSAGE`) and `fetchMessages` rejects a non-positive or fractional `limit` (`WHATSAPP_INVALID_LIMIT`) before reaching the provider, so a provider never has to define what those mean.

## Events

| Event | Emitted when |
|---|---|
| `whatsapp/status` | The connection state changed; a `pairing` payload is re-emitted whenever the provider rotates it. |
| `whatsapp/message-received` | The provider observed a message, including one the account sent from another device (`fromMe`). |
| `whatsapp/message-sent` | A send dispatched through this service was acknowledged. |

Acknowledgement means WhatsApp accepted the message, not that it was delivered or read. A provider may repeat a `whatsapp/message-received` id after a reconnection replays history, so a consumer that must act once keeps its own processed-id set.

## Identity

`WhatsAppChatId` and `WhatsAppMessageId` are branded strings: a chat id is the account-visible conversation address, a message id is opaque and only meaningful to the connection that observed it.

A chat id is opaque too. WhatsApp addresses conversations through several domains and adds more over time — a live account reports direct conversations as both `@s.whatsapp.net` and `@lid`, and `@newsletter` and `@broadcast` exist beside them — so a consumer must not parse a chat id, and must not classify one against a closed set of suffixes. `WhatsAppChat.kind` and `WhatsAppMessage.chatKind` already carry the classification, decided by the provider that tracks WhatsApp's address spaces; a consumer holding only an address calls `resolveChat` rather than re-deriving one, which rejects addresses the provider legitimately reports.

## Model Experience

Indirectly, through whichever consumer puts these conversations in front of a model; this package registers no tool, prompt, or schema, and everything such a consumer includes reaches the LLM provider and the session log.

#### KV Cache effect

No direct invalidation; the consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Text only** — `send` carries text, and a provider reports media it cannot represent as `unsupported` with its media type rather than dropping the message. Sending or reading media is deferred work.
- **One account per seam** — the provider slot holds exactly one registration, because a registration owns a specific authenticated account. Running two accounts means two isolated fibers.
- **No delivery or read state** — the seam reports what was sent and observed, not per-recipient delivery, read receipts, or typing presence.
