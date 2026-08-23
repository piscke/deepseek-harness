# @deepseek-ai/dsh-client-ui-settings-whatsapp

English | [中文](README.zh.md)

The **WhatsApp** page of Web Settings, and the Host channel that feeds it. Both halves live in one package because they share one wire vocabulary: the channel name, the endpoint name, and the decoder that reconstructs the [`whatsapp`](../../whatsapp/whatsapp/README.md) seam's `WhatsAppStatus` union from a JSON payload.

The Host half injects `connection` and `whatsapp` and registers `/whatsapp` with `authority: 'loopback'`; its single `status` endpoint returns `ctx.whatsapp.status()`, and any other endpoint is a `bad-request`. The loopback authority is the point of the package: a `pairing` status carries a credential — whoever scans the code links a device with full access to the account — so it reaches the browser on the machine running the harness and nowhere else. Forwarded Host events would broadcast it to every connected browser, and the Typert `/api` plane is registered once for trusted hosts, so neither can express this fence for one opt-in feature.

The browser half registers one localized `settings.section` contribution with id `whatsapp` at order 25, after Models and Plugins. It reads no status during plugin activation: the mounted page calls `status` and re-reads it every two seconds for as long as it stays open, because Baileys replaces the pairing code on the order of seconds and a stale code cannot be scanned. The page switches on the closed status union — offline, connecting, pairing (the QR, the rotation notice, and the warning that scanning links a device), online (the account id when the provider reported one), logged out (the provider's reason) — and ends in `assertNever`. Loading, failure, and retry stay local to the mounted component. Registration goes through `ctx.slots.inject()`, so it follows late section declaration, redeclaration, locale changes, and teardown without importing the Settings shell.

## Conversations card

Beside the connection state, the page edits which conversations the [WhatsApp Workspace](../../whatsapp/whatsapp-workspace/README.md) opens a session for: all of them, groups only, or contacts only. The choice writes to the Workspace's own settings namespace through `ctx.settingsScope`, on the ordinary settings plane rather than the loopback channel — a routing scope is not a credential.

The card renders only where the Workspace is composed: a namespace no Host serves reports as absent, and the card is not shown at all. It writes exactly the one field it renders, so the rest of that namespace — the allow and deny lists, the agent preset — stays as the deployment or another surface left it. A browser without write authority still sees the choice, disabled.

The namespace name is spelled here rather than imported, because a client package must not depend on a Host package; a test pins the constant against the Workspace's own export.

Composing the package is what creates the page, so its presence is the capability check: a harness without WhatsApp shows no WhatsApp page rather than an empty one. [`@deepseek-ai/dsh-whatsapp-app`](../../bundle/whatsapp-app/README.md) inserts the row.

## Model Experience

None, as this package only renders a Host-owned connection state in browser Settings and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Read-only connection state** — the page shows the account's state and pairs it. Unlinking, forcing a reconnect, and naming the account are a later change on the same surface.
- **The conversations card edits one field** — the allow and deny lists and the agent preset are part of the same namespace but have no control yet; a preset selector waits for presets worth choosing between.
- **Polling, not push** — the direct consequence of the loopback fence. Pushing the QR to a LAN browser would be a deliberate second decision about who may see a credential, not a transport refinement.
- **Pairing cannot be rehearsed in CI** — a real code needs an operator-installed Baileys and a phone. The fixture transport serves each status arm, so the page is proven without an account; the scan itself stays a manual step.
