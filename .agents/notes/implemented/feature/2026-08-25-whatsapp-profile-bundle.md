# Agent Note: WhatsApp as a first-class profile

Status: implemented

English | [中文](2026-08-25-whatsapp-profile-bundle.zh.md)

## Problem

Starting the assistant took three coordinated decisions on every boot: install Baileys somewhere outside the workspace, name that location in `DSH_WHATSAPP_BAILEYS`, and pass `--patch examples/whatsapp-assistant/cordis.yml` to `dsh web`. That is the shape of a demo. An installation whose purpose *is* the WhatsApp assistant repeats all three forever, and any of them can be forgotten or mistyped into a harness that boots without the capability.

The [example overlay](../../archived/feature/2026-08-23-whatsapp-assistant-example.md) chose that form deliberately, rejecting a bundle because linking a personal account must stay an explicit opt-in. The opt-in argument holds; the conclusion does not follow from it. An overlay charges the opt-in per invocation instead of once, and it leaves the library's location outside the composition entirely, where nothing can resolve it.

## Decision

The composition is a bundle, the installation is a profile, and the library is a dependency of that profile:

```sh
dsh plugin --profile whatsapp add baileys   # once
dsh whatsapp                                # always
```

[`@deepseek-ai/dsh-whatsapp-app`](../../../../packages/bundle/whatsapp-app/README.md) is a patch-only bundle over `dsh-web-app` carrying the five rows the overlay carried, with the same `dshHomePath` anchors for `authDir` and the router's `directory`, and the same host-plane tool row. `PROFILE_TEMPLATES.whatsapp` names `base`, `web-app`, and it, so the profile initializes itself on first use; `dsh whatsapp` is an alias for `dsh --profile whatsapp`, sharing every flag and rejection with `dsh web` through one `addProfileAlias` registration.

The opt-in did not weaken, it moved: from repeating two flags and an environment variable to choosing a profile. The bundle mounts nothing on its own, `dsh web` and the default tree are unchanged, and only a profile that lists the bundle composes it.

### Resolving the operator's install

`dsh plugin --profile whatsapp add baileys` installs into `$DSH_HOME/profiles/whatsapp/`, a pnpm project of its own. The repository's manifests stay free of `baileys` — the test that walks every `package.json` still enforces it — so the git-resolved GPL-3.0 subdependency never enters `pnpm install` here, and the license and account-ban risk are accepted where the operator accepts them.

Resolution is the part an out-of-tree install leaves open: the provider's `import()` runs from the dsh installation and never sees the profile's `node_modules`. `boot()` therefore provides a second helper to `!!js` expressions alongside `dshHomePath`. `configModulePath(specifier)` resolves from the **root config's directory** — the profile directory in a profile boot — with `createRequire`, and returns a `file:` URL (`pathToFileURL`, because a Windows path is not a valid import specifier) or `undefined` when the package is not installed. It is named for the config rather than the profile because `boot()` knows nothing about profiles; the config's directory is the real anchor.

The patch reads `!!js process.env.DSH_WHATSAPP_BAILEYS ?? configModulePath('baileys') ?? 'baileys'` — an operator naming an install explicitly, then the profile's dependency, then the bare name, which resolves only from the harness installation itself and otherwise leaves the provider reporting `WHATSAPP_BAILEYS_MISSING` ([runtime specifier](../architecture/2026-08-21-baileys-runtime-specifier.md)) while the rest of the harness boots. That outcome now names both remedies, since a message that only says the library is missing cannot be acted on.

New profiles write `strictDepBuilds: false` into their `pnpm-workspace.yaml`. pnpm exits non-zero on ignored build scripts, `dsh plugin add` reconciles only on exit 0, and Baileys has ignored builds — without it a successful install reports failure and no plugin is recorded. A profile's dependencies are the operator's to trust, and `dsh plugin add` already prints what it ran.

## Alternatives considered

**Keep the example overlay and add only the resolver.** Rejected: it fixes one of the three decisions and leaves `dsh web --patch <path>` as the way to run the product. The profile is what this repository already means by "this is how this installation is composed", and it is the only one of the three that a template can supply.

**Install Baileys during boot when it is missing.** Rejected: a harness that runs a package manager against the network on start is unpredictable and slow at the worst moment, and it would accept a GPL-3.0 dependency and the ban risk of an unofficial client on the operator's behalf. Installation stays a command the operator types.

**Keep naming the library only through `DSH_WHATSAPP_BAILEYS`.** Rejected as the only mechanism, kept as the highest-precedence one: an environment variable is per-shell state that must survive every launcher, service manager, and reboot, which is exactly the durability a profile already has. It remains the override for an install the profile does not own.

**Ship the bundle out-of-box but leave it out of the CLI's dependency closure, installed by the profile like any other plugin.** Rejected: `dsh whatsapp` would then need an install before it works at all, and `PROFILE_TEMPLATES` could not name it. The cost is that every dsh installation carries the WhatsApp packages in its closure whether or not it composes them, which is what buys the single command.

**Put the rows in the home-level `$DSH_HOME/cordis.patch.yml`.** Rejected: every profile inherits that file, so a second profile opens a second connection to the same credentials and takes the account from the first — the one-connection rule turned into a trap. The layer belongs to the one profile that wants it.

## Verification

`packages/bundle/whatsapp-app/tests/whatsapp-app.spec.ts` parses the checked-in patch and pins the manifest wiring, the five rows and their order, the `category` route, the `dshHomePath` anchors, the specifier expression, and the absence of credential material; it inherits the repository-wide check that no manifest declares `baileys`. `app-boot`'s tests cover both arms of `configModulePath` and the `whatsapp` template with its `strictDepBuilds` field, `apps/cli/tests/args.spec.ts` pins the alias against the same flag surface as `web`, and `verify-cordis-config` resolves the five specifiers from the bundle's own dependencies.

## Consequences

An operator runs one command, and the composition has one home: the bundle README replaced `examples/whatsapp-assistant/`, which is gone.

Two facts did not change and are stated at the bundle instead. WhatsApp still allows one connection per linked device, so the rule remains **one WhatsApp harness per `DSH_HOME`**, and every routed message still reaches the LLM provider and the Session log.

The composed connection remains outside CI: the bundle's tests parse a file, the provider's drive a socket double, and only a live account exercises the two together.
