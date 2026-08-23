# Agent Note: A logged-out WhatsApp connection discards its own credentials and pairs again

Status: implemented

English | [中文](2026-08-23-whatsapp-repairs-its-own-logout.zh.md)

## Problem

Unlinking the device from the phone is how a person ends a WhatsApp pairing, and it is the ordinary way this provider's credentials die. WhatsApp then closes the next connection with `DisconnectReason.loggedOut` (401), and Baileys keeps the rejected identity in `authDir`, so every later attempt logs in as a device the account no longer knows.

The provider answered that close by marking itself terminal: status `logged-out`, no reopen, `available()` false for the rest of the process. The credentials that caused it stayed on disk, so a reload reproduced the same 401. The only exit was for an operator to find `authDir`, delete it by hand, and restart — with nothing in the Web UI naming that directory. The settings section showed "Logged out … the account has to pair again" next to a QR that could never appear.

## Decision

A logged-out close is terminal for those credentials, not for the provider.

`BaileysProvider.handle()` reports `logged-out` carrying the close reason — an operator still sees why the connection ended — and then runs `repair()`: it calls `deps.forgetPairing()` and reopens through the ordinary reconnection budget. The next connection finds an unpaired directory, so Baileys emits a QR and the status machine walks `logged-out → connecting → pairing`, which is the state the account can act on.

`pairingForgetter(authDir)` is the discard, and it removes only the `.json` files `useMultiFileAuthState` writes, leaving the directory itself and anything else in it. An `authDir` an operator pointed at a shared directory must not lose unrelated content to a credential reset. A missing directory is already the state the discard asks for.

Routing the reopen through `retry()` rather than connecting directly is what bounds the loop: an account that somehow keeps rejecting a fresh pairing spends `maxReconnectAttempts` and stops with `WHATSAPP_RECONNECT_EXHAUSTED` instead of clearing credentials forever. A discard that fails — an unwritable `authDir` — is fatal with `WHATSAPP_PAIRING_NOT_DISCARDED`, because that is the one case where deleting the directory by hand really is the remedy.

## Damaged credentials stay terminal

`WHATSAPP_AUTH_STATE_DAMAGED` keeps the old behavior. A truncated `creds.json` is ambiguous: the pairing behind it may still be live in the account's linked-devices list, and discarding it would abandon a working link and orphan that entry. Only WhatsApp's own 401 is proof that the stored identity is dead, and only that proof authorizes deleting it.

## Alternatives considered

**Leave recovery manual and document `authDir`.** The smallest change, and it keeps every credential deletion an operator's act. Rejected because the state it preserves has no use: the provider cannot connect, cannot pair, and cannot report anything an operator can act on from the surface that shows it. Documentation would only describe a dead end more precisely.

**Add a "reset pairing" RPC endpoint and a button in the settings section.** An explicit act, visible where the failure is displayed. Rejected as the primary fix because it makes a person confirm the one conclusion WhatsApp has already stated; the click has no information the 401 lacks. It remains reasonable as a way to unlink deliberately while `online`, which is a different capability and is not built here.

**Delete `authDir` recursively.** Simpler than filtering, and it matches what the README told operators to do. Rejected because `authDir` is operator-configured: a value pointing at a directory holding anything besides auth state would take that content with it, and the failure would be silent and unrecoverable.

**Make the behavior a `Config` flag.** Rejected because there is no deployment for which keeping dead credentials is the better outcome — the alternative to pairing again is not connecting at all.

## Consequences

The seam's `logged-out` state changes meaning: it is still unrecoverable for the credentials it reports, but it is no longer the end of a provider's life. `WhatsAppStatus`, the subsystem doc, and the settings-section copy say so, and `available()` now stays true across a logout.

A logged-out close deletes credentials without asking. That is new destructive behavior on an automatic path, bounded by the two facts above: only a 401 triggers it, and only auth-state files are removed.

## Testing

The provider tests drive the whole path over the socket double — discard, reopen, and the QR that follows — plus the fatal discard failure and a disposal that lands mid-discard. The socket tests exercise `pairingForgetter` against a real temporary directory, including the non-auth file it must keep and the absent directory it must tolerate. The Baileys binding itself remains outside CI, so the real 401 close is confirmed only by hand.
