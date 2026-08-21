# @deepseek-ai/dsh-tool-whatsapp

English | [中文](README.zh.md)

The model-facing WhatsApp tool suite — `whatsapp_list_chats`, `whatsapp_read_chat`, `whatsapp_mark_read`, and the approval-gated `whatsapp_send_message` — over the [WhatsApp capability seam](../whatsapp/README.md) (`ctx.whatsapp`). It owns model-facing concerns only: tool names, JSON schemas, snake_case argument names, per-call bounds, result formatting, the approval prompt text, and the UI presentation projection. All account access goes through `ctx.whatsapp`; this package never imports a concrete provider.

Each tool is registered independently, so a read-only deployment disables `send` and keeps the other three.

## Tools

| Tool | Args | Behavior |
|---|---|---|
| `whatsapp_list_chats` | `unread_only`, `limit` | The conversations the account has observed since it connected, each with its `chat_id`, display name, kind, and unread count. |
| `whatsapp_read_chat` | `chat_id` (required), `limit`, `before` | One page of a conversation's history, newest first. `before` pages further back by message id. |
| `whatsapp_mark_read` | `chat_id` (required) | Marks one conversation read up to its newest message. The other participant sees the receipt, so this is a real side effect, not a local flag. |
| `whatsapp_send_message` | `chat_id` (required), `text` (required), `quoted_message_id` | Sends one text message after the operator approves it. |

### The chat index is connection-scoped

A provider builds its chat index from the activity it observes, so it holds whatever this connection happened to see — sometimes nothing at all right after connecting, sometimes conversations restored from app-state sync. Membership therefore cannot gate addressing: every tool that names a conversation takes the `chat_id` it was handed, uses the account's display name when it has observed that conversation, and leaves deliverability to the provider.

`whatsapp_list_chats` says the same thing to the model in its description, because an empty list otherwise reads as "this account has no conversations". `whatsapp_read_chat` says it too, for the same reason: history is scoped to the connection, so an empty page reports what was retained rather than what was said, and a chat that reads empty can still be sent to.

### A chat id is opaque

This package never parses a `chat_id`. [`WhatsAppChatId`](../whatsapp/README.md) is opaque by contract, because WhatsApp owns its address spaces and adds to them, and the provider that tracks WhatsApp already reports `kind` on every chat and message. An earlier revision here classified an id by its suffix and rejected `…@lid`, WhatsApp's linked-identity space for direct conversations — an id a live account had just handed the model from `whatsapp_list_chats`, so the documented `list_chats` → `read_chat` path failed on its own output while asserting the id was not a WhatsApp address.

Every tool therefore resolves through `ctx.whatsapp.resolveChat()`, which decides the conversation's kind, names it when this connection observed it, and rejects with `WHATSAPP_UNKNOWN_CHAT` only a value that names no conversation at all. Resolving first is also what makes a logged-out account fail before the operator is asked to approve a send.

### `chat_id` is always required

`whatsapp_send_message` takes no implicit recipient. There is no "reply to the last chat", no session-scoped default, and no inference from conversation history — one session serves many conversations, so a default destination would eventually be the wrong person. The tool description says so in the model's own words, and the schema marks `chat_id` required.

### Approval

Sending is the only path in this package that acts on the network under the operator's identity, so `whatsapp_send_message` asks `ctx.approval` before dispatch. The prompt names the destination first and in full, then quotes the body (elided after 200 characters):

```text
send a WhatsApp message to Ana (5511999990000@s.whatsapp.net): "boa tarde, chego às 18h"
```

An account that resolved no display name leaves the operator judging a bare address, which reads as a decision they cannot make. That case states the absence instead of presenting digits as if they identified someone:

```text
send a WhatsApp message to an unnamed conversation at 5511999990000@s.whatsapp.net: "boa tarde"
```

Approval fails closed on every path that is not an explicit grant: a rejection, a cancellation, an unavailable channel, a composition without an approval service, and an agent-less execution each fail the call. `ctx.approval` is deliberately absent from `inject` so a composition without an approval channel still registers the read tools and refuses only the send.

## Config

| Key | Default | Meaning |
|---|---|---|
| `listChats` | `true` | Register `whatsapp_list_chats`. |
| `readChat` | `true` | Register `whatsapp_read_chat`. |
| `markRead` | `true` | Register `whatsapp_mark_read`. |
| `send` | `true` | Register `whatsapp_send_message`. |
| `listChatsMaxResults` | `100` | Upper bound on conversations one `whatsapp_list_chats` call returns. |
| `readChatDefaultLimit` | `20` | History page size when `whatsapp_read_chat` names no limit. |
| `readChatMaxLimit` | `100` | Upper bound on messages one `whatsapp_read_chat` call returns. |
| `sendMaxTextChars` | `4096` | Upper bound on one message body, in characters. |
| `timeoutMs` | `30000` | Cooperative tool-call timeout budget for every WhatsApp tool. |

Every count and character bound must be a positive integer, and `readChatDefaultLimit` may not exceed `readChatMaxLimit`; a violation fails plugin load rather than being clamped at call time. The resolved caps appear in the schema descriptions the model reads, so changing one changes the request prefix.

```yaml
- id: tool-whatsapp
  name: '@deepseek-ai/dsh-tool-whatsapp'
  config:
    send: true
```

## Events

A confirmed send appends `whatsapp/outbound` to the calling agent's session, after the provider acknowledged it, so the log never claims a send WhatsApp refused. The inbound half is written by [`dsh-whatsapp-workspace`](../whatsapp-workspace/README.md).

