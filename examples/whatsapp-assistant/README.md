# WhatsApp Assistant

English | [中文](README.zh.md)

This overlay opts one `dsh web` process into a WhatsApp assistant: the account is linked to the harness, incoming messages arrive as Sessions in a `WhatsApp` Workspace, and the Agent drafts replies that you approve before anything is sent.

```sh
DSH_WHATSAPP_BAILEYS=file:///abs/path/to/wa-deps/node_modules/baileys/lib/index.js \
  dsh web --patch examples/whatsapp-assistant/cordis.yml
```

It composes the capability seam, the Baileys provider, the Workspace router on its `category` route, and the four model-facing tools. Approval, the Workspace sidebar, and the Session view are the shipped Web surfaces; this overlay adds no UI.

## Install Baileys yourself

The library is not a dependency of this repository and must not be added to one. It reaches `libsignal`, which is GPL-3.0 and resolved from git, and this MIT repository's pnpm policy rejects git-resolved transitive dependencies (`ERR_PNPM_EXOTIC_SUBDEP`) — including through an optional peer, because peers still resolve at install time. Install it in a directory outside this workspace:

```sh
mkdir -p ~/wa-deps && cd ~/wa-deps
npm install baileys@^6.7.24
```

Then name that install in `DSH_WHATSAPP_BAILEYS`. The value is a module specifier passed to a dynamic `import()`, so use a `file:` URL rather than a filesystem path; a bare `baileys` works only when the specifier resolves from the harness itself. Without a resolvable install the provider fails as `WHATSAPP_BAILEYS_MISSING` and stays down: no reconnection can install a package.

## Pair the account, once per process

The overlay pins the credential directory to `$DSH_HOME/whatsapp/auth`. Start the process, open the Session log of any WhatsApp Session, and scan the QR from the linked-device screen of the WhatsApp app. The QR rotates until it is scanned.

WhatsApp allows one connection per linked device, and a new connection *replaces* the old one. A second process on the same credential directory therefore kills the first with a `conflict` stream error, and both then fight over the account. Because the directory follows `DSH_HOME`, the rule to keep is: **one `dsh web` per `DSH_HOME`.** Run a second account from a second `DSH_HOME`, never from a second process against the same one.

## What the operator sees

The router creates two standing Sessions in the `WhatsApp` Workspace — `Groups` and `Contacts` — and queues each incoming message into the one matching its chat. A Session serves many conversations, so every routed turn names its chat, and so does the approval prompt for a send: check the destination before approving, because the Agent chooses it.

The Agent reads and writes through `whatsapp_list_chats`, `whatsapp_read_chat`, `whatsapp_mark_read`, and `whatsapp_send_message`. Only sending asks for approval; reading does not.

## Limits worth knowing before you rely on it

- The chat index holds only what *this connection* observed. It is discarded on restart and is not a roster: an empty list means nothing has been observed yet. It is also not reliably empty at connect, because WhatsApp replays offline traffic during the handshake.
- `unreadCount` counts what this connection observed, not WhatsApp's own unread state.
- A group's display name is often absent until the connection observes one of its messages.
- Every routed message is sent to the configured LLM provider and written to the Session log. Treat the process, its `DSH_HOME`, and its logs as being as sensitive as the phone the account lives on.
