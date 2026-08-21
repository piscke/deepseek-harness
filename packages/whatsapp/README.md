# whatsapp/ — WhatsApp capability family

English | [中文](README.zh.md)

This family connects the harness to one WhatsApp account so a session can read conversations and answer them under human approval.

| Package | Role | ctx key |
|---|---|---|
| [`whatsapp/`](whatsapp/README.md) | Defines connection status, conversations, messages, sending, and the provider slot | `ctx.whatsapp` |
| [`whatsapp-baileys/`](whatsapp-baileys/README.md) | Connects one account through the Baileys library | registers on `ctx.whatsapp` |

A WhatsApp account is one long-lived authenticated connection rather than a per-request credential, so the seam reports status as part of the capability and every operation fails while the account is not online.

Baileys is an unofficial reverse-engineered client and is **not a dependency of this repository**: its transitive `libsignal` is GPL-3.0 and resolves from a git repository, which the supply-chain policy rejects. A deployment installs it itself, and that install is what accepts Baileys' license and its account-ban risk. Use a dedicated number. The [runtime-specifier decision](../../.agents/notes/implemented/architecture/2026-08-21-baileys-runtime-specifier.md) records what that costs.

Everything a model reads from a conversation reaches the LLM provider and the session log. That is a deliberate privacy trade for personal messages, stated again in each package README.
