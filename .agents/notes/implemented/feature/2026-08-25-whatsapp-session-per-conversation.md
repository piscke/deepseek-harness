# Agent Note: One WhatsApp session per conversation

Status: implemented

English | [中文](2026-08-25-whatsapp-session-per-conversation.zh.md)

## Problem

[The WhatsApp Workspace](2026-08-22-whatsapp-workspace-and-tools.md) shipped with three routing shapes, and the example composition used the one that groups conversations by kind: a `Groups` session and a `Contacts` session. That shape answers "who is talking to this account" but not the question the subsystem exists for — reading one contact's messages over time and doing something with them.

An interpreter per contact needs three things the shipped Workspace did not give it.

**A conversation's history has to be its own.** Under a shared session, what one contact said is context for every other contact's turn: the model is asked to keep straight who is who, the log cannot be read as one person's thread, and compaction eventually drops one contact's facts to make room for another's.

**A conversation has to be recognizable.** The per-conversation shape titled a session with the name carried by the message. Only a direct message carries one — a group's subject reaches the connection through its own update — so every group session was titled with its address, `12036300000@g.us`, in the sidebar and in the session list.

**A conversation's agent has to have tools.** `openSession` created its sessions without a `setup` callback, and mounting the preset roster only happens through `setup`. In the Web composition, every WhatsApp session therefore ran with no preset: no tools, no prompt sections. The agent could not answer the message that woke it, and nothing said so.

## Decision

One conversation is one session, always. The Workspace no longer decides *how* conversations map onto sessions; it decides *which* conversations it answers.

### `chats` replaces `route`

`WhatsAppRouteMode`, the standing sessions (`whatsapp-groups`, `whatsapp-contacts`, `whatsapp-conversations`), their titles, and `openStandingSessions` are gone. In their place, `chats` — `all`, `groups`, or `contacts` — decides which conversations open a session, and is judged before `allowChatIds` and `denyChatIds`, so narrowing the scope cannot be defeated by a forgotten allowlist entry.

Session identity is unchanged: `whatsapp-chat-<digest>` over the chat id, which is what the removed `per-chat` mode already produced. A deployment that ran it keeps every log and resumes it.

Sessions written under the removed shapes are not migrated and not deleted. They stay attached to the Workspace and readable in the sidebar; new messages open per-conversation sessions beside them. Migration would have to invent which contact each turn of a shared log belonged to, and that fact was never recorded.

### A conversation's name is a fact the provider owns

`whatsapp/chat-named(chatId, name)` is new on the seam: the connection learned or changed a conversation's display name. It exists because a name arrives outside the message stream — a group's subject reaches Baileys through `groups.update`, a contact's through the roster — so a conversation is routinely unnamed when its first message is observed and named moments later.

The Baileys provider subscribes to the six roster streams with one listener, and asks `groupMetadata` once when a group's first message arrives unnamed. The lookup never delays that message: the subject reaches consumers through `chat-named` when it lands. Concurrent asks for the same group collapse into the one request in flight, a failed lookup is warned about and leaves the conversation unnamed, and a name is published only when it actually changes, so a reconnection re-syncing the same roster is silent.

Names are held in their own index, separate from the observed-message index, so learning what a conversation is called never invents a conversation `listChats` would then report.

The Workspace titles a session with the resolved name, falling back to the name on the message and then to the chat id, and retitles the open session on `chat-named`. That is how a group whose subject was unknown on first contact ends up under its subject, and how a renamed conversation follows.

### The agent that answers a conversation

`openSession` now composes the agent it creates. `agentPreset` names the preset mounted on a new conversation session; the roster is read through `ctx.get('agentPresets')` rather than injected, so a headless composition without a roster still routes. A resumed session mounts the preset recorded in its own log, never the deployment's current one: its turns were produced under the composition it recorded.

A new conversation is opened on `ctx.agentDefaultModel.currentSelection()`. An inbound message has no operator in front of it to pick a model, and a session created without one fails its first turn with "has no provider/model" — which is what the snapshot in this change first reproduced.

An agent already published on the conversation's identity — the operator has that conversation open in the Web UI — is delivered into rather than resumed a second time over the same log. The router disposes only what it opened.

### The routing choice is editable while the account is connected

`chats`, `allowChatIds`, `denyChatIds`, and `agentPreset` are also a settings namespace, and the WhatsApp Settings page grows a card next to the pairing QR that edits the scope. The router re-reads the authoritative policy per message, so a change applies to the next message without a reload; a changed `agentPreset` applies to the next conversation opened.

