# Agent Note：按人所撰写的内容而非信封的首个字段来判定 WhatsApp 消息

Status: implemented

[English](2026-08-21-whatsapp-envelope-classification.md) | 中文

## 问题

Baileys 的 `message` 体是 protobuf 解码后的对象，其键即字段名，顺序即解码顺序。该顺序不承载任何含义：WhatsApp 会把投递元数据作为真实载荷的**兄弟字段**附上 —— 媒体旁的 `messageContextInfo`、大多数群消息上的 `senderKeyDistributionMessage` —— 而撤回、历史同步通知一类的协议帧则以 `protocolMessage` 到达，根本不含载荷。

provider 曾以 `Object.keys(body)[0]` 判定非文本内容，因此发往群的一张图片可能被上报为 `{ kind: 'unsupported', mediaType: 'senderKeyDistributionMessage' }`。它还会把纯协议帧以兜底的 `mediaType: 'empty'` 作为 `whatsapp/message-received` 发布。

这两个缺陷都把 WhatsApp 的线上词汇推给了每一个消费者。消费者若为避免回应事务性帧而过滤这些字段名 —— 这正是在历史同步的 `protocolMessage` 洪流面前最自然的反应 —— 就会悄悄丢掉被 provider 误标的群媒体。库的字段名归 provider 所有；seam 之上的任何一方都不该知道它们。

## 决定

`contentOf()` 指向载荷本身，而不是恰好最先解码的那个字段；当信封中没有任何由人撰写的内容时返回 `undefined`，在 `normalizeMessage()` 中与既有的无 id、无地址两种情形一同丢弃该条目。

一个常量 `NON_CONTENT_FIELDS` 列出永不表达"人发送了什么"的字段：`messageContextInfo`、`senderKeyDistributionMessage`、`protocolMessage`。选择上报类型时跳过它们；当再无其他字段时，该消息不予发布。这些是 WhatsApp 的信封字段名 —— 属于外部协议常量，而非部署选择 —— 因此固定而不作为 `Config`。

文本保留其快速路径，未作改动：`conversation` 与 `extendedTextMessage.text` 在任何键扫描之前读取，因此元数据兄弟字段从未影响过它。

## 曾考虑的替代方案

**不动判定逻辑，交由各消费者过滤。** 这是消费者最先会伸手去做的事，也正是陷阱：该过滤器面对直聊文本时看着没问题，一旦 `senderKeyDistributionMessage` 最先解码，就会吃掉真实的群媒体。它还把 WhatsApp 的字段名复制进每一个消费者，列表一变就得逐个纠正。

**发布协议帧，让消费者自行决定。** 无人撰写的帧不是消息。发布它意味着每条路由规则、每个未读计数、每条日志条目都要重新推导这一点，而 `whatsapp/message-received` 将不再名副其实。

**把被跳过的字段名放进 `Config`。** 它们是 WhatsApp 自身的线上词汇，而非随部署而变的可调项；使其可配置只会诱使某个部署重新弄坏判定。

**在 `WhatsAppContent` 中建模元数据兄弟字段。** seam 的封闭联合 `text | unsupported` 回答的是"这个人发送了什么"。投递元数据回答的是另一个问题，当前没有任何消费者提出；为此拓宽一个公开联合毫无所得。

## 后果

消费者只会看到人发送的消息，其类型由载荷决定，且永远无需知道任何一个 WhatsApp 字段名。撤回与历史同步通知在 seam 之上不可见 —— 目前可以接受，若将来有消费者需要反映一条被删除的消息，此处即是重新审视之地。

该字段列表是对一个无文档、逆向而来的协议的手工近似。它取自 Baileys 自身的信封处理，以及一次真实配对 —— 其中仅直接观察到 `protocolMessage` 这一个兄弟字段；WhatsApp 日后新增的字段将以一个陌生名称的 `unsupported` 媒体类型浮现，而不是化为沉默，这正是更可取的失败方式。
