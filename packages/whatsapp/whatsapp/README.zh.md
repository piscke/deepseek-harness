# @deepseek-ai/dsh-whatsapp

[English](README.md) | 中文

WhatsApp 能力 seam（`ctx.whatsapp`）：在恰好一个已认证账号之上提供连接状态、对话、消息历史与发送。

这是**定义**包。它拥有词汇表、事件与唯一的 provider 槽位；它不建立任何连接。连接由 [`dsh-whatsapp-baileys`](../whatsapp-baileys/README.md) 提供。

## 服务

| 成员 | 含义 |
|---|---|
| `register(provider)` | 注册唯一的 provider；第二次注册抛出 `WHATSAPP_PROVIDER_ALREADY_REGISTERED`。返回 disposer，随调用方 fiber 一同释放。 |
| `status()` | 账号的连接状态；未注册 provider 时为 `offline`。永不抛出。 |
| `listChats(signal?)` | 已连接账号所知的对话。 |
| `resolveChat(chatId, signal?)` | 一个地址所指的对话；类型由 provider 判定，连接观察到时带上名称。对不指向任何对话的值以 `WHATSAPP_UNKNOWN_CHAT` 拒绝。 |
| `fetchMessages(request, signal?)` | 某个对话历史的一页，最新在前；连接从未观察过的地址没有保留历史，返回空页。 |
| `send(request, signal?)` | 发送一条文本消息，并在被确认后发出 `whatsapp/message-sent`。 |
| `claimOwnEcho(message)` | 判定一条被观察到的消息是否为本服务派发出去的发送，并消耗该认领。 |
| `markRead(chatId, signal?)` | 将对话标记为已读至其最新消息。 |

一个账号就是一条长期存在的连接，因此状态属于能力本身而非某次调用的结果。除 `status()` 与 `register()` 外的每个操作都要求账号处于 `online`：未注册 provider 时失败于 `WHATSAPP_PROVIDER_UNAVAILABLE`，而账号处于连接中、配对中或已登出的 provider 失败于 `WHATSAPP_NOT_ONLINE`。

`send` 在抵达 provider 之前就拒绝空白正文（`WHATSAPP_EMPTY_MESSAGE`），`fetchMessages` 同样先拒绝非正数或带小数的 `limit`（`WHATSAPP_INVALID_LIMIT`），因此 provider 无需自行定义这些含义。

`pairing` 负载是一份凭据，而不是进度细节：扫描它的人会链接一台拥有账号完全访问权的设备，其敏感程度高于任何消息正文。展示或转发它的界面，就是在决定谁能看到它。`online` 指明的是账号本身，而不是它所经由的设备；当 provider 无法上报时，它宁可略去这个名字，也不会凭空造一个。

## 事件

| 事件 | 触发时机 |
|---|---|
| `whatsapp/status` | 连接状态发生变化；provider 每次轮换 `pairing` 负载时都会再次发出。 |
| `whatsapp/message-received` | provider 观察到一条消息，包括账号从其他设备发出的消息（`fromMe`）。 |
| `whatsapp/chat-named` | 一段对话的显示名变为已知或发生变化。 |
| `whatsapp/message-sent` | 经由本服务派发的发送获得确认。 |

确认表示 WhatsApp 接受了该消息，而非它已送达或被阅读。重连后回放历史时，provider 可能重复某个 `whatsapp/message-received` id，因此必须只处理一次的消费者要自行保存已处理 id 集合。

对话的名字在消息流之外抵达：群的主题是通过它自己的更新到达连接的，因此群在其首条消息被观察到时通常还没有名字，片刻之后才有。于是 `WhatsAppChat.name` 是一次读数而非固定事实——展示它的界面要跟随 `whatsapp/chat-named` 自我校正。只有 provider 持有的名字确实发生变化时该事件才会发出，因此重连后重新同步同一份名册是静默的。

## 区分账号本人与本部署

provider 会把账号自己的流量重新发布出来，因此 `fromMe` 同时涵盖两件事：操作者在已配对手机上书写，以及本部署自己的回答被回传。对账号所写内容采取行动的消费者必须丢掉后者，否则 agent 会被自己的话语唤醒。

`claimOwnEcho` 就是区分两者的手段。`send` 在询问 provider 之前就记录下对话与确切正文，因为 provider 可能在其 `send` 返回之前就发布回声——写在确认之后的记录会落在已经路由完该消息的消费者后面。该记录在发送被拒绝后依然保留，因为 WhatsApp 已经转发之后发送仍可能失败；认领会被消耗，因此再次观察到同一正文即为账号本人书写。

同时可认领的发送数为 `OUTBOUND_ECHO_RECALL`。这是机制自身的深度，而非部署选择：它只需超过回声尚未被观察到的那些发送即可。

## 标识

`WhatsAppChatId` 与 `WhatsAppMessageId` 是 branded 字符串：对话 id 是账号可见的会话地址，消息 id 不透明，且只对观察到它的那条连接有意义。

对话 id 同样不透明。WhatsApp 通过多个域为会话编址，并会不断新增 —— 线上账号会把一对一对话同时报告为 `@s.whatsapp.net` 与 `@lid`，此外还并存 `@newsletter` 与 `@broadcast` —— 因此消费者不得解析对话 id，也不得用封闭的后缀集合去分类它。`WhatsAppChat.kind` 与 `WhatsAppMessage.chatKind` 已经携带该分类，由跟踪 WhatsApp 地址空间的 provider 判定；只持有地址的消费者应调用 `resolveChat`，而不是自行重新推导 —— 后者会拒绝 provider 合法报告的地址。

## 模型体验

通过把这些对话呈现给模型的消费者间接影响；本包不注册任何工具、提示词或 schema，而这样的消费者包含的一切都会到达 LLM 供应商与会话日志。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由消费方负责。

## 已知限制与暂缓事项

- **仅文本** —— `send` 只承载文本，provider 会把无法表示的媒体报告为带媒体类型的 `unsupported`，而不是丢弃消息。收发媒体属于推迟的工作。
- **回声按正文认领** —— 派发出去的发送以对话加确切文本匹配，因为它的消息 id 只存在于确认之中，而 provider 可能先于确认发布回声。因此账号本人在同一对话里写下本部署刚发出的那段确切文本时，会被认领为该回声；而不发布自身流量回声的 provider，其记录只能由后续发送挤出。
- **每个 seam 一个账号** —— provider 槽位只容纳一次注册，因为一次注册拥有一个特定的已认证账号。运行两个账号意味着两条彼此隔离的 fiber。
- **无送达或已读状态** —— seam 只上报已发送与已观察到的内容，不包含逐接收方的送达、已读回执或输入状态。
