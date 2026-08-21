# Agent Note: the account id names the account, and absence is not a placeholder

Status: implemented

English | [中文](2026-08-21-whatsapp-account-identity.zh.md)

## Problem

`WhatsAppStatus`'s `online` arm carried `accountId: string`, filled from Baileys with `socket.user?.id ?? 'unknown'`. Both halves were wrong.

Baileys reports the address of the *linked device*, not the account: `554799229855:12@s.whatsapp.net`, where `:12` is the device index. Pairing the same account again yields a different id, so anything keying identity off it sees a new account after every relink. A live run surfaced the suffix.

The fallback was worse. `'unknown'` is not an account, and `sameStatus` compares `accountId` to decide whether a status changed — so two genuinely different accounts, both unnamed, compared equal and the second transition was suppressed as a duplicate. A hidden `?? default` inside the run path is also the exact pattern the repository forbids.

Nothing consumed the field yet: the Web panel that renders it is being written now, which is the cheapest moment to fix the value it will show.

## Decision

The device suffix is stripped, so `accountId` names the account and stays stable across relinks.

`accountId` becomes optional. A connection whose address the library does not report leaves the field absent, and a consumer states the absence rather than substituting anything. This is the rule the seam already applies to a conversation whose display name it has not resolved.

The seam documents the `pairing` payload as a credential in the same pass. It is a QR whose scanner links a device with full access to the account, so it outranks the message bodies a consumer is careful with, and a surface that displays or forwards it is choosing who can see it.

## Alternatives considered

**Strip the suffix in each consumer.** Every consumer would repeat the same parse, and the seam would keep documenting a device id as an account id. Classification of WhatsApp's address spaces belongs to the provider for the same reason chat kind does.

**Keep `accountId` required and drop the connection when the library reports no address.** The connection is fully usable — it sends, reads, and marks read — so failing it over a display field trades a working account for a cosmetic guarantee, and the reconnection budget would burn down against a condition no retry can change.

**Keep `'unknown'` but document it.** Documentation does not reach `sameStatus`, which would still treat two unnamed accounts as one unchanged status. The defect is that a placeholder compares equal, not that readers are uninformed.

## Consequences

A consumer must handle an absent `accountId`. That is one branch in a renderer, and it buys a field that never lies: present means an account, absent means the provider could not name one.

Status deduplication is now correct for unnamed connections, because absence does not collide the way a shared placeholder did.