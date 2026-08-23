# Agent Note: WhatsApp Workspace and model-facing tools

Status: implemented

English | [中文](2026-08-22-whatsapp-workspace-and-tools.zh.md)

## Problem

[The WhatsApp seam](../architecture/2026-08-21-baileys-runtime-specifier.md) gives the harness one authenticated account: status, conversations, history, sending, and an inbound event. Nothing consumes it. An account that emits `whatsapp/message-received` into an empty room is not an assistant — a person's messages have to reach a model, and the model needs a way to answer.

Two questions have to be answered together, and neither has an obvious default.

**Where does a conversation live?** The harness organizes work as sessions inside workspaces, and a workspace is a directory. WhatsApp has no repository. One session per conversation, one per kind of conversation, and one for everything are all defensible for different accounts, and the choice changes what the model can see at once.

**When does an inbound message reach the model?** Messages arrive whenever the other person types, including in the middle of a turn. A naive listener that starts a turn per message either interleaves two turns over one session or drops whatever arrives while the agent is busy.

## Decision

Two packages, split along the line that already separates the rest of the repository: one owns durable state and lifecycle, the other owns what the model reads.

[`dsh-whatsapp-workspace`](../../../../packages/whatsapp/whatsapp-workspace) ensures a directory (`directory`, default `~/.dsh/whatsapp`), registers it through `ctx.workspaceRegistry.create()`, opens the route's sessions with `cwd` equal to that directory, pins their titles through `ctx.sessionTitle.rename()`, and delivers inbound messages into them as follow-up turns.

[`dsh-tool-whatsapp`](../../../../packages/whatsapp/tool-whatsapp) registers `whatsapp_list_chats`, `whatsapp_read_chat`, `whatsapp_mark_read`, and `whatsapp_send_message`, each independently disablable, with sending gated on `ctx.approval`.

Both are Consumers of `ctx.whatsapp` and neither imports a provider. A deployment can take either alone: tools without a Workspace is a headless composition that answers on demand, a Workspace with `send: false` is a read-only triage.

### Routing is `Config`, because no shape is right for every account

`route` is required and has no default: `category` (a `Groups` session and a `Contacts` session), `per-chat` (one session per conversation, opened on first contact), or `single` (everything in one). `allowChatIds` is exhaustive when non-empty and `denyChatIds` wins over it.

The choice of shape did not survive: [one session per conversation](2026-08-25-whatsapp-session-per-conversation.md) removed `route`, `category`, and `single`, and replaced them with `chats`, which decides *which* conversations open their own session. Nor did the delivery unit: [inbound as pending context](2026-08-26-whatsapp-inbound-as-pending-context.md) made a follow-up turn per message the opt-in `inboundDelivery: turn`, and defaults to holding the framing as pending context the operator's next prompt carries. Everything below about filtering, framing, logging, and the tools is unchanged, as is delivery's refusal to interrupt a running turn.

Two filters follow from the seam's own contract and are not configurable. `fromMe` messages are never routed — delivering the deployment's own answer back would wake the agent with its own words, and the seam deliberately reports them because a status display needs them. An already-delivered message id is dropped, because the seam's contract is that a provider replays history after a reconnection.

Routing makes no third judgment. A live pairing burst of `whatsapp/message-received` frames nobody authored made one look necessary, and this milestone briefly carried a drop-list of WhatsApp envelope field names. It was wrong: the seam reports whichever envelope key decoded first, and WhatsApp attaches `senderKeyDistributionMessage` to most group messages, so a list wide enough to catch signaling would have discarded a photo posted to a group — silently, with nothing logged. The seam now guarantees that an inbound event is something a person sent, and the fix belongs there, where the envelope is still intact. Duplicating the judgment here would re-create the hazard the moment the two lists drifted, so this package inspects no WhatsApp field names at all.

Session ids are deterministic (`whatsapp-groups`, `whatsapp-contacts`, `whatsapp-conversations`, `whatsapp-chat-<digest>`), so a restart resumes the conversation rather than starting a parallel empty one. Titles are pinned with the `user` source, which is what permanently stops automatic title generation; re-pinning an unchanged title is skipped so a restart appends nothing.

### Every message names its own conversation

Under `category` and `single`, one session serves many conversations. The conversation is therefore part of each message rather than context the model is asked to hold:

```text
WhatsApp message in group chat "Família" [chat_id: 12036300000@g.us]
From: Ana (5511999990000@s.whatsapp.net)
Sent: 2026-08-21T10:00:00.000Z

alguém pode buscar o bolo?
```

