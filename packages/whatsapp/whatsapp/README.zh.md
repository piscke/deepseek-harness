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
| `fetchMessages(request, signal?)` | 某个对话历史的一页，最新在前。 |
| `send(request, signal?)` | 发送一条文本消息，并在被确认后发出 `whatsapp/message-sent`。 |
| `markRead(chatId, signal?)` | 将对话标记为已读至其最新消息。 |

一个账号就是一条长期存在的连接，因此状态属于能力本身而非某次调用的结果。除 `status()` 与 `register()` 外的每个操作都要求账号处于 `online`：未注册 provider 时失败于 `WHATSAPP_PROVIDER_UNAVAILABLE`，而账号处于连接中、配对中或已登出的 provider 失败于 `WHATSAPP_NOT_ONLINE`。

`send` 在抵达 provider 之前就拒绝空白正文（`WHATSAPP_EMPTY_MESSAGE`），`fetchMessages` 同样先拒绝非正数或带小数的 `limit`（`WHATSAPP_INVALID_LIMIT`），因此 provider 无需自行定义这些含义。

## 事件

| 事件 | 触发时机 |
|---|---|
| `whatsapp/status` | 连接状态发生变化；provider 每次轮换 `pairing` 负载时都会再次发出。 |
| `whatsapp/message-received` | provider 观察到一条消息，包括账号从其他设备发出的消息（`fromMe`）。 |
| `whatsapp/message-sent` | 经由本服务派发的发送获得确认。 |

确认表示 WhatsApp 接受了该消息，而非它已送达或被阅读。重连后回放历史时，provider 可能重复某个 `whatsapp/message-received` id，因此必须只处理一次的消费者要自行保存已处理 id 集合。

## 标识

`WhatsAppChatId` 与 `WhatsAppMessageId` 是 branded 字符串：对话 id 是账号可见的会话地址，消息 id 不透明，且只对观察到它的那条连接有意义。

## 模型体验

通过把这些对话呈现给模型的消费者间接影响；本包不注册任何工具、提示词或 schema，而这样的消费者包含的一切都会到达 LLM 供应商与会话日志。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由消费方负责。

## 已知限制与暂缓事项

- **仅文本** —— `send` 只承载文本，provider 会把无法表示的媒体报告为带媒体类型的 `unsupported`，而不是丢弃消息。收发媒体属于推迟的工作。
- **每个 seam 一个账号** —— provider 槽位只容纳一次注册，因为一次注册拥有一个特定的已认证账号。运行两个账号意味着两条彼此隔离的 fiber。
- **无送达或已读状态** —— seam 只上报已发送与已观察到的内容，不包含逐接收方的送达、已读回执或输入状态。
