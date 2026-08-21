# Agent Note: Classify a WhatsApp message by its authored content, not its first envelope field

Status: implemented

English | [中文](2026-08-21-whatsapp-envelope-classification.zh.md)

## Problem

A Baileys `message` body is a protobuf-decoded object whose keys are field names, in decode order. That order carries no significance: WhatsApp attaches delivery metadata as *siblings* of the real payload — `messageContextInfo` beside media, `senderKeyDistributionMessage` on most group messages — and a protocol frame such as a revocation or a history-sync notification arrives as `protocolMessage` with no payload at all.

The provider classified non-text content as `Object.keys(body)[0]`, so an image sent to a group could be reported as `{ kind: 'unsupported', mediaType: 'senderKeyDistributionMessage' }`. It also published pure protocol frames as `whatsapp/message-received` under the fallback `mediaType: 'empty'`.

Both defects push WhatsApp's wire vocabulary onto every consumer. A consumer that filtered those field names to avoid answering housekeeping — the obvious reaction to a burst of `protocolMessage` during history sync — would silently drop the group media the provider had mislabelled. The provider owns the library's field names; nothing above the seam should have to know them.

## Decision

`contentOf()` names the payload rather than whichever field decoded first, and returns `undefined` when the envelope holds nothing a person authored, which drops the entry in `normalizeMessage()` alongside the existing no-id and no-address cases.

One constant, `NON_CONTENT_FIELDS`, lists the fields that never state what a person sent: `messageContextInfo`, `senderKeyDistributionMessage`, `protocolMessage`. They are skipped when choosing the reported type and, when nothing else remains, the message is not published. These are WhatsApp envelope field names — external protocol constants, not a deployment choice — so they are fixed rather than `Config`.

Text keeps its fast path, unchanged: `conversation` and `extendedTextMessage.text` are read before any key scan, so metadata siblings never affected it.

## Alternatives considered

**Leave classification alone and let each consumer filter.** This is what a consumer would reach for first, and it is the trap: the filter looks right against direct text, then eats real group media once `senderKeyDistributionMessage` decodes first. It also duplicates WhatsApp field names in every consumer, so each one has to be corrected when the list changes.

**Publish protocol frames and let consumers decide.** A frame no person authored is not a message. Publishing it would mean every routing rule, every unread count, and every log entry has to re-derive that, and `whatsapp/message-received` would stop meaning what its name says.

**Add the skipped field names to `Config`.** They are WhatsApp's own wire vocabulary, not a deployment-varying tunable; making them configurable would invite a deployment to re-break classification.

**Model metadata siblings in `WhatsAppContent`.** The seam's closed `text | unsupported` union answers "what did this person send". Delivery metadata answers a different question that no current consumer asks; adding it would widen a public union for nothing.

## Consequences

A consumer sees only messages a person sent, typed by their payload, and never needs to know a WhatsApp field name. Revocations and history-sync notifications are invisible above the seam — acceptable now, and the place to revisit if a consumer ever needs to reflect a deleted message.

The field list is a hand-maintained approximation of an undocumented, reverse-engineered protocol. It was derived from Baileys' own envelope handling and from a live pairing in which `protocolMessage` was the only sibling observed directly; a field WhatsApp adds later will surface as an `unsupported` media type with an unfamiliar name rather than as silence, which is the failure mode to prefer.