The `[chat_id: …]` value is exactly what `whatsapp_send_message` requires, so answering the right person is a copy rather than an inference. This is why `per-chat` does not get a cheaper framing: a uniform framing means the model never learns that the chat header is sometimes absent.

### Delivery queues, it never interrupts

Inbound delivery claims the agent's idle phase through the maintenance path — the same mechanism scheduled follow-ups already use. A claim refused because a turn owns the agent parks on `whenIdle()` and retries at the next turn boundary, with the pending batch put back at the head so arrival order survives. Delivery is serial per session and coalesces whatever is queued when a claim succeeds, so a burst is one wake-up carrying several turns rather than several wake-ups.

One message's failure is contained: a message the log refuses is warned about and dropped, and the queue behind it keeps moving. A single unloggable message cannot silence a conversation.

### Model-visible ⟺ logged, in the direction that can fail

`whatsapp/inbound` is appended **before** the follow-up turn is queued, so a message the log cannot record never reaches the model. `whatsapp/outbound` is appended **after** the provider acknowledged the send, so the log never claims a send WhatsApp refused. Both carry the WhatsApp identity — chat id, chat name, message id — that the model-visible text cannot be parsed back into, and both have `./invariant` companions that validate stored records.

### Sending asks every time

`whatsapp_send_message` requires `chat_id`; there is no "reply to the last chat", no session default, and no inference from history, because one session serves many conversations and a default destination is eventually the wrong person.

Addressing is not validated here at all, and membership in `listChats()` does not gate it. A live account showed why membership cannot: a provider's chat index is connection-scoped, so a freshly connected process may legitimately know no conversations, and gating on membership would make every tool unusable exactly when the deployment restarts. Both read tools say so to the model — an empty list otherwise reads as "this account has no conversations", and an empty history page as "this conversation is empty" rather than "this connection retained nothing", which would send the model away from a chat it can still write to.

Validating the *form* of an id was the weak point, and a live account proved it. The first version accepted `@s.whatsapp.net` and `@g.us` and documented the pair as exact protocol constants. WhatsApp is rolling out `@lid`, its linked-identity space for direct conversations: `whatsapp_list_chats` returned a named `@lid` conversation and `whatsapp_read_chat` refused the id its own list tool had just produced, with a message asserting the value was not a WhatsApp address. The suffixes are constants; the set of them is not. The seam answered by making `WhatsAppChatId` opaque and adding `ctx.whatsapp.resolveChat()`, so this package deleted its address table and `chatKindOf` rather than growing them: every tool now resolves through the account, which decides the conversation's kind, names it when this connection observed it, and rejects only a value that names no conversation at all.

Resolving before anything else is what makes a logged-out account fail before an operator is asked to approve a send. The accepted cost is that an address the connection never observed still resolves, so a wrong id reaches the approval card and is refused only when the send is attempted; the card naming the destination is the guard, and guessing at ids is what broke `@lid`.

An unresolved display name is stated, not papered over. The first version reported `name: chat.name ?? chat.id`, which made every rendered line print the id twice and, worse, presented digits to the approving operator as though they identified someone. `name` and `chat_name` are now absent when unresolved, rendering as `(unnamed)` in results and as `an unnamed conversation at <id>` on the approval card, so "I do not know who this is" is a fact the operator reads rather than a gap disguised as knowledge.

Approval names the destination in full before quoting the body, and fails closed on rejection, cancellation, an unavailable channel, a composition with no approval service, and an agent-less execution alike. `ctx.approval` is deliberately absent from `inject`, so a composition without an approval channel still registers the read tools and refuses only the send.

## Alternatives considered

**A single hardcoded session per account.** Simplest to build and defensible for a personal number. Rejected because the shape is the deployment's decision, not the plugin's: an account that receives group traffic and client messages wants different agents for them, and a session that mixes both makes every reply a disambiguation problem. `single` remains available as one route.

**Interrupt the current turn with an arriving message.** Tempting because a chat assistant should feel immediate. Rejected because a turn is the unit the agent-loop and the session log are built around: splicing a message into a running turn either corrupts the request being assembled or produces a log that cannot be replayed. Waiting one turn boundary is a latency cost measured in seconds; the alternative is a correctness cost with no bound.

**One turn per message with no coalescing.** Rejected as the delivery unit but kept as the *turn* unit: a burst of six messages claims the idle phase once and enters as six turns, so ordering and per-message framing survive while the agent is woken once.

