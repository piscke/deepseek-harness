# Agent Note: An archived WhatsApp conversation unarchives when it speaks again

Status: implemented

English | [中文](2026-08-23-inbound-message-unarchives-conversation.zh.md)

## Problem

Archiving a session hides its row on every grouping surface ([the archive set](2026-07-31-session-archive-global-set.md)), and nothing put an id back. That is coherent for a session the operator finished with, and wrong for a WhatsApp conversation: the contact keeps writing, the router keeps delivering, the agent keeps answering, and the exchange happens where no surface can reach it — the sidebar has no archived view and no restore action. Archiving read like muting a chat and behaved like deleting its row while the conversation ran on.

## Decision

**An inbound message routed to a session clears that session from the registry-global archive set before delivery, so a conversation that speaks again is visible again; the registry gains the inverse write, `ctx.workspaceRegistry.unarchiveSession(id)`.**

- Registry: `unarchiveSession` rides `enqueueOperation` beside `archiveSession`, so its check-then-write cannot interleave with another archive change. An id the set does not hold resolves without writing, and — unlike archiving — the session need not still exist: the set entry outlives its log, and refusing to remove it would strand a hidden id no surface can reach. `WorkspaceUnknownSessionError` therefore stays an archive-only failure.
- Router: `WhatsAppInboundRouter.accept` calls the clear after the routing filters and the replay window, so a dropped message never resurfaces a conversation the deployment does not answer. The membership test reads `archivedSessionIds` synchronously, so an unarchived conversation costs one lookup and writes nothing.
- Delivery never waits on it: the row is display state, a failure warns and leaves the conversation archived, and the message reaches the model either way.
- The wire needs nothing new. `host/archived-sessions-changed` already pushes the full set after every durable change by comparing the domain global state, and the client installs snapshots rather than merging deltas, so a removal propagates on the path an addition already used.

## Alternatives considered

**Leave archiving permanent and add a manual unarchive control.** Rejected as the answer to this problem: a restore surface is worth building, but it makes the operator notice a hidden conversation first — and a conversation nobody can see is exactly what they cannot notice. The two are independent; a manual control can still land.

**Keep the conversation archived and signal it another way (badge, notification).** Rejected: it invents a second visibility concept beside the archive set, and the row it would point at is the one being hidden.

**Unarchive inside `openSession`, where the Workspace already accounts the session.** Rejected: the router opens a conversation once per process, so archiving a running conversation would never be undone — the common case, since the operator archives what is currently noisy.

**Make it configurable (a "keep conversations archived" policy field).** Rejected for now: the deployment control that actually stops a conversation is `denyChatIds`, which stops routing rather than hiding a running exchange. A policy field is warranted once a manual restore surface exists to pair it with.

**Clear the set generically, on any session activity.** Rejected: no general activity seam owns "the user is being addressed", and a background subagent turn or a maintenance write would resurface rows the operator deliberately filed away. WhatsApp's inbound stream is a person speaking, which is what justifies the rule.

## Consequences

Archiving a WhatsApp conversation is now "hide it until it matters again" rather than "hide it for good"; nothing else changes what archiving means, and a session with no inbound stream still stays hidden until a restore surface exists. Because the write is not awaited, the row can reappear a moment after the message lands, and a write failure leaves the conversation hidden until its next message. The domain tests pin the inverse write (durability, position retention, the no-write repeat, an id whose session is gone), and the WhatsApp composition tests pin both directions of the routed path, including the warn-and-deliver behavior under an injected medium failure.
