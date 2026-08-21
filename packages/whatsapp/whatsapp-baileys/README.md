# @deepseek-ai/dsh-whatsapp-baileys

English | [中文](README.zh.md)

A `WhatsAppProvider` for the harness [WhatsApp capability seam](../whatsapp/README.md) (`ctx.whatsapp`), backed by one [Baileys](https://github.com/WhiskeySockets/Baileys) connection to a personal WhatsApp account.

This is an **implementation** package: it registers a provider into `ctx.whatsapp`, it does not own the key and it registers no model-facing tool. It is a function/namespace plugin (`inject: ['whatsapp']`).

## Baileys is not a dependency

`baileys` appears in no field of this package's manifest, and installing this package installs nothing from it. Baileys reaches `libsignal`, which is GPL-3.0 and resolves from a git repository; this repository is MIT and its pnpm policy rejects a git-resolved transitive dependency outright (`ERR_PNPM_EXOTIC_SUBDEP`), including through an optional peer, because peers are still resolved at install time.

A deployment installs Baileys itself and names it through `moduleSpecifier`; this package loads it with a dynamic `import()` the first time it connects. That install is where Baileys' license and its account-ban risk are accepted.

```sh
pnpm add baileys   # in the deployment, not in this repository
```

Without it, connecting fails with `WHATSAPP_BAILEYS_MISSING`, the provider marks itself terminal, and no reconnection is attempted — no retry can install a package. `ctx.whatsapp` then reports `offline` and every operation fails with `WHATSAPP_PROVIDER_UNAVAILABLE`.

Because Baileys is absent from the repository, everything here is pinned against the `WhatsAppSocket` port instead: the status machine, the reconnection policy, the message normalization, and the conversation index are covered by tests over a socket double. The binding to the real library is exercised only by hand, and a live account has now confirmed every operation this package offers — connect, QR, `online`, inbound messages, credential-reusing reconnect, `send`, quoting, `fetchMessages` with `before`, and `markRead`.

## Connection

The provider owns one connection's lifecycle. It opens eagerly when the plugin loads and reports progress through `status()` and `whatsapp/status`: `connecting`, then `pairing` carrying the QR payload a human scans, then `online` with the account id. An unexpected close reopens after `reconnectDelay` until `maxReconnectAttempts` consecutive attempts are spent, after which the provider stops and reports `WHATSAPP_RECONNECT_EXHAUSTED`. A logged-out close is terminal: the credentials are dead, so it becomes `logged-out` without retrying.

Teardown is LIFO — the connection closes before the registration is withdrawn, so nothing dispatches onto a closing socket.

Auth state is a mutable multi-file directory (`authDir`), not a credential reference. It is what lets a paired account resume without a new QR scan; it grants full access to the account and must stay out of git.

Baileys rewrites `creds.json` in place on every credential update, so a process killed mid-write, or two processes sharing one directory, leaves a truncated file — which Baileys itself reads as "no credentials" and answers by registering a new device, silently abandoning the pairing and orphaning its entry in the account's linked-devices list. The provider therefore refuses to connect over a credential file it cannot parse, reporting `WHATSAPP_AUTH_STATE_DAMAGED` and naming the file, so the loss is visible rather than presented as a fresh QR. The status becomes `logged-out` carrying that message, because the remedy is the one `logged-out` already means: pair again. Reopening is not attempted; it could resolve the damage only by discarding the pairing. Recovery is manual — delete the directory and pair again.

## Conversations

Baileys ships no message store, so `listChats` and `fetchMessages` answer from what **this connection observed since it loaded**: a restart discards the index, which then grows as messages arrive. It is not reliably empty at connect, because WhatsApp replays offline traffic during the handshake. `listChats` orders by newest observed message; `fetchMessages` returns newest-first and pages with `before`. A chat this connection never observed fails with `WHATSAPP_UNKNOWN_CHAT` rather than returning an empty page, because an empty page and an unknown address are different answers. Per-chat retention is capped by `historyPerChat`, evicting oldest-first.

A message is discarded unless it carries an id, a chat address, and content a person authored. `messageContextInfo` and `senderKeyDistributionMessage` describe the delivery rather than the content, and `protocolMessage` is housekeeping such as a revocation or a history-sync notification; an envelope holding only those is dropped, and when they accompany real content they are skipped so the reported type names the payload rather than whichever field decoded first. Media the seam cannot represent becomes `unsupported` with its media type, so a consumer still sees that something arrived.

## Config

| Key | Default | Meaning |
|---|---|---|
| `moduleSpecifier` | `baileys` | Module specifier of the Baileys library the deployment installed. |
| `authDir` | `.dsh/whatsapp/auth` | Directory holding the multi-file auth state that resumes a paired account. |
| `deviceName` | `DeepSeek Harness` | Name shown in WhatsApp's linked-devices list. |
| `reconnectDelay` | `5000` | Milliseconds before reopening a connection that closed unexpectedly. |
| `maxReconnectAttempts` | `5` | Consecutive reopen attempts before giving up until the plugin is reloaded. |
| `historyPerChat` | `200` | Messages retained per conversation for `fetchMessages`. |

`reconnectDelay` and `historyPerChat` must be positive finite numbers and `maxReconnectAttempts` a non-negative integer (`0` legitimately means "never reconnect"); an invalid value throws at plugin construction rather than producing a provider that silently never reconnects.

## Model Experience

Indirectly, through whichever consumer puts these conversations in front of a model; this package registers no tool, prompt, or schema, and such a consumer sends personal messages to the LLM provider and writes them to the session log.

#### KV Cache effect

No direct invalidation; the consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **The Baileys binding is outside CI** — every automated test drives a socket double, and a live account has confirmed every operation by hand. The library is unofficial and reverse-engineered, so WhatsApp may ban the number or break the client at any time; use a dedicated test number.
- **One process per `authDir`** — WhatsApp replaces an existing linked-device session, so a second process opening the same credentials closes the first with a `conflict` stream error, and the two unsynchronized credential writers can leave the file truncated and the pairing lost. Nothing enforces exclusivity; an advisory lock on the directory is deferred work. Give each connection its own directory.
- **`listChats` reports only what this connection observed** — the index is built from observed events, never from a roster fetch, so it holds no conversation the process has not seen. It is not reliably empty at connect: WhatsApp replays offline traffic during the handshake, and a paired account has been seen reporting conversations on the first call. A consumer must assume neither an empty index nor a complete one, and keeps its own roster if it needs durability.
- **A chat id is opaque, and not always a phone number** — WhatsApp addresses direct conversations through more than one domain; a live account has been observed reporting a named conversation as `<id>@lid`, its linked-identity address space, and `@newsletter` and `@broadcast` exist as well. This provider treats `@g.us` as the group domain and every other domain as direct, so a new address space degrades to a usable classification instead of an error. A consumer must treat `WhatsAppChatId` as opaque: parsing it against a closed set of suffixes rejects addresses this provider legitimately reports.
- **A message that fails to decrypt is lost silently** — Baileys reports `Bad MAC` or `No matching sessions found for message` for frames it cannot decrypt, typically from a device whose Signal session this connection lacks. Such a frame never becomes a `whatsapp/message-received`, and the seam has no event for the loss, so a consumer counting messages sees a gap it cannot detect.
- **History is per-process** — a restart loses the conversation index, and reconnection history replay repeats message ids a consumer already saw. A consumer that must act once keeps its own processed-id set.
- **Group names are absent until observed** — a conversation's display name is derived from `pushName` on an inbound direct message, so a group's subject stays unresolved until the connection observes one.
- **Text only, no presence** — sending media, downloading media, typing indicators, and delivery receipts are deferred work.
- **`unreadCount` counts what this connection observed**, not WhatsApp's own unread state, and `markRead` clears it on the account rather than in this index.
