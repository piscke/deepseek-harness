# Agent Note: The paired phone is the operator, so only the deployment's own echo is filtered

Status: implemented

[English](2026-08-27-whatsapp-route-own-messages.md) | 中文

## Problem

路由此前丢弃账号本人写下的每一条消息。`fromMe` 同时指称两位发送者：在已配对手机上打字的操作者，以及被 provider 重新发布出来的、本部署自己的回答。必须挡在 agent 之外的只有后者。

两者都丢意味着一个账号无法触达属于自己的 harness。操作者手上正是部署所链接的那一台手机，向它书写——写进自聊，或写进范围内的任何一段对话——是查看路由、会话开启与投递是否成立的最短路径。此前要那样试就需要第二个号码和一位愿意配合的第三方，这也正是入站路由在[Workspace 与工具的那篇记录](2026-08-22-whatsapp-workspace-and-tools.md)中被记为未在真实账号上验证的原因。

## Decision

`routeMessage` 不再查看 `fromMe`；它只施加范围、允许与拒绝。账号所写与其他消息一样被路由。

回声改为按名字而非按发送者剔除。`WhatsAppRuntime.send` 记录下自己派发的每一次发送的对话与确切文本，`ctx.whatsapp.claimOwnEcho(message)` 回答一条被观察到的消息是否就是其中一次发送，并消耗掉该记录。`WhatsAppInboundRouter.accept` 先行认领，认领成功即返回。

记录写在调用 `provider.send` **之前**，而不是发送被确认之时。Baileys 在 `sendMessage` 内部就为自己的发送发布 `messages.upsert`，因此回声在 `send` 兑现之前、在任何 id 存在之前就被观察到；写在确认之后的记录会落在已经投递完该消息的 router 后面。只有派发前的记账在时序上成立。

被拒绝的发送保留其记录，因为 WhatsApp 已经转发之后发送仍可能失败。记录只经由挤出而离开：同时可认领的发送为 `OUTBOUND_ECHO_RECALL` 条，这是机制自身的深度而非部署选择——它只需超过回声尚未被观察到的那些发送即可。

认领跑在路由策略之前，因此发往部署并不路由的对话的那次发送依然会消耗掉自己的记录，而不是把它留给之后的某条消息去匹配。

不存在任何配置项。两位发送者中是谁写下了某条消息，是 harness 本就知道的关于自身的事实，而非部署偏好。

## Alternatives considered

**一个 `ownMessages: ignore | route` 配置字段。** 最先考虑、也是当初拿去询问操作者的形态。被否决，因为两个取值都不是任何部署的真实立场：没人希望自己的回声被路由，而一个听不见自家操作者的账号同样不是有意为之的配置。加上这个字段等于照样实现回声压制，外加一个只有一种合理取值的开关。

**在 `whatsapp/message-sent` 上压制，或按已确认的消息 id 压制。** 显而易见的位置，也正是输掉上文那场竞态的做法。id 只在 provider 确认之后才存在，而那时回声早已发布。

**把记账放在 Workspace 的 router 里。** 被否决，因为 router 并不拥有发送。模型经由另一个包里的 `whatsapp_send_message` 发送，两条路径都通过 `ctx.whatsapp` 抵达账号，因此 seam 是唯一能观察到全部派发的地方。

**用集合而非可消耗队列记住发出的正文。** 被否决，因为集合永不遗忘：操作者复述一句 agent 曾写过的话会被永远吞掉。可消耗的认领至多吞掉 harness 确实发出过的那些份。

**发送被拒绝时丢掉记录。** 被否决：一次拒绝并不证明什么都没有被转发，而晚失败的那次发送的回声届时会唤醒 agent。

## Testing

seam 的测试覆盖了认领只生效一次、回声先于 `send` 兑现被发布、记录跨越被拒绝的发送而保留、对另一对话/另一正文/媒体/`fromMe: false` 的拒绝，以及超出 recall 后的挤出。Workspace 的测试覆盖账号本人的消息被路由，以及部署自己的发送永不被投递。

无密钥的已组装应用快照是这一对行为的证据：其 driver 依次发布一位联系人的消息、本部署的回声，以及操作者在已配对手机上的书写，而期望日志恰好携带两条 `whatsapp/inbound` 事件，agent 自己的回答不在其中。

## Consequences

- 回声挺不过重启。可认领的发送与 seam 同生共死，因此其后被 provider 重放的回声会被当作账号所写而路由。
- 不发布自身流量回声的 provider 会留下记录，直到被之后的发送挤出；期间操作者若把那段确切文本写进那段对话，就会被当成回声。
- 入站路由如今从已配对手机即可触达，因此[Workspace 与工具的那篇记录](2026-08-22-whatsapp-workspace-and-tools.md)所点名的真实验证缺口不再需要第三方才能补上。
