# Agent Note: A WhatsApp chat id is opaque; the provider owns chat kind

Status: implemented

English | [中文](2026-08-21-whatsapp-chat-id-opacity.zh.md)

## Problem

`WhatsAppChatId` looked like a parseable address. Every chat id observed while building the seam ended in `@s.whatsapp.net` or `@g.us`, and the subsystem doc stated that "a provider that cannot classify a conversation must fail rather than guess", which reads as a promise that those two domains are the whole set.

They are not. Driving the tools against a live account returned a named conversation addressed as `94257503293551@lid` — WhatsApp's linked-identity address space, which it is rolling out for direct chats — and `@newsletter` and `@broadcast` exist beside it.

A consumer had already taken the invitation and re-derived chat kind by suffix, to classify an address its conversation index had not observed. The result was two tools that contradicted each other: the tool that lists conversations returned the `@lid` id, and the tool that reads one rejected the same id with `"…@lid" is not a WhatsApp address`. That is the documented happy path — list, then read — and the error asserted something false about an address the account actively held a conversation with.

## Decision

Chat kind belongs to the provider, which tracks WhatsApp's address spaces, and a consumer reads `WhatsAppChat.kind` or `WhatsAppMessage.chatKind` rather than deriving it.

An unfamiliar domain classifies as `direct` instead of failing. The seam README states that a chat id is opaque and must not be parsed, and the subsystem doc's classification rule is rewritten to say the provider owns the decision and degrades rather than refusing. A test pins `@lid` to `direct` so the graceful default is a contract rather than an accident of a ternary.

## Alternatives considered

**Fail on an unrecognized domain, as the old rule demanded.** This is the rule that was written, and the live account shows why it is wrong: a fail-closed provider goes dark on the conversations WhatsApp migrates to a new address space, and it goes dark silently from the operator's side, mid-rollout, with no bad input to point at. Degrading to `direct` is wrong only for `@newsletter` and `@broadcast`, where the harm is a channel post treated as a direct message; refusing is wrong for every real conversation on a new domain.

**Enumerate the known domains and keep a closed set.** The set is not knowable: it is an undocumented protocol that gains domains between releases. Any enumeration is a list that is correct until WhatsApp ships, and its failure mode is rejecting valid addresses rather than mislabelling exotic ones.

**Normalize `@lid` to the phone-number address in the provider, so consumers see one domain.** Attractive, because it would keep the address space singular. Baileys cannot always map a linked identity back to a phone number, so some conversations would still surface as `@lid` and a consumer that trusted the normalization would break on exactly the cases the mapping failed for. Worth doing as an enrichment later; useless as a guarantee.

**Expose `resolveChat` on the seam so the provider resolves ids for consumers.** The stronger design, and still open: it would delete address parsing from consumers entirely rather than merely forbidding it. Deferred because the immediate defect is a false rejection, which the opacity contract fixes without moving a method across a package boundary mid-stack.

## Consequences

A consumer cannot learn a conversation's kind from its id, only from the seam. That is the point: the classification is now stated once, by the package that would have to change anyway when WhatsApp adds a domain.

The seam still cannot tell a channel or a broadcast list from a person, since both now arrive as `direct`. No consumer distinguishes them today, and the honest fix is a `kind` member for them rather than a suffix check somewhere above the seam.
