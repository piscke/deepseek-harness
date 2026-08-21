# Agent Note: A runnable WhatsApp assistant example

Status: implemented

English | [中文](2026-08-23-whatsapp-assistant-example.zh.md)

## Problem

The WhatsApp capability seam, its Baileys provider, the Workspace router, and the model-facing tool suite each shipped with their own tests, but nothing composed them. The only way to drive a real account was a throwaway script, so the feature had no operator-facing form and no assembled evidence that the four packages work as one assistant.

Two constraints make that composition unusual. `baileys` cannot be a dependency of this repository at all: it reaches `libsignal`, which is GPL-3.0 and resolved from git, and this MIT repository's pnpm policy rejects git-resolved transitive dependencies (`ERR_PNPM_EXOTIC_SUBDEP`) — including through an optional peer, because peers still resolve at install time. And WhatsApp allows one connection per linked device, replacing the old one, so two processes sharing a credential directory close each other with a `conflict` stream error.

## Decision

[`examples/whatsapp-assistant`](../../../../examples/whatsapp-assistant/README.md) is a patch overlay over the shipped `web` profile, following `examples/web-schedule`. It inserts four rows — the seam, the Baileys provider, the Workspace router on its `category` route, and the tool suite — and adds no UI: approval, the Workspace sidebar, and the Session view are surfaces the Web profile already ships. The default Web tree is unchanged.

The overlay makes two decisions the provider's own defaults leave open.

`authDir` is pinned to `dshHomePath('whatsapp', 'auth')` instead of the provider's cwd-relative default. The one-connection rule is a property of the credential directory, and a cwd-relative default makes collisions depend on where the operator happened to start `dsh`. Anchored to the harness home, the rule an operator has to keep becomes "one `dsh web` per `DSH_HOME`", which is checkable without knowing anything about linked devices.

`moduleSpecifier` reads `DSH_WHATSAPP_BAILEYS`, defaulting to the bare `baileys`. The operator installs the library outside this workspace, so the composition has to accept an absolute location; the value is passed to a dynamic `import()`, which is why the README specifies a `file:` URL rather than a filesystem path. A library that does not resolve is the named outcome `WHATSAPP_BAILEYS_MISSING` ([runtime specifier](../architecture/2026-08-21-baileys-runtime-specifier.md)).

The tool suite is a host-plane row rather than an agent-preset row. The Web profile moved model-facing tools behind presets, and a scoped tool registration shadows a global one rather than hiding it, so one global row reaches whichever preset each session composes — including presets the operator adds later.

## Alternatives considered

**Ship the composition as a bundle or a profile default.** Rejected: the assistant links a personal account, sends every routed message to the configured LLM provider, and writes it to the Session log. That is an explicit opt-in, and an overlay is the form this repository already uses for one.

**Declare `baileys` as an optional peer dependency so the manifest documents it.** Rejected: pnpm resolves peers at install time, so the git-resolved GPL-3.0 subdependency arrives anyway and installation fails for everyone. Absence is handled at runtime instead, and a test now asserts that no manifest in the repository declares it.

**Verify the overlay by booting it in a composition test.** The Workspace router opens its standing sessions during `apply`, so a boot needs a real agent factory, which needs a model. Specifier resolution is already proven by `verify-cordis-config`, and routing behavior by the router's own service-level tests, so the added test pins what neither covers: the overlay's operator contracts and the license constraint.

## Verification

`apps/cli/tests/whatsapp-assistant-config.spec.ts` parses the checked-in overlay and pins the composed rows, the `category` route, the pinned `authDir`, the environment-named module specifier, and the absence of credential material. It also walks every `package.json` in the repository and fails if any dependency field declares `baileys`, which turns the license constraint into an executed gate rather than a review convention.

`pnpm run verify-cordis-config` resolves all four bare package specifiers from `apps/cli`, which is why they were added to that manifest and why the overlay joins `appOverlayFiles`.

## Consequences

An operator with a paired phone has a usable assistant today, and the packages below now have an assembled form to demonstrate. The overlay is also the composition the Web panel extends: the panel's rows are inserted into this same file rather than into the shipped bundle.

Installing Baileys stays the operator's step and will keep confusing people who expect `pnpm install` to be enough. The README states the license reason at the point of failure, and `WHATSAPP_BAILEYS_MISSING` names it again at runtime.
