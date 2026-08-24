# Agent Note: A session holding unread context announces itself in the sidebar

Status: implemented

English | [中文](2026-08-27-unwatched-context-reminder.zh.md)

## Problem

Inbound WhatsApp messages [wait as pending context](2026-08-26-whatsapp-inbound-as-pending-context.md) instead of opening a turn. That is the right model semantics and the wrong arrival signal: nothing wakes, so nothing runs, so the sidebar's only green dot — the completion reminder, armed by a running→idle edge — never arms. A conversation the operator is not currently looking at receives a message and its row is indistinguishable from a row where nothing happened.

The operator's own use is the one this breaks. They watch one conversation, someone writes in another, and the material that arrived is legible only after they guess which row to open. The transcript renders the waiting message correctly; the surface that tells them a transcript is worth opening did not exist.

## Decision

`SessionManager` owns a second green reminder, `pendingContextNotifications`, beside the completion one. It is read off the authoritative `session/queue` snapshot: a frame carrying at least one `context` placement for a session that is not the selected one arms the reminder, and a frame without one disarms it. Selecting the session clears it, exactly as selecting clears the completion reminder.

The bit rides `SessionListEntry.pendingContext` through `flattenLineage` into `SessionSummary`, `SessionNode`, and `SearchResultNode`, and `sessionStatuses()` presents it as a `done`-state dot labelled `status.newContext`. It outranks the completion reminder — new material the reader has not seen matters more than an account of work they have — while pending interaction, own activity, and descendant activity all still outrank it.

The reminder is producer-agnostic. The host already resolves the `context` placement for every injected message, so the dot reports "there is something in here you have not read", not "WhatsApp wrote". Approval and task-completion notices are injected too; they are claimed at a running turn's next step boundary, and a running session shows the activity dot instead, so they cannot linger as a green dot.

## Why the queue snapshot rather than a projection

A session projection folds the durable log and would survive a restart, which the queue snapshot does not: the mux baseline replays `session/queue` only for sessions with a live agent, so a cold session's waiting context is invisible until it resumes.

The queue snapshot still wins, because the reminder must agree with the surface it points at. The pending row in the transcript is drawn from that same snapshot, so a dot derived from it can never claim material the conversation does not show. A projection would have to re-derive "still pending" from `agent/inbox/spliced` plus every claim and cancellation, duplicating `Inbox`'s own arbitration, and would then disagree with the transcript whenever the two derivations drifted.

## Alternatives considered

**Clear the dot only when the context is claimed by a turn.** Truer to "unread": the material is still pending after the operator opens the session and reads it. Rejected because it makes the dot a property of the queue rather than of the reader, and the sidebar already establishes the opposite convention — the completion reminder is consumed by looking. A dot that survives being looked at is a dot the operator learns to ignore.

**Arm on the durable `whatsapp/inbound` event instead.** Direct and producer-specific. Rejected because it teaches the sidebar one plugin's vocabulary for a fact the host already computes generically, and because the durable record says a message arrived, not that it is still waiting: a claimed or cancelled message would keep the dot lit.

**A distinct dot state (a new colour) for waiting context.** Rejected as an unforced vocabulary addition. `StateDot` has four states and this is the same claim the completion reminder makes — "something finished here, come look" — so it takes the same green and distinguishes itself in the label and hover card.

**Count the waiting messages in the row.** Rejected: pending context accumulates without a cap, so the count is unbounded and says nothing the operator acts on differently. The row's own hover card and transcript carry the content.

## Testing

Manager tests pin the reminder's whole lifecycle against queue frames: it arms for an unwatched session, never arms for the watched one or for `queued`/`steering` placements alone, disarms on the snapshot that no longer carries the row, re-baselines on `session/subscribed`, and is dropped with the session and swept when the list stops carrying it. Row tests assert the dot, its label, and that waiting context outranks the completion reminder; tree tests cover its projection into grouped, flat, and search rows.

## Consequences

- A conversation whose host restarted while messages waited shows no dot until its agent is live again, because the mux baseline reads live agents only. The durable record and the transcript are unaffected.
- Every injected-context producer inherits the reminder. A future producer that injects into idle unwatched sessions routinely would light rows the operator did not expect, and would need its own placement rather than a suppression list here.
- The sidebar now has two green reminders sharing one state and one slot. `showsStatus()` is the single predicate deciding whether the dot renders at all, so a third reminder joins in one place.
