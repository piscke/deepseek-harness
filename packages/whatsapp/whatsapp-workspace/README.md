# @deepseek-ai/dsh-whatsapp-workspace

English | [中文](README.zh.md)

The WhatsApp Workspace: a dedicated directory registered as a [Workspace](../../workspace/workspace/README.md), one session per conversation inside it, and the delivery of the account's inbound stream into those sessions as queued follow-up turns.

This is a Consumer of the [WhatsApp capability seam](../whatsapp/README.md) (`ctx.whatsapp`). It registers no provider and no tool — answering a conversation is [`dsh-tool-whatsapp`](../tool-whatsapp/README.md).

## What it does at load

1. Resolves `directory` (a leading `~` expands to the user's home) and creates it.
2. Registers the live slice of its policy as a settings section, so a running deployment can change what is routed without a reload.
3. Registers the directory with `ctx.workspaceRegistry.create(path, workspaceTitle)`, so a WhatsApp Workspace appears in the Web UI sidebar beside repository workspaces.
4. Subscribes to `whatsapp/message-received` and `whatsapp/chat-named`.

No session is opened at load. A conversation's session is created the first time that conversation is routed, so a fresh deployment starts with an empty Workspace and lists every conversation it has answered from then on, because the session-to-Workspace attachment is durable.

Every step fails plugin load when it cannot be completed: an unusable directory, a registry that refuses the path. A Workspace that silently never appears is indistinguishable from a disconnected account.

## Routing

One conversation is one session, always. A contact and a group each get their own log, their own title, and their own agent, which is what makes a per-contact interpreter possible: the history the model reads is that contact's history and nobody else's.

`chats` decides which conversations open a session at all:

| Scope | Routes |
|---|---|
| `all` | Every conversation, group and direct. |
| `groups` | Group conversations only. |
| `contacts` | Direct conversations only. |

`allowChatIds`, when non-empty, is exhaustive; `denyChatIds` is applied afterwards, so a chat named by both stays denied. Both are judged after `chats`, so narrowing the scope never leaves a conversation routed by an allowlist entry the operator forgot.

Two filters are policy the deployment cannot turn off. A message the account itself wrote (`fromMe`, including from another device) is never routed, because delivering the deployment's own answer back would wake the agent with its own words. A message id already delivered is dropped, because a provider replays history after a reconnection.

Nothing is filtered by content. `whatsapp/message-received` means a person sent something — a provider drops delivery metadata and protocol housekeeping instead of publishing it — so this package never inspects WhatsApp field names, and a media type it cannot render still becomes a turn.

### Every message identifies its chat

A session serves exactly one conversation, and the chat id is still part of every message:

```text
WhatsApp message in direct chat "Ana" [chat_id: 5511999990000@s.whatsapp.net]
From: Ana (5511999990000@s.whatsapp.net)
Sent: 2026-08-21T10:00:00.000Z

boa tarde, você pode confirmar o horário?
```

That `[chat_id: …]` header is exactly the value `whatsapp_send_message` requires, so answering the right person is a copy out of the turn rather than a fact the model has to carry from session context.

## Queued delivery, never an interruption

A message that arrives while the agent is mid-turn waits for the turn to end. Delivery claims the agent's idle phase through `runMaintenance`, so the framing enters the log and the agent's inbox between turns; a claim refused because a turn owns the agent parks on `whenIdle()` and retries at the next boundary, with the batch put back at the head so arrival order survives.

Delivery is serial per session and coalesced: everything queued at the moment a claim succeeds is delivered inside it, so a burst of messages becomes one wake-up rather than one per message. Each message is still its own follow-up turn.

One message's failure is contained. A message the log refuses is warned about and dropped, and the queue behind it keeps moving — one unloggable message cannot silence a conversation.

## Sessions

A conversation's session identity is `whatsapp-chat-<digest>`, the digest taken over the chat id: stable across restarts, and free of the characters an account address carries. A restart therefore continues the conversation instead of starting an empty one.

Opening a conversation resolves to a live agent three ways, in order:

1. An agent already published on that identity — the operator has the conversation open in the Web UI — is delivered into rather than resumed a second time over the same log. Only sessions this router opened are disposed on teardown.
2. A persisted log is resumed, composed from the preset recorded in that log rather than the deployment's current `agentPreset`: turns already in a session were produced under the composition it recorded.
3. Otherwise a new session is created, composed from `agentPreset`, with `cwd` set to the Workspace directory.

A new conversation is answered on `ctx.agentDefaultModel.currentSelection()` — the same default a freshly created session gets anywhere else. An inbound message has no operator in front of it to pick a model.

A stored session recorded under a different project directory fails loud with both paths: that means the deployment moved `directory` while logs exist under the old one.

Titles are the conversation's name: what the account resolves for the chat, then the name carried by the message, then the chat id for a conversation nobody has named yet. `whatsapp/chat-named` retitles the open session, which is how a group whose subject was unknown on its first message ends up under its subject, and how a renamed conversation follows. Titles are pinned with `ctx.sessionTitle.rename()`, whose `user` source stops automatic title generation for good; re-pinning an unchanged title is skipped, so a restart does not append a redundant event.

## The agent that answers a conversation

`agentPreset` names the [preset](../../preset/agent-presets/README.md) mounted on each conversation session as it is created — the interpreter that decides what to do with what a contact says. Absent, nothing is mounted and the session runs on whatever the composition gives every agent. The preset roster is read through `ctx.get`, not injected, so a headless composition without a roster keeps working.

Changing `agentPreset` applies to conversations opened afterwards. A session already produced keeps the preset recorded in its log.

## Live settings

`chats`, `allowChatIds`, `denyChatIds`, and `agentPreset` are also a settings section, edited in Settings › WhatsApp beside the pairing QR code ([`dsh-client-ui-settings-whatsapp`](../../client/ui-settings-whatsapp/README.md)). The router reads the authoritative policy per message, so a scope change applies to the next message without a reload; an `agentPreset` change applies to the next conversation opened.

`directory` and `workspaceTitle` are deliberately outside the section: they decide the Workspace's identity, which is fixed when the plugin loads and cannot change under sessions already attached to it.

A field the stored document leaves unset keeps the composition entry's value, so clearing a setting restores what the deployment shipped rather than emptying the field.

## Config

| Key | Default | Meaning |
|---|---|---|
| `directory` | `~/.dsh/whatsapp` | The directory the Workspace owns and every conversation session runs in. Must resolve to an absolute path. |
| `workspaceTitle` | `WhatsApp` | The Workspace's title in the sidebar. |
| `chats` | `all` | Which conversations open a session: `all`, `groups`, or `contacts`. |
| `allowChatIds` | `[]` | When non-empty, the only conversations routed. |
| `denyChatIds` | `[]` | Conversations never routed. |
| `agentPreset` | *(none)* | Preset mounted on each conversation session as it is created. |
| `seenMessageLimit` | `1000` | How many delivered message ids are remembered to suppress a provider's history replay. |

```yaml
- id: whatsapp-workspace
  name: '@deepseek-ai/dsh-whatsapp-workspace'
  config:
    chats: contacts
    workspaceTitle: WhatsApp
    agentPreset: interpreter
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
- **Sessions open without bound** — one session per conversation, created on first contact, with no eviction and no cap. `chats`, `allowChatIds`, and `denyChatIds` are the controls an account with many conversations has.
- **Sessions from an earlier standing-session layout are no longer routed** — a deployment that ran the removed `category` or `single` shapes keeps those logs attached to the Workspace and readable, and new messages open per-conversation sessions beside them. Nothing is migrated and nothing is deleted.
- **One account per Workspace, and one process per account** — the seam holds one authenticated account, so a second account means a second fiber with its own directory. The stricter rule is the provider's: two connections sharing one auth directory replace each other's linked device, and the older one dies with a connection conflict. A restart that overlaps the previous process, or a second harness pointed at the same directory, takes the account offline rather than sharing it.
