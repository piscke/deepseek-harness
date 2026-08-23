# `@deepseek-ai/dsh-whatsapp-app`

English | [中文](README.zh.md)

The dsh WhatsApp-assistant bundle. [`cordis.patch.yml`](cordis.patch.yml) rides over [`dsh-web-app`](../web-app/README.md): it inserts the [capability seam](../../whatsapp/whatsapp/README.md), the [Baileys provider](../../whatsapp/whatsapp-baileys/README.md) with its credentials under the harness home, the [Workspace router](../../whatsapp/whatsapp-workspace/README.md) on its `category` route, the [four model-facing tools](../../whatsapp/tool-whatsapp/README.md), and the [Settings page that pairs the account](../../client/ui-settings-whatsapp/README.md). It adds no other UI: approval, the Workspace sidebar, and the Session view are surfaces the Web profile already ships. The bundle mounts no plugin of its own.

The `whatsapp` profile is this layer over the Web profile, and `dsh whatsapp` is its alias:

```sh
dsh plugin --profile whatsapp add baileys   # once
dsh whatsapp
```

## Install Baileys into the profile

Baileys is not a dependency of this repository and must not be added to one: it reaches `libsignal`, which is GPL-3.0 while this repository is MIT, and the `6.x` line resolves it from git, which pnpm rejects as a subdependency (`ERR_PNPM_EXOTIC_SUBDEP`) even through an optional peer. `dsh plugin --profile whatsapp add baileys` installs it into `$DSH_HOME/profiles/whatsapp/`, a project of its own, which is where that license and the account-ban risk are accepted. The `7.x` line the registry serves as `latest` installs there unchanged.

The patch resolves the install through `configModulePath('baileys')`, which reads the booted profile's own `node_modules` ([`dsh-app-boot`](../../boot/app-boot/README.md)). Precedence, highest first: `DSH_WHATSAPP_BAILEYS` for an operator naming an install explicitly, the profile's dependency, then the bare `baileys`, which resolves only from the harness installation itself.

Without a resolvable install the provider fails as `WHATSAPP_BAILEYS_MISSING` and stays down — no reconnection can install a package — while the rest of the harness boots and Settings › WhatsApp reports the state.

## Pair the account, once per process

The patch pins the credential directory to `$DSH_HOME/whatsapp/auth` and the routed conversations to `$DSH_HOME/whatsapp/chats`; both defaults are otherwise cwd- or `~`-relative, which would split a second account across two homes. Start the process, open **Settings › WhatsApp** in the browser on that machine, and scan the QR from the linked-device screen of the WhatsApp app. The page follows the connection state and replaces the code as it rotates.

That page answers the loopback browser only, and deliberately: whoever scans the code links a device with full access to the account, so the code is a credential and stays on the machine running the harness. A browser reaching the server from elsewhere on the network finds the page unable to read the status at all.

WhatsApp allows one connection per linked device, and a new connection *replaces* the old one. A second process on the same credential directory therefore kills the first with a `conflict` stream error, and both then fight over the account. Because both directories follow `DSH_HOME`, the rule to keep is: **one WhatsApp harness per `DSH_HOME`.** Run a second account from a second `DSH_HOME`, never from a second process against the same one; it is a second linked device and needs its own QR scan.

For the same reason, keep this layer in the `whatsapp` profile rather than in the home-level `$DSH_HOME/cordis.patch.yml`, which every profile inherits: any second profile carrying the provider opens its own connection to the same credentials and takes the account from the first.

## What the operator sees

The router creates two standing Sessions in the `WhatsApp` Workspace — `Groups` and `Contacts` — and queues each incoming message into the one matching its chat. A Session serves many conversations, so every routed turn names its chat, and so does the approval prompt for a send: check the destination before approving, because the Agent chooses it.

## Model Experience

Indirectly, through the inserted rows: the tool suite owns `whatsapp_list_chats`, `whatsapp_read_chat`, `whatsapp_mark_read`, and `whatsapp_send_message`, of which only sending asks for approval, and this bundle contributes no model-visible text of its own.

#### KV Cache effect

None directly; each inserted row's package owns its effect.

## Known Limitations and Deferred Work

- **Every routed message reaches the LLM provider and the Session log** — treat the process, its `DSH_HOME`, and its logs as being as sensitive as the phone the account lives on.
- **The chat index holds only what this connection observed** — it is discarded on restart and is not a roster, so an empty list means nothing has been observed yet. It is also not reliably empty at connect, because WhatsApp replays offline traffic during the handshake. `unreadCount` counts the same observations rather than WhatsApp's own unread state, and a group's display name is often absent until one of its messages arrives.
- **The Baileys binding is outside CI** — the provider's tests drive a socket double, and this bundle's tests parse the patch. The composed connection is confirmed by hand against a live account; use a dedicated test number, because the library is unofficial and WhatsApp may ban it or break the client at any time.