## Model Experience

### Tool schemas

#### What the model sees

The four generated [WhatsApp tool schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-whatsapp). Page-size caps and the timeout budget are deployment settings that appear only as text inside argument descriptions, never as model arguments.

#### Token effect

Fixed schema cost per request for the enabled tools; config disablement removes a schema entirely, while a scoped restriction removes only its visibility.

#### KV Cache effect

Prefix-stable while the enabled set and the resolved caps are unchanged. Changing `listChatsMaxResults`, `readChatDefaultLimit`, `readChatMaxLimit`, or `sendMaxTextChars` rewrites an argument description and may invalidate reuse from the first changed schema token.

### Conversation list

#### What the model sees

A header line `<shown> of <total> WhatsApp conversations:` followed by one line per conversation, shaped exactly `- <name> [chat_id: <id>] <kind>, <count> unread`. A conversation the account resolved no name for renders `(unnamed)` and omits `name` from the returned object, so the model can tell an unnamed conversation from one actually called by its number. An empty index is exactly `No WhatsApp conversations observed on this connection yet.`, which says why it is empty rather than implying the account has no conversations.

#### Token effect

Data-dependent and bounded by `listChatsMaxResults`; the result is resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Conversation history

#### What the model sees

A header line `<count> message(s) in <name> [chat_id: <id>], newest first:` followed by one line per message, shaped exactly `- <timestamp> <sender>: <body>`, where the account's own messages render their sender as `(you)` and media the seam cannot represent renders as `[unsupported media: <type>]`. An empty page is exactly `No messages retained on this connection for <name> [chat_id: <id>]. The conversation is still writable.` An unresolved name renders `(unnamed)` here too, and `chat_name` is absent from the returned object.

#### Token effect

Data-dependent and bounded by the resolved page size; the result is resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Send outcome

#### What the model sees

A confirmed send is exactly `Sent to <name> [chat_id: <id>] at <timestamp> (message_id: <id>).` A refused one is an error result naming the same destination, so the model can tell "the user said no" apart from "WhatsApp rejected it" and does not retry blindly.

##### Approval refusals

```markdown
Error: the user rejected sending this message to Ana (5511999990000@s.whatsapp.net)
Error: approval for sending to Ana (5511999990000@s.whatsapp.net) was cancelled
Error: whatsapp_send_message requires approval, but no approval channel is available
```

#### Token effect

One short line per send attempt, retained until compaction. The operator's wait for approval consumes no tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Argument and account errors

#### What the model sees

Value errors become exactly `Error: invalid limit: expected an integer between 1 and <max>, got <value>`, `Error: invalid text: a WhatsApp message must carry a non-empty body`, or `Error: invalid text: at most <max> characters (got <length>)`. A `chat_id` that names no conversation surfaces the account's own `WHATSAPP_UNKNOWN_CHAT` message, and a logged-out or unregistered account its `WHATSAPP_NOT_ONLINE` / `WHATSAPP_PROVIDER_UNAVAILABLE` message.

#### Token effect

Only the failing call adds these retained tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Text only** — the seam carries text, so `whatsapp_send_message` takes a body and nothing else. Sending an image, a document, or an audio note, and reading media beyond the `[unsupported media: …]` placeholder, are deferred with the seam's own media support.
- **An out-of-bounds limit is rejected, not clamped** — returning fewer messages than asked would read to the model as the conversation being that short, so the call fails and names the bound instead.
- **Approval is per call, with no standing grants** — every send asks again, because the decision being approved is "this text to this person", not "WhatsApp in general". A per-chat or per-session grant would need its own persisted policy and is deferred.
- **`whatsapp_list_chats` is unpaginated** — it returns the first `listChatsMaxResults` conversations the provider reports, with no cursor. An account with more conversations than the cap cannot reach the tail from the model side; `total` at least tells it the list was cut.
- **There is no durable roster** — because the provider's index is connection-scoped, how much a freshly connected process can list is not something the model can count on, and it can only address conversations whose ids it already holds. A roster persisted across connections would fix this and is deferred to the package that owns durable WhatsApp state.
- **A resolvable address is not a reachable one** — `resolveChat` answers for an address the connection never observed, so a plausible but wrong id reaches approval and is refused by the account only when the send is attempted. The operator's approval prompt naming the destination is what stands between a mistyped id and a stranger; the prompt says `an unnamed conversation at <id>` when the account resolved no name, so "I do not know who this is" is stated rather than disguised as one.
- **Per-chat `unread_count` is a lower bound** — the provider derives it from what this connection observed, not from WhatsApp's own unread state, so it can under-report what the operator's phone shows. `total` counts what the tool returned and is exact; `unread_only` filters on the same approximate counter.
- **The media placeholder is unverified against real media** — `[unsupported media: <type>]` is exercised by unit tests and by the keyless snapshot, but no image, document, or audio note has reached it from a real account.
- **The tool package is live-verified; the assembled workspace is not** — the maintainer of the seam package ran all four tools against a real paired account through this package's own composition (real `ToolRuntime`, real `ApprovalService`, real `Session` inside an open turn) and confirmed `whatsapp_list_chats`, a plain send, a send with `quoted_message_id`, `whatsapp_read_chat`, `whatsapp_mark_read`, and exactly one `whatsapp/outbound` event per tool send. Routing an inbound message through [`dsh-whatsapp-workspace`](../whatsapp-workspace/README.md) into a session turn is not live-verified, because it needs a message from a third party rather than the account itself.
