# Agent Note: The WhatsApp pairing QR lives in Settings, on its own loopback channel

Status: implemented

English | [中文](2026-08-24-whatsapp-pairing-in-settings.zh.md)

## Problem

The WhatsApp seam has reported `{ state: 'pairing', qr }` since it shipped, and re-emits it on every rotation, but nothing in the browser rendered it. Pairing an account therefore happened outside the product: an operator read the payload from the session log, or a scratch page on a URL of its own drew the code. The capability's one human step had no home, while every other harness-level setting lives in one panel.

The reason it had no home is not layout. A `pairing` payload is a credential: whoever scans it links a device with full access to the account, including its history. So the question "where does the QR go" is really "which browsers may see it", and the two shared paths that already carry host state to the browser both answer that question wrongly for this payload.

## Decision

[`@deepseek-ai/dsh-client-ui-settings-whatsapp`](../../../../packages/client/ui-settings-whatsapp/README.md) contributes a **WhatsApp** page to Web Settings (`settings.section`, id `whatsapp`, order 25) that renders the connection state and, while the account is pairing, the live code. [`examples/whatsapp-assistant`](../../../../examples/whatsapp-assistant/README.md) inserts its row, so the page exists exactly where WhatsApp was composed; presence of the page is the capability check, and no plugin-inventory probe is needed to decide whether to draw it.

The package registers its own Connection RPC channel rather than joining a shared plane:

```ts ignore-check
ctx.connection.rpc.handle('/whatsapp', handler, { authority: 'loopback' })
```

`authority: 'loopback'` pins the route to an empty trusted-host list, which is the fence the rest of the configuration plane already uses — declared here by the feature that owns the secret instead of by a central list edited on its behalf. The channel has one parameterless endpoint, `status`, returning the seam's `WhatsAppStatus`; any other endpoint is a `bad-request`. The browser decodes the payload arm by arm and treats an unreadable one as a failed read, because a channel answer is a wire boundary even when both ends ship together.

The page polls `status` every two seconds while it is open, and not at all while it is closed. Polling is the direct consequence of the fence, not a shortcut: pushing would mean a host event, and host events reach every connected browser.

**Both halves live in one package.** They share one wire vocabulary — the channel name, the endpoint name, and the status decoder — and splitting them would put that vocabulary in a third package or duplicate it, for the sole benefit of matching the `packages/host/*` + `packages/client/ui-*` naming of the directory-picker pair. `packages/client/connection` and `packages/api/gateway` already carry both halves for the same reason. The cost is a compiler-face split inside the package (`tsconfig.host.json` + `tsconfig.client.json` under a `files: []` aggregate): the Host half pulls in the `ctx.connection` Context merge, which makes the browser half's `ctx.get('connection') as ConnectionHandle` cast illegal if both compile in one program. The root Host aggregate references this package explicitly, since it otherwise excludes `packages/client/*/src`.

## Alternatives considered

**Add `whatsapp/status` to the forwarded-event allowlist.** This is the shortest path — the seam already emits the event, and the browser already receives forwarded host events. Rejected because forwarded events are broadcast to every connected browser with no origin fence: a `dsh web` reachable on a LAN would hand the pairing code to anyone who opened it. The allowlist is also a shared security list, so an opt-in feature would be widening it for everyone.

**Expose `status` as a Typert remote method.** Rejected on the same fence. The Typert gateway registers a single `/api` interceptor with `authority: 'trusted-host'`, so per-method loopback means either extending the gateway or adding the method name to `PRIVILEGED_METHODS` in `dsh-client-connection` — again a shared list edited on behalf of one optional feature. `packages/api/remotes` also mounts a fixed remote list that an overlay cannot extend.

**Keep the QR on its own page and just link to it from Settings.** Rejected: the separate URL is the complaint. A second surface needs its own authority decision, its own localization, and its own lifecycle, and the operator still has to leave the panel where they configured everything else.

**Render the QR in the Session log instead.** Rejected: the session log is a transcript of a conversation, and the pairing code is neither model-visible nor conversational. Putting a rotating credential in a durable log also contradicts the seam's own privacy stance.

**Ship the page in the default Web bundle and hide it when the seam is absent.** Rejected: it would put a WhatsApp entry in every harness's Settings navigation and require a runtime capability probe to decide visibility. Composition already answers the question exactly.

**Make the poll interval a `Config` field.** Rejected: the read returns a process-local field over loopback, and the only bound that matters is how fast a rotated code must replace the one a human is pointing a phone at. That is a UI cadence, not a deployment choice.

## Testing

Package tests cover both halves per-file: the Host half's endpoint dispatch and its `bad-request` for anything else, and the browser half's registration (inject list, id, order, localized label, locale switch, late slot declaration, teardown), the reader's success/error/undecodable paths, every status arm of the page, the poll cadence, cancellation on unmount, and the retry after a failed read.

`packages/client/connection`'s fixture transport now serves `/whatsapp`, selected by `?fixtureWhatsApp=pairing|online|offline|connecting|logged-out`, so the assembled Web harness can drive each arm without an account. `apps/cli/tests/whatsapp-assistant-config.spec.ts` pins the overlay's fifth row.

`apps/web/tests/whatsapp-settings.snapshot.ts` boots the built browser graph with the overlay applied, opens Settings, selects WhatsApp, and pins the pairing card with its rendered `<svg>` code and credential warning, the connected account, and the absence of any WhatsApp page when the overlay is not applied. Reaching that required the jsdom boot harness (`apps/web/tests/assembled-boot.ts`) to compose the same `--patch` layers `dsh web` accepts instead of only the shipped bundles; without it no opt-in row can appear in an assembled transcript.

Real pairing cannot be rehearsed anywhere in CI: it needs an operator-installed Baileys and a phone. The fixture is what proves the page; the scan itself stays a manual operator step, as it was before this change.

## Consequences

The capability's one human step is now part of the product, and the answer to "who may see the code" is written where the code is produced instead of in a shared allowlist. An operator on a remote browser sees the page fail to read status — deliberately, and the example README says so.

The QR is unavailable to a remote browser, and no amount of configuration changes that today. If a deployment ever needs remote pairing, that is a separate decision about disclosing a credential over the network, and it would use the forwarded-event path rather than a widened fence here.

`qrcode.react` joins the dependency set (ISC, no runtime dependencies beyond React) rather than a hand-rolled encoder, per the dependencies-over-hand-rolling policy: a QR encoder is a specification, not product logic.
