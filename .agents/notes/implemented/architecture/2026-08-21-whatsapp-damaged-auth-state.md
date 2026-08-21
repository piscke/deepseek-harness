# Agent Note: A damaged WhatsApp credential file stops the connection

Status: implemented

English | [中文](2026-08-21-whatsapp-damaged-auth-state.zh.md)

## Problem

A paired account stopped resuming. The provider connected, reported `pairing`, and printed a QR, exactly as it does on a first run. The auth directory was intact except for one detail: `creds.json` was zero bytes.

Baileys' `useMultiFileAuthState` serializes writes with a per-path mutex, but the mutex is per process and the write itself is a plain `writeFile`, which truncates before it writes. A process killed mid-write, or two processes sharing one directory, leaves a truncated file. Its reader catches the parse failure and returns `null`, and the caller answers `null` with `initAuthCreds()` — a new identity.

So the failure presents as a fresh QR. An operator scans it, gets a working connection, and never learns that the previous device is now an orphan in the account's linked-devices list and that any session keys tied to the old identity are gone. The harness had no part in this beyond handing Baileys a directory, which is why nothing in the harness noticed.

## Decision

The provider reads `creds.json` before opening the socket and refuses to connect when it exists and does not parse, reporting `WHATSAPP_AUTH_STATE_DAMAGED` and naming the file. An absent file is a first run and connects normally, so pairing is untouched. The status becomes `logged-out` carrying that message rather than `offline`: the seam already defines `logged-out` as terminal for the current credentials with pairing as the remedy, which is exactly this situation, and `offline` would be indistinguishable from a dropped network the provider is about to retry.

This does not repair anything. It converts a silent, destructive outcome — pairing abandoned, presented as a routine QR — into a loud one an operator can act on, which is the repository's rule that a misconfiguration fails at the earliest resolvable point rather than being skipped.

## Alternatives considered

**Replace `useMultiFileAuthState` with an auth store that writes atomically.** The real fix: write a temporary file and rename it, so a torn write is impossible rather than merely reported. Rejected for now because it means owning the whole `AuthenticationState` surface — credential serialization, the Signal key store, and their `BufferJSON` encoding — against an unofficial protocol that changes, to replace a dependency that works when a single process owns the directory. The condition is rare enough, and now loud enough, that the trade favors detection.

**Take an advisory lock on `authDir` so a second process fails at startup.** This addresses the cause rather than the symptom, and it would also fix the documented "one process per `authDir`" limitation properly. Deferred rather than rejected: a lock needs stale-holder detection to avoid leaving an operator unable to start after a crash, and getting that wrong on every supported platform trades a rare silent loss for a common loud one.

**Recover by deleting the damaged file and re-pairing automatically.** This is what Baileys already does, and it is the behavior being fixed. Making it deliberate would not make it better: the operator still silently loses a linked device, and now the harness owns the decision to discard credentials it cannot read.

**Validate the credential contents, not just that they parse.** Tempting once a read is already there, but the field set belongs to Baileys and changes with it. Parsing is the property the harness can check without duplicating a schema it does not own, and a syntactically valid file with wrong fields fails loudly at connect anyway.

**Report `offline` and let the reconnection policy handle it.** This was the first implementation, and running it against the damaged directory showed why it is wrong: the provider reopened every few seconds forever, since nothing about a truncated file heals with time, and the operator saw a status indistinguishable from a network drop. The reason a retry cannot help is the same reason `logged-out` exists.

## Consequences

Recovery is manual: delete the directory and pair again. That is stated in the provider README beside the limitation, because a fail-closed error whose remedy is not written down just moves the confusion.

The provider now reads from disk before delegating to Baileys, so its tests cover a real temporary directory rather than only the socket double. The behavior is confirmed against the account whose credentials were damaged: one `connecting`, then `logged-out` carrying the path, and no further attempts. The two-process case remains unenforced and documented; this note is the reason a lock, when it arrives, belongs on the directory rather than around the write.
