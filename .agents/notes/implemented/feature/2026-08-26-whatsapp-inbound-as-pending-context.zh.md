# Agent Note: Inbound WhatsApp messages are pending context, not automatic turns

Status: implemented

[English](2026-08-26-whatsapp-inbound-as-pending-context.md) | 中文

## Problem

每一条被路由的入站消息都会开启它自己的后续轮次。一个在无人照看时收到六条消息的账号会花掉六次模型请求，逐条孤立作答；随后到来的操作者读到的是六条回复，它们既没有依据操作者的意图写就，彼此之间也互不知情。

对于这个 Workspace 所服务的用途，这是错误的默认：一个人看着一段对话，然后就其向 agent 提问。他们希望一条到达的消息做到的是*可取用*——在 Web UI 中清晰可读，并成为他们下一次提问的上下文——而不是无人问起便被作答。

Web UI 让同一条消息以两种方式不可见。Host 早已把待处理的注入上下文作为携带 `placement: 'context'` 的 `session/queue` 项广播，而两个客户端消费方都把它丢掉了：`QueueDock` 只渲染 `queued`，`ChatView` 只渲染 `steering`。在一条面向模型的消息被产生到被某个轮次领取之间，没有任何界面呈现它。

## Decision

`inboundDelivery` 决定被路由的消息做什么，默认为 `context`。

在 `context` 下，`WhatsAppSessionInbox.deliver()` 追加 `whatsapp/inbound`，然后调用 `agent.inject()`，把框架文本 splice 进不唤醒的 `next-step` 收件箱并提交 `agent/inbox/spliced`。没有任何东西被唤醒。这条消息一直等待，直到操作者在该对话中写下下一条提示；`Inbox.claim()` 先取走整个 `next-step` 列表，再取走一条 `next-turn` 消息，因此框架文本在请求中落在提示之前。模型先读到来了什么，再读到关于它被问了什么。

在 `turn` 下，`deliver()` 与此前完全一样调用 `agent.followup()`，这正是面前没有操作者时账号作答的方式。该字段加入用户可写的设置切片，因此这个模式是一个 `cordis.yml` 取值和一项实时设置，而不是一次分叉。

Web UI 会在对话末尾渲染任何仍待处理的 `context` placement，而不只是 WhatsApp 的。`ChatView` 把每一个都经 `PendingContextRow` 投影，后者复用持久节点此后将成为的那个 `ContextInjectionRow`，于是一行在被领取前后完全相同，交接过程没有任何视觉接缝。

## 空闲认领在这次替换中保留下来

投递路径仍然认领 `agent.runMaintenance`，仍然在轮次占用 agent 时驻留于 `whenIdle()`。这套机制读起来像是 `followup` 的遗留物——它的存在是为了让消息永不打断运行中的轮次——但在 `context` 下它承担的工作比以前更多，而非更少。

`inject()` 面向的是 `next-step` 边界。一个已在飞行中的轮次会在它的下一个 pre-step 到达该边界并在那里消费掉这条消息，也就是无人问起便作答：这恰恰是本次改动要移除的行为，只不过从另一端重新出现。认领空闲阶段，正是让到达的消息不落入无人为它而开的轮次的原因。

## 为什么框架文本声明 `notice`

被注入消息的插件来源携带 `form: 'notice'` 与一行 `summary`（`Ana: alguém pode buscar o bolo?`），由 `summarizeInbound()` 产生并经 `boundContextSummary` 限长。

`notice` 是唯一让摘要出现在*折叠*行上的形态：`contextBody()` 对 `notice` 返回摘要，对其他形态则不返回。因此一条等待中的消息无需操作者展开就能在转录中读到它本身，这正是「等待期间可见」成立而非徒有其名的原因。

## Alternatives considered

**直接用 `inject` 取代 `followup`，不设模式。** 表面更小，只需记录一种行为。被否决，因为自主作答的账号是本包真实存在的一种部署方式，否则它唯一的出路就是分叉。`turn` 完整保留此前的语义，而默认值承载新的意图。

**在来源上使用 `form: 'relay'`。** 最直白的读法——另一方寄给本 agent 的消息。经查证后被否决：`RelayBody` 从来源读取 `senderSessionId`，缺失时降级为 opaque 主体，而 WhatsApp 没有会话 id，因此 `relay` 的渲染结果与完全不声明形态别无二致。`relay` 同时意味着 agent 之间的转达，而这并非如此。

**在插件内缓冲消息，等操作者提问时再注入。** 好处是在确定被需要之前不把待处理消息放进 agent 的收件箱。被否决，因为收件箱本身就是那个缓冲区，而且它是持久的：插件侧的列表会在进程停止时丢失所有等待中的内容，还需要自己的一套认领、排序与取消规则，去对抗 `Inbox` 已经执行的那一套。

**只为 WhatsApp 渲染待处理行。** 被否决，因为该 placement 是通用的，且 Host 已经把它算好了。审批通知与任务完成通知同样是注入的；它们通常在运行中轮次的下一个 step 边界被领取，因此至多一闪而过，但压制它们意味着要教客户端哪些产生方值得被看见。

**像待处理 steering 那样强制滚动到待处理上下文行。** 被否决：steering 是读者自己的话，因他们按下按键而出现。入站上下文的出现是因为别人打了字。它加入跟随信号——因此读者停在底部时它保持在视野内——但绝不拽动视口。

## Testing

包级测试在投递 seam 上覆盖两种模式：`context` 让 agent 保持空闲、框架文本停在 `agent.inbox.nextStep` 中，并断言确切的 `notice` 来源；`turn` 每条消息产生一个后续轮次；队列进行中的设置变更按消息而非按批次被捕获。`summarizeInbound` 覆盖了发送方回退、不支持的媒体与限长。客户端测试覆盖 `context` 行上被投影的 `source`，以及待处理行在流末尾的渲染。

无密钥的组合应用快照是整套语义的证据。它的驱动脚本发布一条入站消息，等待 `agent/inbox/spliced`，并在 agent 未处于空闲且恰有一条待处理 next-step 消息时**失败**；只有到那时它才提交操作者的提示。期望日志显示两条 `user/message` 只对应一个 `turn/start`——WhatsApp 框架文本在前，操作者的提示在后。

## Consequences

- 在 `context` 下等待的消息会被 `agent.cancel()` 丢弃，因为它会清空待处理的 inbox 工作。持久的 `whatsapp/inbound` 记录仍然保有它，但它不会搭上本该搭乘的那次请求到达模型。
- 待处理上下文无上限累积。繁忙的对话会持续注入直到操作者写下提示，届时所有等待中的内容都搭上那一次请求。`chats`、`allowChatIds` 与 `denyChatIds` 仍是控制手段。
- 客户端的队列投影现在携带每行的 `MessageSource`，类型标为 `unknown`，因为 `MessageSource` 是可合并扩展的，而客户端必须渲染它并不认识的产生方。
- 本笔记取代[Workspace 与工具笔记](2026-08-22-whatsapp-workspace-and-tools.md)中的投递决策；该笔记关于过滤、框架文本、日志与工具的决策不变。它应用了[将上下文注入与轮次执行分离](../architecture/2026-07-24-separate-context-injection-from-turn-execution.md)所记录的注入生命周期，而未加以改动。
