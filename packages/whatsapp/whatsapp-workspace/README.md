# @deepseek-ai/dsh-whatsapp-workspace

English | [中文](README.zh.md)

The WhatsApp Workspace: a dedicated directory registered as a [Workspace](../../workspace/workspace/README.md), the conversation sessions that live inside it, and the delivery of the account's inbound stream into those sessions as queued follow-up turns.

This is a Consumer of the [WhatsApp capability seam](../whatsapp/README.md) (`ctx.whatsapp`). It registers no provider and no tool — answering a conversation is [`dsh-tool-whatsapp`](../tool-whatsapp/README.md).

## What it does at load

1. Resolves `directory` (a leading `~` expands to the user's home) and creates it.
2. Registers it with `ctx.workspaceRegistry.create(path, workspaceTitle)`, so a WhatsApp Workspace appears in the Web UI sidebar beside repository workspaces.
3. Subscribes to `whatsapp/message-received`.
4. Opens the route's standing sessions, each with `cwd` equal to that directory, attaches them with `attachSession`, and pins their titles.

The subscription is installed before the standing sessions open, so a message observed during startup is queued rather than missed.

Every step fails plugin load when it cannot be completed: an unusable directory, a registry that refuses the path, a standing session that will not open. A Workspace that silently never appears is indistinguishable from a disconnected account.

## Routing

`route` decides how conversations map onto sessions, and it is required — no shape is right for every deployment.

| Mode | Sessions | Suits |
|---|---|---|
| `category` | Two standing sessions, `groupsTitle` and `contactsTitle` | One agent per kind of conversation. The default shape for an assistant that triages groups differently from people. |
| `per-chat` | One session per conversation, opened the first time that conversation is routed | Long-running, independent threads. Opens no standing session, so the Workspace starts empty. |
| `single` | One standing session, `conversationsTitle` | The smallest composition: everything in one place. |

`allowChatIds`, when non-empty, is exhaustive; `denyChatIds` is applied afterwards, so a chat named by both stays denied.

Two filters are policy the deployment cannot turn off. A message the account itself wrote (`fromMe`, including from another device) is never routed, because delivering the deployment's own answer back would wake the agent with its own words. A message id already delivered is dropped, because a provider replays history after a reconnection.

Nothing is filtered by content. `whatsapp/message-received` means a person sent something — a provider drops delivery metadata and protocol housekeeping instead of publishing it — so this package never inspects WhatsApp field names, and a media type it cannot render still becomes a turn.

### Every message identifies its chat

Under `category` and `single`, one session serves many conversations, so the conversation is part of each message rather than context the model is expected to remember:

```text
WhatsApp message in direct chat "Ana" [chat_id: 5511999990000@s.whatsapp.net]
From: Ana (5511999990000@s.whatsapp.net)
Sent: 2026-08-21T10:00:00.000Z

boa tarde, você pode confirmar o horário?
```

That `[chat_id: …]` header is exactly the value `whatsapp_send_message` requires, so answering the right person is a copy, not an inference.

## Queued delivery, never an interruption

A message that arrives while the agent is mid-turn waits for the turn to end. Delivery claims the agent's idle phase through `runMaintenance`, so the framing enters the log and the agent's inbox between turns; a claim refused because a turn owns the agent parks on `whenIdle()` and retries at the next boundary, with the batch put back at the head so arrival order survives.

Delivery is serial per session and coalesced: everything queued at the moment a claim succeeds is delivered inside it, so a burst of messages becomes one wake-up rather than one per message. Each message is still its own follow-up turn.

One message's failure is contained. A message the log refuses is warned about and dropped, and the queue behind it keeps moving — one unloggable message cannot silence a conversation.

## Sessions

Session identities are deterministic (`whatsapp-groups`, `whatsapp-contacts`, `whatsapp-conversations`, and `whatsapp-chat-<digest>` for `per-chat`), so a restart resumes the same conversation instead of starting an empty one. A stored session recorded under a different project directory fails loud with both paths: that means the deployment moved `directory` while logs exist under the old one.

Titles are pinned with `ctx.sessionTitle.rename()`, whose `user` source stops automatic title generation for good. Re-pinning an unchanged title is skipped, so a restart does not append a redundant event.

## Config

| Key | Default | Meaning |
|---|---|---|
| `directory` | `~/.dsh/whatsapp` | The directory the Workspace owns and every conversation session runs in. Must resolve to an absolute path. |
| `workspaceTitle` | `WhatsApp` | The Workspace's title in the sidebar. |
| `route` | *(required)* | `category`, `per-chat`, or `single`. |
| `groupsTitle` | `Groups` | Title of the `category` route's group session. |
| `contactsTitle` | `Contacts` | Title of the `category` route's direct-chat session. |
| `conversationsTitle` | `Conversations` | Title of the `single` route's one session. |
| `allowChatIds` | `[]` | When non-empty, the only conversations routed. |
| `denyChatIds` | `[]` | Conversations never routed. |
| `seenMessageLimit` | `1000` | How many delivered message ids are remembered to suppress a provider's history replay. |

The titles are config rather than constants because they are read by a human in their own language:

```yaml
- id: whatsapp-workspace
  name: '@deepseek-ai/dsh-whatsapp-workspace'
  config:
    route: category
    groupsTitle: Grupos
    contactsTitle: Contatos
```

`create` reuses the record already owning the canonical path and leaves its title alone, so a title the operator changed in the UI survives a restart.

## Events

| Event | Appended when |
|---|---|
| `whatsapp/inbound` | One inbound message is about to enter the session, before the follow-up turn is queued. |

Appending first keeps model-visible ⟺ logged true in the failing direction: a message the log could not record never reaches the model. The outbound half (`whatsapp/outbound`) belongs to [`dsh-tool-whatsapp`](../tool-whatsapp/README.md). `./invariant` validates every stored `whatsapp/inbound` record.

## Model Experience

### Inbound message framing

#### What the model sees

Each routed message arrives as its own follow-up turn carrying a plugin-sourced user message: a header line naming the chat kind, the conversation's display name when the account resolved one, and `[chat_id: <id>]`; a `From:` line; a `Sent:` line; a blank line; and the body. Media the seam cannot represent renders as `[unsupported media: <type>]` rather than vanishing.

##### One delivered message

```markdown
WhatsApp message in group chat "Família" [chat_id: 12036300000@g.us]
From: Ana (5511999990000@s.whatsapp.net)
Sent: 2026-08-21T10:00:00.000Z

alguém pode buscar o bolo?
```

#### Token effect

One framing per delivered message, roughly four short lines plus the body, retained in the session until compaction. A burst delivers as several messages inside one turn boundary, not one turn each.

#### KV Cache effect

Append-only; each framing follows the reusable request prefix and does not invalidate existing KV-cache entries. This package contributes no system prompt and no tool schema, so the prefix itself never changes.

## Known Limitations and Deferred Work

- **Nothing here is verified against a real WhatsApp account** — routing, queueing, and session lifecycle are covered by unit and composition tests against a scripted seam. Behavior under a live provider is unverified.
- **Routing trusts the seam's rule that an inbound event is a human message** — this package makes no content judgment of its own, so a provider that published delivery metadata or protocol housekeeping would spend a turn on it. That is the provider's bug to fix, and duplicating the judgment here would silently drop real media the moment the two lists drifted.
- **Deduplication is in-memory** — `seenMessageLimit` ids live with the plugin, so a restart can redeliver a message the provider replays. The durable `whatsapp/inbound` log knows better; consulting it at load is deferred.
- **The agent's reply is not sent anywhere** — this package delivers messages into a session. Whether the agent answers, and to whom, is the model's decision through `whatsapp_send_message`, which asks the operator every time. There is no auto-reply path, by design.
- **`per-chat` opens sessions without bound** — one session per conversation, created on first contact, with no eviction and no cap. An account with many conversations should use `allowChatIds` or a category route.
- **One account per Workspace, and one process per account** — the seam holds one authenticated account, so a second account means a second fiber with its own directory. The stricter rule is the provider's: two connections sharing one auth directory replace each other's linked device, and the older one dies with a connection conflict. A restart that overlaps the previous process, or a second harness pointed at the same directory, takes the account offline rather than sharing it.