**Auto-reply, with approval only for unusual sends.** Rejected outright. The operator's phone number is the identity at risk, and "unusual" is not something this package can define. Every send asks, and a standing per-chat grant is deferred to a policy that can be persisted and revoked.

**A consumer-side drop-list of WhatsApp envelope field names.** Carried in this milestone for a while, after a live pairing burst. Rejected once the seam's reported media type turned out to be whichever envelope key decoded first: WhatsApp attaches `senderKeyDistributionMessage` to most group messages, so any list wide enough to catch signaling drops a photo posted to a group, and nothing logs the loss. Content judgment belongs where the envelope is intact.

**A `reply` tool that answers the routed conversation implicitly.** Attractive for token cost and a fair fit for `per-chat`. Rejected because the same tool would be wrong under `category`, and a tool whose safety depends on a routing config the model cannot see is a trap. The chat id is already in the message the model just read.

**Rejecting a chat id the account has not observed.** The original design, and wrong: it reads the index as a roster when it is a cache of observed activity. A live reconnection reported zero conversations for an account with many, which would have made every tool fail until traffic arrived. Kept as deferred work: a roster persisted across connections would let the tools distinguish "not this account's chat" from "not seen yet".

**Keeping a consumer-side table of WhatsApp's address spaces, extended with `@lid`.** The first repair, and shipped briefly. Rejected once the seam made a chat id opaque: the table's failure mode is silence in the direction that matters — a real conversation refused because WhatsApp added a space this package had not heard of — and WhatsApp owns and extends that set. Normalizing `@lid` away in the provider was also offered and declined, because Baileys cannot always map a linked identity back to a phone number, so `@lid` reaches the consumer either way and the table survives with a translation step in front of it. The provider already reports `kind` on every chat and message, so the consumer was re-deriving something it is handed.

**Deduplicating against the durable `whatsapp/inbound` log.** Correct, and deferred. The in-memory `seenMessageLimit` set covers the replay the seam actually documents (a reconnection inside one process life); reading the log at load costs a scan of every session's history for a case that only occurs when the process restarts while a provider is mid-replay.

## Consequences

The Web UI shows a WhatsApp Workspace beside repository workspaces with no UI change, because `ctx.workspaceRegistry` already carries anything with a directory. Conversation sessions are ordinary sessions: they compact, resume, and are inspectable with the same tools.

Every routed message reaches the LLM provider and the session log. For personal conversations that is the trade the subsystem is built on, restated in every README rather than assumed.

`per-chat` opens sessions without a cap or eviction; an account with many conversations needs `allowChatIds` or a category route. Deduplication does not survive a restart. Both are recorded in the packages' Known Limitations.

Misconfiguration fails at load: an unusable directory, a registry that refuses the path, a standing session that will not open, a `readChatDefaultLimit` above `readChatMaxLimit`. A Workspace that silently never appears is indistinguishable from a disconnected account, which is the failure this rules out.

## Testing

Unit and composition tests cover routing modes, allow/deny precedence, `fromMe`, duplicate suppression, the mid-turn claim refusal and its retry, batch coalescing, session resumption and the moved-directory failure, title pinning, every tool's argument bounds and error strings, and each approval outcome. Ids in unfamiliar address spaces, `@lid` among them, have a regression test asserting they reach the account untouched. Both `./invariant` companions are exercised against valid and corrupt stored records. A keyless snapshot replays the assembled application through the whole tool suite, including an address the account refuses, an operator rejection, and an approved send. Coverage is 100% per file, as the gate requires.

**Almost nothing is verified against a real WhatsApp account.** Every unit test drives a scripted seam. A live pass over `dsh-tool-whatsapp` against a paired account did exercise the real path — `whatsapp_list_chats`, a plain send, a quoted send, `whatsapp_read_chat`, `whatsapp_mark_read`, and exactly one `whatsapp/outbound` per confirmed send — so the tool surface holds under a real provider. `dsh-whatsapp-workspace` was not covered, because routing needs an inbound message from a third party rather than the account itself: how the Workspace and its sessions appear in the Web UI, and how the queue behaves under a genuine reconnection replay, remain the largest open risks in this milestone.

That pass also corrected an assumption this milestone had been carrying: a connection is not reliably empty at connect. An account with app-state sync keys on disk can list conversations before any message arrives. Nothing depends on the index being empty — the tools render whatever is there — but the model-facing description no longer promises a state the provider does not guarantee in either direction.
