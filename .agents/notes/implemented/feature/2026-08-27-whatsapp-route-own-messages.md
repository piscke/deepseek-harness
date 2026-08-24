# Agent Note: The paired phone is the operator, so only the deployment's own echo is filtered

Status: implemented

English | [中文](2026-08-27-whatsapp-route-own-messages.zh.md)

## Problem

Routing dropped every message the account itself wrote. `fromMe` names two senders at once: the operator typing on the paired phone, and this deployment's own answer republished by the provider. Only the second must be kept away from the agent.

Dropping both means an account cannot reach its own harness. The operator holds the one phone the deployment is linked to, and writing to it — to the self-chat, or to any conversation in scope — is the shortest way to see whether routing, session opening, and delivery work at all. Trying that required a second number and a willing third party, which is why inbound routing reached [the Workspace and tools note](2026-08-22-whatsapp-workspace-and-tools.md) recorded as unverified against a real account.

## Decision

`routeMessage` no longer looks at `fromMe`; it applies scope, allow, and deny alone. What the account writes is routed like anything else.

The echo is removed by name instead of by sender. `WhatsAppRuntime.send` records the conversation and the exact text of every send it dispatches, and `ctx.whatsapp.claimOwnEcho(message)` answers whether an observed message is one of those sends, consuming the record. `WhatsAppInboundRouter.accept` claims first and returns when the claim succeeds.

The record is written **before** `provider.send` is called, not when the send is acknowledged. Baileys publishes `messages.upsert` for its own send from inside `sendMessage`, so the echo is observed before `send` resolves and before any id exists; a record written on the acknowledgement would arrive behind the router that already delivered the message. Pre-dispatch bookkeeping is the only ordering that holds.

A rejected send keeps its record, because a send can fail after WhatsApp already relayed it. Records leave only by eviction: `OUTBOUND_ECHO_RECALL` of them stay claimable, which is the depth of the mechanism rather than a deployment choice — it only has to exceed the sends whose echo has not been observed yet.

The claim runs ahead of the routing policy, so a send into a conversation the deployment does not route still consumes its own record instead of leaving it to be matched by a later message.

There is no configuration. Which of the two senders wrote a message is a fact the harness already knows about itself, not a deployment preference.

## Alternatives considered

**A `ownMessages: ignore | route` config field.** The first shape considered, and the one the operator was asked about. Rejected because neither value is a deployment's real position: nobody wants their own echo routed, and an account that cannot hear its own operator is not a deliberate configuration either. Adding the field would have shipped the same echo suppression plus a switch with one sensible setting.

**Suppress on `whatsapp/message-sent`, or by the acknowledged message id.** The obvious place, and the one that loses the race described above. The id exists only once the provider acknowledges, which is after the echo has already been published.

**Do the bookkeeping in the Workspace router.** Rejected because the router does not own sends. The model sends through `whatsapp_send_message` in a different package, and both reach the account through `ctx.whatsapp`, so the seam is the only place that observes every dispatch.

**Remember sent bodies in a set rather than a consumed queue.** Rejected because a set never forgets: the operator repeating a sentence the agent once wrote would be swallowed forever. A consumed claim can swallow at most as many copies as the harness actually sent.

**Drop the record when the send rejects.** Rejected: a rejection does not prove nothing was relayed, and the echo of a send that failed late would then wake the agent.

## Testing

Seam tests cover a claim consumed once, an echo published before the send resolves, a record kept across a rejected send, refusal for another chat, another body, media, and `fromMe: false`, and eviction past the recall. Workspace tests cover the account's own message routed and the deployment's own send never delivered.

The keyless assembled-app snapshot is the proof of the pair: its driver publishes a contact's message, this deployment's echo, and the operator writing from the paired phone, and the expected log carries exactly two `whatsapp/inbound` events with the agent's own answer absent.

## Consequences

- An echo does not survive a restart. The claimable sends live with the seam, so an echo the provider replays afterwards is routed as what the account wrote.
- A provider that publishes no echo of its own traffic leaves records until later sends evict them, and the operator writing that exact text into that conversation meanwhile is taken for the echo.
- Inbound routing is now reachable from the paired phone, so the live-verification gap named in [the Workspace and tools note](2026-08-22-whatsapp-workspace-and-tools.md) no longer needs a third party to close.
