# WhatsApp Assistant

English | [中文](README.zh.md)

This overlay opts one `dsh web` process into a WhatsApp assistant: the account is linked to the harness, incoming messages arrive as Sessions in a `WhatsApp` Workspace, and the Agent drafts replies that you approve before anything is sent.

```sh
DSH_WHATSAPP_BAILEYS=file:///abs/path/to/wa-deps/node_modules/baileys/lib/index.js \
  dsh web --patch examples/whatsapp-assistant/cordis.yml
```

It composes the capability seam, the Baileys provider, the Workspace router on its `category` route, the four model-facing tools, and the Settings page that pairs the account. Approval, the Workspace sidebar, and the Session view are the shipped Web surfaces.

## Install Baileys yourself

The library is not a dependency of this repository and must not be added to one. It reaches `libsignal`, which is GPL-3.0 and resolved from git, and this MIT repository's pnpm policy rejects git-resolved transitive dependencies (`ERR_PNPM_EXOTIC_SUBDEP`) — including through an optional peer, because peers still resolve at install time. Install it in a directory outside this workspace:

```sh
mkdir -p ~/wa-deps && cd ~/wa-deps
npm install baileys@^6.7.24
```

Then name that install in `DSH_WHATSAPP_BAILEYS`. The value is a module specifier passed to a dynamic `import()`, so use a `file:` URL rather than a filesystem path; a bare `baileys` works only when the specifier resolves from the harness itself. Without a resolvable install the provider fails as `WHATSAPP_BAILEYS_MISSING` and stays down: no reconnection can install a package.

## Boot it from a profile instead of a flag

Naming the library and the overlay on every command is one way to run this; a [user profile](../../packages/boot/app-boot/README.md#profiles) is the other. Copy this overlay's entries into `$DSH_HOME/profiles/<name>/cordis.patch.yml`, set `moduleSpecifier` there to your own install, and `dsh --profile <name>` composes the same tree from any directory with nothing to export first.

Keep those entries in that profile rather than in the home-level `$DSH_HOME/cordis.patch.yml`, which every profile inherits: any second profile carrying the provider opens its own connection to the same credential directory and takes the account from the first, exactly as a second process does.

## Pair the account, once per process

The overlay pins the credential directory to `$DSH_HOME/whatsapp/auth` and the routed conversations to `$DSH_HOME/whatsapp/chats`. Start the process, open **Settings › WhatsApp** in the browser on that machine, and scan the QR it shows from the linked-device screen of the WhatsApp app. The page follows the connection state and replaces the code as it rotates, until it is scanned.

That page answers the loopback browser only, and deliberately: whoever scans the code links a device with full access to the account, so the code is a credential and stays on the machine running the harness. A browser reaching `dsh web` from elsewhere on the network finds the page unable to read the status at all.

WhatsApp allows one connection per linked device, and a new connection *replaces* the old one. A second process on the same credential directory therefore kills the first with a `conflict` stream error, and both then fight over the account. Because both directories follow `DSH_HOME`, the rule to keep is: **one `dsh web` per `DSH_HOME`.** Run a second account from a second `DSH_HOME`, never from a second process against the same one. A second account is a second linked device, so it needs its own QR scan rather than a copy of the first one's credentials.

## What the operator sees

The router creates two standing Sessions in the `WhatsApp` Workspace — `Groups` and `Contacts` — and queues each incoming message into the one matching its chat. A Session serves many conversations, so every routed turn names its chat, and so does the approval prompt for a send: check the destination before approving, because the Agent chooses it.

The Agent reads and writes through `whatsapp_list_chats`, `whatsapp_read_chat`, `whatsapp_mark_read`, and `whatsapp_send_message`. Only sending asks for approval; reading does not.

## Limits worth knowing before you rely on it

- The chat index holds only what *this connection* observed. It is discarded on restart and is not a roster: an empty list means nothing has been observed yet. It is also not reliably empty at connect, because WhatsApp replays offline traffic during the handshake.
- `unreadCount` counts what this connection observed, not WhatsApp's own unread state.
- A group's display name is often absent until the connection observes one of its messages.
- Every routed message is sent to the configured LLM provider and written to the Session log. Treat the process, its `DSH_HOME`, and its logs as being as sensitive as the phone the account lives on.