`directory` and `workspaceTitle` stay out of the namespace. They decide the Workspace's identity, which is fixed at load and cannot change under sessions already attached to it.

The card is on the ordinary settings plane, not the loopback channel [the pairing page needs](2026-08-24-whatsapp-pairing-in-settings.md): a routing scope is not a credential.

## Alternatives considered

**Keeping `category` and `single` beside the per-conversation shape.** The compatible move, and the one this change deliberately did not make. Three shapes mean the framing, the titles, the preset semantics, and every test matrix carry a mode dimension forever, to keep alive two shapes whose whole value was reducing session count — the problem `chats` and `denyChatIds` address directly, without mixing two people's history into one log. Pre-release, the correct foundation outranks the shim.

**Migrating the standing sessions into per-conversation ones.** Attractive because a deployment that used `category` sees its history stop growing. Rejected because the mapping does not exist: a shared log records turns, not which contact each turn belonged to, and splitting on the chat id inside the framing text would rewrite history by parsing prose. The old sessions stay readable, which is the honest outcome.

**Titling a group session with its address until a name arrives, and leaving it.** What the shipped `per-chat` mode did. Rejected because the address is exactly what the operator cannot recognize, and the name is available seconds later — the cost of following it is one event and one conditional rename.

**Resolving the group subject before delivering the message that revealed the group.** Simpler: the title would be right on the first turn. Rejected because it makes a network call a precondition for delivering a message, so a slow or failing lookup delays or drops real content. Naming is a display concern and follows the message.

**Deriving the name in the Workspace instead of the provider.** The Workspace could call `resolveChat` and cache. Rejected because the provider is the only party that sees the roster streams, and a consumer polling `resolveChat` cannot learn about a rename at all. Naming belongs where the connection is.

**Giving the Workspace `provider` and `model` config fields.** Considered for the missing model selection. Rejected because it would be a second place to configure the default model, drifting from the one the rest of the harness reads; `ctx.agentDefaultModel` already owns "what a newly created session runs on" and follows the user's stored selection.

**A preset selector in the Settings card.** Deferred, not rejected: `agentPreset` is in the namespace and editable, but a dropdown is worth building once there is an interpreter preset to choose. Until then the card would list a roster the deployment did not compose for this purpose.

**Auto-approving sends inside the WhatsApp Workspace.** Out of scope here, and recorded as the missing piece for unattended operation: `whatsapp_send_message` still asks the operator every time, so an interpreter can read and record without a human, but not answer without one.

## Consequences

A WhatsApp Workspace starts empty on a fresh deployment: no session exists until a conversation arrives. After first contact the sidebar lists every conversation ever answered, because the session-to-Workspace attachment is durable.

Sessions open without a cap or eviction, one per conversation. `chats`, `allowChatIds`, and `denyChatIds` are the controls; a limit or expiry remains deferred work.

The framing is unchanged and still names the chat id on every message, even though a session now serves one conversation. It is the value `whatsapp_send_message` requires, and reading it out of the turn is more reliable than expecting the model to carry it from session context.

`whatsapp/chat-named` is a new seam event, so every consumer that displays a conversation name is expected to follow it rather than treating its first read as final. `WhatsAppChat.name` says so.

This note supersedes the routing-shape part of [the Workspace and tools note](2026-08-22-whatsapp-workspace-and-tools.md); everything that note records about delivery, framing, logging, and the model-facing tools is unchanged and remains current.

## Testing

Package tests cover the scope filter for each kind, allow/deny precedence over it, `fromMe`, titling from the resolved name and from the message, retitling on `chat-named`, the preset mounted on creation and the logged preset on resume, the default model selection passed at creation, delivery into an already-published agent, and the moved-directory failure. The Baileys tests cover each roster stream, the on-demand group lookup, its collapsing of concurrent asks, and the warning path when the subject cannot be read. The Settings card is covered against the real namespace schema and the real `settings.mutate` wire.

A keyless snapshot replays the assembled application: one inbound message opens one session titled `Ana`, logs `whatsapp/inbound`, splices the framing into the agent's inbox, and completes the turn. One conversation keeps the request sequence deterministic; the scope filter and retitling are package-level facts.

Nothing here is verified against a real WhatsApp account. Group naming in particular rests on the socket double: `groupMetadata` and the roster streams are exercised through the port, never against Baileys.
