# WhatsApp

English | [中文](whatsapp.zh.md)

The WhatsApp seam — a [capability seam](../glossary.md#capability-seam) over **one authenticated personal WhatsApp account**, split across packages: Service Definition ([dsh-whatsapp](../../packages/whatsapp/whatsapp), `ctx.whatsapp` + the single provider slot), Service Provider ([dsh-whatsapp-baileys](../../packages/whatsapp/whatsapp-baileys), one Baileys connection), and two Consumers — [dsh-whatsapp-workspace](../../packages/whatsapp/whatsapp-workspace), which turns the inbound stream into sessions, and [dsh-tool-whatsapp](../../packages/whatsapp/tool-whatsapp), which gives the model names for the account. WhatsApp is an optional capability, not part of the agent-loop spine.

Source: [`packages/whatsapp/whatsapp/src/types.ts`](../../packages/whatsapp/whatsapp/src/types.ts)

## One account, one connection

A WhatsApp account is not a per-request credential: it is a long-lived authenticated connection that a human authorizes once by scanning a QR code, and that WhatsApp can revoke at any time. So `ctx.whatsapp` reports `status()` as part of the capability rather than as a call result, and the provider slot holds exactly one registration — a second one fails with `WHATSAPP_PROVIDER_ALREADY_REGISTERED` instead of choosing between accounts. Running two accounts means two isolated fibers.

`WhatsAppStatus` is a closed union of `offline`, `connecting`, `pairing` (carrying the QR payload a human scans, re-emitted whenever the provider rotates it), `online` (carrying the account id), and `logged-out` (terminal for the current credentials — the account must pair again, and no reconnection can recover it). Every operation except `status()` and `register()` requires `online`: no provider registered fails with `WHATSAPP_PROVIDER_UNAVAILABLE`, any other state with `WHATSAPP_NOT_ONLINE`.

## What a message is

`WhatsAppMessage` carries a branded `WhatsAppMessageId`, its `WhatsAppChatId`, whether the conversation is `direct` or `group`, the author, whether the connected account wrote it (`fromMe`, including from another device), an RFC 3339 UTC timestamp, and a `WhatsAppContent` body. Content is a closed union of `text` and `unsupported` — a provider reports media it cannot represent with its media type rather than dropping the message, so a consumer still sees that something arrived and can answer accordingly.

Chat kind is the routing discriminator, and the provider owns it: it classifies every conversation it reports, and a consumer reads `kind` rather than re-deriving it from the address. WhatsApp addresses conversations through several domains and adds more over time, so a provider classifies an unfamiliar domain as `direct` rather than failing — a fail-closed provider goes dark the moment WhatsApp rolls out a new address space, and a consumer that parses the address instead rejects ids the provider legitimately reports.

`whatsapp/message-received` means a person sent something. A frame nobody authored — delivery metadata, or protocol housekeeping such as a revocation or a history-sync notification — is not a message, and a provider drops it rather than publishing it under a media type, so no consumer needs to know a WhatsApp field name to avoid answering plumbing.

## History is the provider's own observation

The seam owns no message database. `listChats` and `fetchMessages` return what the registered provider retained, and the shipped Baileys provider retains only what its connection observed since it loaded, which a restart discards. A consumer that needs durable conversation history logs what reaches the model, which the [model-visible ⟺ logged rule](../architecture.md) already requires.

`whatsapp/message-received` therefore repeats an id when a provider replays history after a reconnection: a consumer that must act once keeps its own processed-id set. `whatsapp/message-sent` means WhatsApp accepted the message, not that it was delivered or read.

## A conversation is a session in a Workspace

[dsh-whatsapp-workspace](../../packages/whatsapp/whatsapp-workspace) gives the account a place to live: a directory registered through `ctx.workspaceRegistry`, so a WhatsApp Workspace appears in the Web UI beside repository workspaces, and sessions inside it whose `cwd` is that directory. `route` decides how conversations map onto sessions — `category` (groups and direct chats), `per-chat`, or `single` — and it is required, because no shape is right for every account.

A category or single route means one session serves many conversations, so the conversation cannot be ambient context. Every delivered message carries its chat kind, display name, and `[chat_id: …]` in the text the model reads, and that id is exactly what `whatsapp_send_message` requires: answering the right person is a copy, not an inference.

Inbound delivery never interrupts. A message arriving mid-turn waits, claims the agent's idle phase through the maintenance path, and becomes a later turn; a burst coalesces into one wake-up while staying one turn per message. Model-visible ⟺ logged holds in the failing direction — `whatsapp/inbound` is appended before the turn is queued, so a message the log refuses never reaches the model, and the queue behind it keeps moving.

The one thing the deployment never routes is the account's own messages. `fromMe` covers the operator typing on their phone as well as the harness's own answers echoed back; delivering either would wake the agent with words it already has. Everything else the seam publishes is something a person sent, so routing needs no other content judgment.

## Answering is a decision, per message

[dsh-tool-whatsapp](../../packages/whatsapp/tool-whatsapp) owns the model-facing surface: `whatsapp_list_chats`, `whatsapp_read_chat`, `whatsapp_mark_read`, and `whatsapp_send_message`. There is no auto-reply path anywhere in this subsystem; a routed message reaches a model, and everything after that is a tool call.

`chat_id` is required on every tool that names a conversation. It is validated as a WhatsApp address rather than looked up in the account's chat list, because that list is connection-scoped: a provider builds it from observed activity, so it is empty right after connecting and gating on it would make the tools unusable on every restart. Sending additionally asks `ctx.approval` with the destination named in full, and fails closed on rejection, cancellation, and a missing approval channel alike. A confirmed send appends `whatsapp/outbound` only after the provider acknowledged it, so the log never claims a send WhatsApp refused.

## Privacy and account risk

Every message a consumer puts in front of a model reaches the LLM provider and the session log. For personal conversations that is a deliberate trade, not a side effect. The only shipped provider uses an unofficial reverse-engineered client that WhatsApp may ban or break at any time; the [runtime-specifier decision](../../.agents/notes/implemented/architecture/2026-08-21-baileys-runtime-specifier.md) records why it is never a dependency of this repository and what that costs.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxwhatsapp--whatsappruntime"></a>

### `ctx.whatsapp` — `WhatsAppRuntime`

The WhatsApp access service. Registered as `ctx.whatsapp` (one instance per context).

Every operation resolves the provider at call time and rejects when the capability cannot run:

- no provider registered → `WHATSAPP_PROVIDER_UNAVAILABLE`.
- a registered provider whose account is not `online` → `WHATSAPP_NOT_ONLINE`.

The provider emits `whatsapp/status` and `whatsapp/message-received`; this service emits `whatsapp/message-sent` after a send it dispatched is acknowledged, so an outbound acknowledgement exists even for a provider that observes no echo of its own traffic.

```ts cordis-catalog
/**
 * Register the sole provider. Throws {@link WhatsAppError}
 * `WHATSAPP_PROVIDER_ALREADY_REGISTERED` while another registration is live.
 * Returns a disposer; disposed with the calling fiber.
 * @param provider - the backend owning one authenticated account.
 * @returns the disposer that unregisters the provider.
 */
register(provider: WhatsAppProvider): () => void

/**
 * Current connection state of the registered account.
 * @returns the provider's state, or `offline` while no provider is registered.
 */
status(): WhatsAppStatus

/**
 * List the conversations the connected account knows about.
 * @param signal - optional cancellation signal forwarded to the provider.
 * @returns the known conversations in provider order.
 */
async listChats(signal?: AbortSignal): Promise<readonly WhatsAppChat[]>

/**
 * Read one page of a chat's history, newest first.
 * @param request - the chat, an optional positive-integer `limit`, and an optional paging cursor.
 * @param signal - optional cancellation signal forwarded to the provider.
 * @returns the page the provider retained for that chat.
 */
async fetchMessages(request: WhatsAppHistoryRequest, signal?: AbortSignal): Promise<readonly WhatsAppMessage[]>

/**
 * Send one text message and announce the acknowledgement on
 * `whatsapp/message-sent`. A rejected send emits nothing.
 * @param request - the target chat, the non-empty body, and an optional quoted message.
 * @param signal - optional cancellation signal forwarded to the provider.
 * @returns the acknowledged message identity and send time.
 */
async send(request: WhatsAppSendRequest, signal?: AbortSignal): Promise<WhatsAppSentMessage>

/**
 * Resolve one conversation address into the conversation it names.
 *
 * A chat id is opaque: WhatsApp addresses conversations through several
 * domains and adds more over time, so only the provider can say what an
 * address means. It answers for an address the connection has never
 * observed — naming it when it has — because a consumer must be able to
 * address a conversation it learned about from an incoming message or from
 * the operator, and the connection-scoped index is not a roster.
 * @param chatId - the conversation address to resolve.
 * @param signal - optional cancellation signal forwarded to the provider.
 * @returns the conversation, named when this connection observed it.
 */
async resolveChat(chatId: WhatsAppChatId, signal?: AbortSignal): Promise<WhatsAppChat>

/**
 * Mark one chat read up to its newest message.
 * @param chatId - the conversation to mark.
 * @param signal - optional cancellation signal forwarded to the provider.
 */
async markRead(chatId: WhatsAppChatId, signal?: AbortSignal): Promise<void>
```

Source: [`packages/whatsapp/whatsapp/src/index.ts:62`](../../packages/whatsapp/whatsapp/src/index.ts)

<a id="whatsapp-events"></a>

### `whatsapp/*` events

<a id="whatsappmessage-received--emit"></a>

#### `whatsapp/message-received` — emit

One message was observed in a chat, including messages the connected account sent from another device (`fromMe`). Delivery follows the provider's own order and repeats a message whose id was already seen when the provider replays history after a reconnection, so a consumer that must act once keeps its own processed-id set.

```ts cordis-catalog
/**
 * One message was observed in a chat, including messages the connected
 * account sent from another device (`fromMe`). Delivery follows the
 * provider's own order and repeats a message whose id was already seen when
 * the provider replays history after a reconnection, so a consumer that
 * must act once keeps its own processed-id set.
 * @param message - the observed message, normalized by the provider.
 * @mode emit
 */
'whatsapp/message-received'(message: WhatsAppMessage): void
```

Source: [`packages/whatsapp/whatsapp/src/types.ts:173`](../../packages/whatsapp/whatsapp/src/types.ts)

<a id="whatsappmessage-sent--emit"></a>

#### `whatsapp/message-sent` — emit

The provider acknowledged one send requested through `ctx.whatsapp`. Acknowledgement means WhatsApp accepted the message, not that it reached or was read by the recipient.

```ts cordis-catalog
/**
 * The provider acknowledged one send requested through `ctx.whatsapp`.
 * Acknowledgement means WhatsApp accepted the message, not that it reached
 * or was read by the recipient.
 * @param message - the acknowledged message identity and send time.
 * @mode emit
 */
'whatsapp/message-sent'(message: WhatsAppSentMessage): void
```

Source: [`packages/whatsapp/whatsapp/src/types.ts:181`](../../packages/whatsapp/whatsapp/src/types.ts)

<a id="whatsappstatus--emit"></a>

#### `whatsapp/status` — emit

The account's connection state changed, emitted once per transition. A `pairing` state is re-emitted whenever the provider rotates its payload, so a display always renders the latest one.

```ts cordis-catalog
/**
 * The account's connection state changed, emitted once per transition. A
 * `pairing` state is re-emitted whenever the provider rotates its payload,
 * so a display always renders the latest one.
 * @param status - the state just entered.
 * @mode emit
 */
'whatsapp/status'(status: WhatsAppStatus): void
```

Source: [`packages/whatsapp/whatsapp/src/types.ts:163`](../../packages/whatsapp/whatsapp/src/types.ts)
<!-- END GENERATED cordis-surface -->
