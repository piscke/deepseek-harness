# Agent Note: Inbound WhatsApp messages are pending context, not automatic turns

Status: implemented

English | [中文](2026-08-26-whatsapp-inbound-as-pending-context.zh.md)

## Problem

Every routed inbound message opened its own follow-up turn. An account that receives six messages while nobody is watching spends six model requests answering each one in isolation, and the operator who arrives afterwards reads six replies written without the operator's intent and without each other's content.

That is the wrong default for the use the Workspace was built for: a person watches a conversation and asks the agent about it. What they want from an arriving message is that it be *available* — legible in the Web UI, and part of the context of the next thing they ask — not that it be answered unasked.

The Web UI made the same message invisible twice over. The host already broadcast pending injected context as a `session/queue` item with `placement: 'context'`, and both client consumers dropped it: `QueueDock` renders only `queued`, `ChatView` only `steering`. Nothing displayed a model-facing message between the moment it was produced and the moment a turn claimed it.

## Decision

`inboundDelivery` decides what a routed message does, and defaults to `context`.

Under `context`, `WhatsAppSessionInbox.deliver()` appends `whatsapp/inbound` and then calls `agent.inject()`, which splices the framing into the non-waking `next-step` inbox and commits `agent/inbox/spliced`. Nothing wakes. The message waits until the operator writes their next prompt in that conversation; `Inbox.claim()` takes the whole `next-step` list before it takes one `next-turn` message, so the framing lands ahead of the prompt in the request. The model reads what arrived, then what it was asked about it.

Under `turn`, `deliver()` calls `agent.followup()` exactly as before, which is how an account answers with no operator in front of it. The field joins the user-writable settings slice, so the mode is a `cordis.yml` value and a live setting rather than a fork.

The Web UI renders any still-pending `context` placement at the conversation tail, not only WhatsApp's. `ChatView` projects each through `PendingContextRow`, which reuses the same `ContextInjectionRow` the durable node becomes, so a row looks identical before and after it is claimed and the handoff shows no visual seam.

## The idle claim survives the swap

The delivery path still claims `agent.runMaintenance` and still parks on `whenIdle()` when a turn owns the agent. That machinery reads like an artifact of `followup` — it exists so a message never interrupts a running turn — but under `context` it does more work than before, not less.

`inject()` targets the `next-step` boundary. A turn already in flight reaches that boundary at its next pre-step and would consume the message there, answering it on its own: precisely the behavior this change removes, reintroduced through the other end. Claiming the idle phase is what keeps an arriving message out of a turn nobody aimed at it.

## Why the framing declares `notice`

The injected message's plugin source carries `form: 'notice'` and a one-line `summary` (`Ana: alguém pode buscar o bolo?`), produced by `summarizeInbound()` and bounded by `boundContextSummary`.

`notice` is the only form whose summary rides the *collapsed* row: `contextBody()` returns the summary for `notice` and nothing for the other forms. A waiting message therefore reads as itself in the transcript without the operator expanding it, which is what makes "visible while it waits" true rather than nominal.

## Alternatives considered

**Replace `followup` outright with no mode.** Smaller surface, one behavior to document. Rejected because an autonomous answering account is a real deployment of this package and its only change would otherwise be a fork. `turn` preserves the previous semantics exactly, and the default carries the new intent.

**`form: 'relay'` on the source.** The obvious reading — a message another party addressed to this agent. Rejected on inspection: `RelayBody` reads `senderSessionId` off the source and degrades to the opaque body when it is absent, and WhatsApp has no session id, so `relay` would have rendered exactly like no form at all. `relay` also means an agent-to-agent relay, which this is not.

**Buffer the messages inside the plugin and inject them when the operator prompts.** Keeps a pending message out of the agent's inbox until it is certainly wanted. Rejected because the inbox already is that buffer, and it is durable: a plugin-side list would lose everything waiting when the process stopped, and would need its own claim, ordering, and cancellation rules against the ones `Inbox` already enforces.

**Render the pending row only for WhatsApp.** Rejected because the placement is generic and the host already computes it. Approval notices and task-completion notices are injected too; they are normally claimed at a running turn's next step boundary and so flash at most, but suppressing them would mean teaching the client which producers deserve to be seen.

**Force-scroll to a pending context row, as pending steering does.** Rejected: steering is the reader's own words, arriving because they pressed a key. Inbound context arrives because someone else typed. It joins the follow signal — so it stays in view while the reader is pinned to the bottom — and never yanks the viewport.

## Testing

Package tests cover both modes at the delivery seam: `context` leaves the agent idle with the framing in `agent.inbox.nextStep` and asserts the exact `notice` source, `turn` produces one follow-up per message, and a settings change mid-queue is captured per message rather than per batch. `summarizeInbound` is covered for the sender fallback, unsupported media, and bounding. Client tests cover the projected `source` on a `context` row and the pending row rendering at the flow tail.

The keyless assembled-app snapshot is the proof of the whole semantics. Its driver publishes one inbound message, waits for `agent/inbox/spliced`, and **fails** unless the agent is idle with exactly one pending next-step message; only then does it submit the operator's prompt. The expected log shows one `turn/start` for two `user/message` events — the WhatsApp framing first, the operator's prompt second.

## Consequences

- A message waiting under `context` is discarded by `agent.cancel()`, which clears pending inbox work. The durable `whatsapp/inbound` record still holds it, but it does not reach the model on the request it would have ridden.
- Pending context accumulates without a cap. A busy conversation keeps injecting until the operator writes, and everything waiting rides that one request. `chats`, `allowChatIds`, and `denyChatIds` remain the controls.
- The client-side queue projection now carries each row's `MessageSource`, typed `unknown` because `MessageSource` is merge-extensible and the client must render a producer it does not know.
- This supersedes the delivery decision in [the Workspace and tools note](2026-08-22-whatsapp-workspace-and-tools.md); its filtering, framing, logging, and tool decisions are unchanged. It applies the injection lifecycle recorded in [separate context injection from turn execution](../architecture/2026-07-24-separate-context-injection-from-turn-execution.md) without altering it.
