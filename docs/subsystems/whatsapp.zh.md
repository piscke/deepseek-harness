# WhatsApp

[English](whatsapp.md) | 中文

WhatsApp seam —— 覆盖**一个已认证的个人 WhatsApp 账号**的[能力 seam](../glossary.md#capability-seam)，跨包拆分为：Service Definition（[dsh-whatsapp](../../packages/whatsapp/whatsapp)，`ctx.whatsapp` 与唯一的 provider 槽位）、Service Provider（[dsh-whatsapp-baileys](../../packages/whatsapp/whatsapp-baileys)，一条 Baileys 连接），以及两个消费方 —— [dsh-whatsapp-workspace](../../packages/whatsapp/whatsapp-workspace) 把入站消息流变成会话，[dsh-tool-whatsapp](../../packages/whatsapp/tool-whatsapp) 把账号以名称交给模型。WhatsApp 是可选能力，不属于 agent-loop 主干。

来源：[`packages/whatsapp/whatsapp/src/types.ts`](../../packages/whatsapp/whatsapp/src/types.ts)

## 一个账号，一条连接

WhatsApp 账号不是按请求使用的凭据：它是一条长期存在的已认证连接，由人工扫描一次二维码授权，并且 WhatsApp 随时可以吊销。因此 `ctx.whatsapp` 把 `status()` 作为能力的一部分上报，而非某次调用的结果；provider 槽位也只容纳一次注册 —— 第二次注册失败于 `WHATSAPP_PROVIDER_ALREADY_REGISTERED`，而不是在两个账号之间做选择。运行两个账号意味着两条彼此隔离的 fiber。

`WhatsAppStatus` 是封闭联合：`offline`、`connecting`、`pairing`（携带人工扫描的二维码负载，provider 每次轮换都会重新发出）、`online`（携带账号 id）与 `logged-out`（对当前凭据是终止性的 —— 账号必须重新配对，任何重连都无法恢复）。除 `status()` 与 `register()` 外的每个操作都要求 `online`：未注册 provider 时失败于 `WHATSAPP_PROVIDER_UNAVAILABLE`，其余状态失败于 `WHATSAPP_NOT_ONLINE`。

## 消息是什么

`WhatsAppMessage` 携带 branded 的 `WhatsAppMessageId`、所属 `WhatsAppChatId`、对话是 `direct` 还是 `group`、作者、是否由已连接账号所写（`fromMe`，包括来自其他设备）、RFC 3339 UTC 时间戳，以及 `WhatsAppContent` 正文。内容是 `text` 与 `unsupported` 的封闭联合 —— provider 会把无法表示的媒体连同其媒体类型一并报告，而不是丢弃消息，使消费者仍能看到确有内容到达并据此回复。

对话类型是路由的判别式，且归属于 provider：它为自己报告的每个对话完成分类，消费者读取 `kind`，而不是从地址重新推导。WhatsApp 通过多个域为会话编址，并会不断新增，因此 provider 会把陌生域归类为 `direct` 而非失败 —— 一旦 WhatsApp 推出新的地址空间，fail-closed 的 provider 会立刻失明，而自行解析地址的消费者则会拒绝 provider 合法报告的 id。

`whatsapp/message-received` 意味着有人发送了内容。无人撰写的帧 —— 投递元数据，或撤回、历史同步通知一类的协议事务 —— 不是消息，provider 会将其丢弃，而不是以某个媒体类型将其发布，因此没有任何消费者需要知道某个 WhatsApp 字段名才能避开管道层的东西。

## 历史来自 provider 自己的观察

seam 不拥有任何消息数据库。`listChats` 与 `fetchMessages` 返回已注册 provider 所保留的内容，而随附的 Baileys provider 只保留其连接自加载以来观察到的内容，重启会将其丢弃。需要持久对话历史的消费者应记录抵达模型的内容，这正是 [model-visible ⟺ logged 规则](../architecture.md)已经要求的。

因此当 provider 在重连后回放历史时，`whatsapp/message-received` 会重复某个 id：必须只处理一次的消费者要自行保存已处理 id 集合。`whatsapp/message-sent` 表示 WhatsApp 接受了该消息，而非它已送达或被阅读。

## 一段对话就是工作区里的一个会话

[dsh-whatsapp-workspace](../../packages/whatsapp/whatsapp-workspace) 给账号一个安身之处：一个通过 `ctx.workspaceRegistry` 注册的目录，于是 Web UI 中会在仓库工作区旁边出现一个 WhatsApp 工作区；其中的会话，其 `cwd` 就是那个目录。`route` 决定对话如何映射到会话 —— `category`（群聊与私聊）、`per-chat` 或 `single` —— 并且它是必填的，因为没有哪一种形态适合所有账号。

分类路由或单会话路由意味着一个会话服务多段对话，因此对话身份不能是环境上下文。每条投递的消息都在模型读到的文本里携带它的对话种类、显示名与 `[chat_id: …]`，而那个 id 正是 `whatsapp_send_message` 所要求的：回复给对的人是复制，而不是推断。

入站投递永不打断。轮次中途到达的消息会等待，通过维护路径认领 agent 的空闲阶段，并成为一个较晚的轮次；一阵突发合并为一次唤醒，同时仍保持每条消息一个轮次。「模型可见 ⟺ 已记录」在失败方向上成立 —— `whatsapp/inbound` 在轮次入队之前追加，因此日志拒绝的消息永远不会到达模型，而其后的队列继续前进。

部署唯一永不路由的，是账号自己的消息。`fromMe` 既涵盖操作者在手机上打字，也涵盖 harness 自己被回送的回答；投递其中任何一种，都会用 agent 已经掌握的话唤醒它。seam 发布的其他一切都是某个人发出的，因此路由不需要任何别的内容判断。

## 回复是逐条做出的决定

[dsh-tool-whatsapp](../../packages/whatsapp/tool-whatsapp) 拥有面向模型的表面：`whatsapp_list_chats`、`whatsapp_read_chat`、`whatsapp_mark_read` 与 `whatsapp_send_message`。本子系统中任何地方都没有自动回复路径；被路由的消息抵达模型，之后的一切都是工具调用。

每个指名对话的工具都必填 `chat_id`。它按 WhatsApp 地址校验，而不是在账号的对话列表里查找，因为那份列表以连接为界：provider 从观察到的活动构建它，刚连接时它为空，以它把关会让工具在每次重启后都不可用。发送还会带着完整指名的目的地询问 `ctx.approval`，并在拒绝、取消以及缺少审批通道时一律失败收场。一次确认的发送只在 provider 确认之后才追加 `whatsapp/outbound`，因此日志绝不会声称一次被 WhatsApp 拒绝的发送。

## 隐私与账号风险

消费者呈现给模型的每条消息都会到达 LLM 供应商与会话日志。对于私人对话，这是一项有意的取舍，而非副作用。唯一随附的 provider 使用非官方逆向工程客户端，WhatsApp 随时可能封禁或使其失效；[运行时说明符决定](../../.agents/notes/implemented/architecture/2026-08-21-baileys-runtime-specifier.md)记录了它为何永不成为本仓库的依赖，以及这样做的代价。

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

Source: [`packages/whatsapp/whatsapp/src/types.ts:169`](../../packages/whatsapp/whatsapp/src/types.ts)

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

Source: [`packages/whatsapp/whatsapp/src/types.ts:177`](../../packages/whatsapp/whatsapp/src/types.ts)

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

Source: [`packages/whatsapp/whatsapp/src/types.ts:159`](../../packages/whatsapp/whatsapp/src/types.ts)
<!-- END GENERATED cordis-surface -->
