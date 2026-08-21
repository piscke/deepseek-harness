# Agent Note: Load Baileys by runtime specifier instead of depending on it

Status: implemented

English | [中文](2026-08-21-baileys-runtime-specifier.zh.md)

## Problem

A WhatsApp provider needs Baileys, the only maintained client for a personal WhatsApp account. Baileys reaches `libsignal`, which is GPL-3.0 and, in the version line that avoids a native addon, resolves from a git URL. This repository is MIT and its pnpm policy rejects a git-resolved transitive dependency (`ERR_PNPM_EXOTIC_SUBDEP`). Declaring Baileys an optional peer does not avoid it: peers are resolved at install time, so the install fails for everyone in the workspace whether or not they want WhatsApp. Vendoring a GPL library into an MIT distribution is worse than the dependency.

Beyond licensing, an unofficial reverse-engineered client is a liability every workspace member would carry: it breaks whenever WhatsApp changes, and it can get the connected number banned. Nobody should inherit that by running `pnpm install`.

## Decision

`@deepseek-ai/dsh-whatsapp-baileys` names `baileys` in no manifest field. The deployment installs it and names it through the plugin's `moduleSpecifier` config (default `'baileys'`); `loadBaileys()` resolves it with a dynamic `import()` the first time the provider connects. The library's surface is declared as local structural interfaces in `src/socket.ts` — the one module that touches it — so the package typechecks and ships without the library present.

A missing library is a normal, named outcome: `WhatsAppError` with code `WHATSAPP_BAILEYS_MISSING` and an install instruction. The provider marks itself terminal and does not reconnect, because no retry can install a package. `ctx.whatsapp` then reports `offline` and every operation fails with `WHATSAPP_PROVIDER_UNAVAILABLE`.

Because the library is absent from the repository, tests pin the provider against the `WhatsAppSocket` port rather than against Baileys: the status machine, reconnection budget, message normalization, and conversation index are covered by a socket double. The binding was later exercised against a real account, which confirmed every operation the provider offers, and the package README says which coverage is automated and which is manual.

## Alternatives considered

**Declare `baileys` an optional peer dependency.** The intended shape, and the first thing tried. pnpm resolves peers during install, so `ERR_PNPM_EXOTIC_SUBDEP` fires for the whole workspace regardless of `peerDependenciesMeta.optional`. It also leaves a GPL-3.0 package in the lockfile of an MIT repository.

**Use `baileys@7`, whose `libsignal` comes from npm.** It removes the git resolution but adds `whatsapp-rust-bridge`, a native addon, to a repository whose CI runs a platform matrix — a prerelease native dependency traded for a licensing one, still with GPL reachability.

**Vendor Baileys under `vendor/`.** The vendoring procedure is for pinned source copies the repository is willing to own and relicense-check. A GPL-3.0 reverse-engineered client is exactly the source an MIT distribution must not carry, and the maintenance cost is the whole point of using the library.

**Put the provider in `packages/experimental/`.** Experimental placement changes release filtering, not installation: the dependency would still resolve for every workspace member. It also mislabels the seam, which is ordinary and complete.

**Talk to Baileys out of process** (a worker or sidecar the deployment starts). This isolates the license at a process boundary and remains available if in-process teardown proves unreliable, but it adds a protocol and a process lifecycle to a binding that a dynamic `import()` already keeps out of the manifest.

## Consequences

The repository stays MIT with no GPL package in its lockfile, and `pnpm install` costs nothing for members who never enable WhatsApp. The install is where a deployment accepts Baileys' license and its ban risk, which is where that decision belongs.

The cost is a typed hole. Baileys' surface is described by hand-written structural interfaces, so a library change breaks at runtime rather than at `tsc`, and no gate notices a renamed event or option. The hole is not theoretical: the hand-written `sendMessage` signature declared the quoted message as its key alone, which typechecked, passed a test asserting the quoted id, and crashed inside the library on the first real quoted reply, because Baileys reads the quoted message's own body. `WHATSAPP_BAILEYS_MISSING` and the README carry what the compiler cannot. The same absence is why the provider's first real pairing is its first real test.

This pattern generalizes to any peer a harness package cannot lawfully or safely install for everyone: keep it out of every manifest field, name it through validated config, load it dynamically, and fail loud with an install instruction — never silently degrade.
