# @deepseek-ai/dsh-whatsapp-workspace

[English](README.md) | 中文

WhatsApp 工作区：一个注册为 [Workspace](../../workspace/workspace/README.md) 的专用目录、其中每段对话各自一个会话，以及把账号的入站消息流作为待处理上下文投递进这些会话——由操作者的下一条提示把它带入请求。

这是 [WhatsApp 能力 seam](../whatsapp/README.md)（`ctx.whatsapp`）的消费方。它不注册 provider，也不注册工具——回复一段对话是 [`dsh-tool-whatsapp`](../tool-whatsapp/README.md) 的事。

## 加载时做什么

1. 解析 `directory`（开头的 `~` 展开为用户主目录）并创建它。
2. 把策略中可实时变更的那一部分注册为设置区段，于是运行中的部署无需重新加载即可改变路由什么。
3. 通过 `ctx.workspaceRegistry.create(path, workspaceTitle)` 注册该目录，于是 Web UI 侧栏里会在仓库工作区旁边出现一个 WhatsApp 工作区。
4. 订阅 `whatsapp/message-received` 与 `whatsapp/chat-named`。

加载时不打开任何会话。一段对话的会话在该对话首次被路由时创建，因此全新的部署起初是一个空工作区，此后会列出它回答过的每一段对话——会话与工作区的挂载是持久的。

任何一步无法完成都会让插件加载失败：不可用的目录、拒绝该路径的注册表。一个悄无声息永远不出现的工作区，与一个断线的账号无法区分。

## 路由

一段对话就是一个会话，始终如此。一个联系人与一个群各自拥有自己的日志、自己的标题与自己的 agent，这正是「按联系人的解读器」得以成立的前提：模型读到的历史只属于那个联系人，不掺入他人。

`chats` 决定哪些对话会打开会话：

| 范围 | 路由 |
|---|---|
| `all` | 全部对话，群聊与私聊。 |
| `groups` | 仅群聊对话。 |
| `contacts` | 仅私聊对话。 |

`allowChatIds` 非空时即是穷尽列表；`denyChatIds` 随后生效，因此同时出现在两者中的会话仍被拒绝。两者都在 `chats` 之后判定，因此收窄范围绝不会因为操作者忘记删除的白名单条目而让某段对话继续被路由。

有两条过滤是部署无法关闭的策略。账号自己写的消息（`fromMe`，包括来自另一台设备的）永不路由，因为把部署自己的回答再送回去会用它自己的话唤醒 agent。已经投递过的消息 id 会被丢弃，因为 provider 在重连后会重放历史。

不存在按内容进行的过滤。`whatsapp/message-received` 意味着某个人发出了什么——provider 会丢弃投递元数据与协议杂务，而不是把它们发布出来——因此本包从不检视 WhatsApp 的字段名，一个它无法渲染的媒体类型同样会进入会话。

### 每条消息都标明自己的对话

一个会话恰好服务一段对话，而对话 id 仍然是每条消息的一部分：

```text
WhatsApp message in direct chat "Ana" [chat_id: 5511999990000@s.whatsapp.net]
From: Ana (5511999990000@s.whatsapp.net)
Sent: 2026-08-21T10:00:00.000Z

boa tarde, você pode confirmar o horário?
```

那个 `[chat_id: …]` 头部正是 `whatsapp_send_message` 所需要的值，因此回复给对的人是从这一轮里复制，而不是要模型从会话上下文中带着这个事实走。

## 投递：待处理上下文，而非自动的一轮

到达的消息不会花掉一次模型请求。`inboundDelivery` 决定被路由的消息做什么：

| 模式 | 投递 |
|---|---|
| `context`（默认） | 框架文本注入到 next-step 收件箱边界，不唤醒任何东西。它保持待处理——在 Web UI 中显示在对话末尾——直到操作者在该对话中写下下一条提示；收件箱会在那条提示之前认领它，于是这条消息成为答复所依据的上下文。 |
| `turn` | 框架文本开启它自己的后续轮次，这是面前没有操作者时账号作答的方式。 |

待处理上下文是持久的（`agent/inbox/spliced`），因此进程停止时仍在等待的消息，重启之后依然在等待。

在 agent 处于轮次中途时到达的消息会等到该轮次结束。投递通过 `runMaintenance` 认领 agent 的空闲阶段，因此框架文本在两轮之间进入日志与 agent 的收件箱；因轮次正占用 agent 而被拒绝的认领会驻留在 `whenIdle()` 上并在下一个边界重试，同时把该批次放回队首，使到达顺序得以保留。在 `context` 下，这次认领同样使消息不会落入已在飞行中的轮次——否则那一轮的下一个 step 边界会消费掉它，也就是无人问起便作答。

投递按会话串行且会合并：认领成功那一刻队列中的全部内容都在这次认领内投递，于是一阵消息突发只是一次认领，而不是每条一次。

单条消息的失败被隔离。日志拒绝的消息会被警告并丢弃，其后的队列继续前进——一条无法记录的消息不能让一整段对话沉默。

## 会话

一段对话的会话标识是 `whatsapp-chat-<digest>`，摘要取自对话 id：跨重启稳定，且不含账号地址携带的那些字符。因此重启会继续那段对话，而不是开一段空的。

打开一段对话时，按以下顺序解析到一个活的 agent：

1. 该标识上已经发布的 agent——操作者正在 Web UI 中打开这段对话——会被直接投递，而不是在同一份日志上第二次恢复。拆卸时只释放本路由自己打开的会话。
2. 已持久化的日志会被恢复，并按该日志中记录的 preset 组合，而不是部署当前的 `agentPreset`：会话中已有的轮次是在它记录下来的那份组合下产生的。
3. 否则创建新会话，按 `agentPreset` 组合，`cwd` 设为工作区目录。

新对话在 `ctx.agentDefaultModel.currentSelection()` 上作答——与其他任何地方新建会话拿到的默认值相同。入站消息面前没有操作者来挑选模型。

记录在另一个项目目录下的已存会话会带着两个路径大声失败：这意味着部署在旧目录仍有日志时移动了 `directory`。

标题就是对话的名字：先是账号为该对话解析出的名字，再是消息携带的名字，最后是尚无人命名的对话的对话 id。`whatsapp/chat-named` 会为已打开的会话改名，这正是首条消息到达时主题未知的群最终会落在自己主题之下的方式，也是被改名的对话得以跟随的方式。标题用 `ctx.sessionTitle.rename()` 固定，其 `user` 来源会永久停止自动标题生成；标题未变时会跳过重新固定，因此重启不会追加一条冗余事件。

## 回答一段对话的 agent

`agentPreset` 指定在每个对话会话创建时挂载的[预设](../../preset/agent-presets/README.md)——决定拿联系人所说的话做什么的那个解读器。缺省时不挂载任何东西，会话就运行在组合给每个 agent 的东西之上。预设名册通过 `ctx.get` 读取而非注入，因此没有名册的 headless 组合照常工作。

改动 `agentPreset` 对此后打开的对话生效。已经产生过的会话保留其日志中记录的 preset。

## 实时设置

`chats`、`allowChatIds`、`denyChatIds`、`inboundDelivery` 与 `agentPreset` 同时也是一个设置区段，在「设置 › WhatsApp」中与配对二维码并排编辑（[`dsh-client-ui-settings-whatsapp`](../../client/ui-settings-whatsapp/README.md)）。路由器按消息读取当前权威策略，因此范围或投递方式的变更对下一条消息即刻生效，无需重新加载；`agentPreset` 的变更对下一段打开的对话生效。

`directory` 与 `workspaceTitle` 被刻意排除在该区段之外：它们决定工作区的身份，而身份在插件加载时固定，不能在已经挂载其上的会话之下改变。

存储文档未设置的字段保留组合配置项的值，因此清除一项设置是恢复部署所交付的值，而不是把该字段清空。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `directory` | `~/.dsh/whatsapp` | 工作区拥有、且每个对话会话都在其中运行的目录。必须解析为绝对路径。 |
| `workspaceTitle` | `WhatsApp` | 工作区在侧栏中的标题。 |
| `chats` | `all` | 哪些对话会打开会话：`all`、`groups` 或 `contacts`。 |
| `allowChatIds` | `[]` | 非空时，只有其中的对话会被路由。 |
| `denyChatIds` | `[]` | 永不路由的对话。 |
| `inboundDelivery` | `context` | 被路由的消息做什么：`context` 等待操作者的下一条提示，`turn` 开启它自己的后续轮次。 |
| `agentPreset` | *（无）* | 每个对话会话创建时挂载的预设。 |
| `seenMessageLimit` | `1000` | 记住多少条已投递消息 id，用以压制 provider 的历史重放。 |

```yaml
- id: whatsapp-workspace
  name: '@deepseek-ai/dsh-whatsapp-workspace'
  config:
    chats: contacts
    workspaceTitle: WhatsApp
    agentPreset: interpreter
```

`create` 会复用已经拥有该规范路径的记录并保留其标题，因此操作者在 UI 中改过的标题能挺过重启。

## 事件

| 事件 | 追加时机 |
|---|---|
| `whatsapp/inbound` | 一条入站消息即将进入会话时，在它被注入或入队之前。 |

先追加使得「模型可见 ⟺ 已记录」在失败方向上成立：日志无法记录的消息永远不会到达模型。出站的一半（`whatsapp/outbound`）属于 [`dsh-tool-whatsapp`](../tool-whatsapp/README.md)。`./invariant` 校验每一条已存的 `whatsapp/inbound` 记录。

## 模型体验

### 入站消息框架

#### 模型看到什么

每条被路由的消息作为一条由插件产生、声明 `notice` 形态的用户消息到达：一行标明对话种类的头部、账号解析出显示名时的对话名，以及 `[chat_id: <id>]`；一行 `From:`；一行 `Sent:`；一个空行；然后是正文。seam 无法表示的媒体渲染为 `[unsupported media: <type>]`，而不是凭空消失。来源还携带一行摘要（`Ana: alguém pode buscar o bolo?`），那正是转录行折叠时所显示的内容——于是仍在等待操作者的消息无需展开即可读到。在 `context` 下，框架文本在操作者的下一条提示所开启的那一轮的 pre-step 被认领，并落在那条提示之前：模型先读到来了什么，再读到关于它被问了什么。

##### 一条已投递的消息

```markdown
WhatsApp message in group chat "Família" [chat_id: 12036300000@g.us]
From: Ana (5511999990000@s.whatsapp.net)
Sent: 2026-08-21T10:00:00.000Z

alguém pode buscar o bolo?
```

#### Token 影响

每条已投递消息一段框架文本，大约四行短行加正文，在会话中保留到压缩为止。在 `context` 下，在操作者写下提示之前，一阵突发根本不花费任何请求，随后它们一起搭上同一次请求。

#### KV Cache 影响

仅追加；每段框架文本都跟在可复用的请求前缀之后，不会使既有的 KV cache 条目失效。本包不贡献系统提示词，也不贡献工具 schema，因此前缀本身永不改变。

## 已知限制与推迟的工作

- **这里没有任何东西在真实 WhatsApp 账号上验证过** —— 路由、排队与会话生命周期由针对脚本化 seam 的单元测试与组合测试覆盖。在真实 provider 下的行为尚未验证。
- **路由信任 seam 的规则：入站事件即人发出的消息** —— 本包不做任何自己的内容判断，因此若某个 provider 发布了投递元数据或协议杂务，就会把它摆到模型面前。那是该 provider 需要修复的缺陷，而在这里复制一份判断，只会在两份清单发生漂移的那一刻悄悄丢掉真实媒体。
- **取消一段对话会丢弃尚未到达模型的内容** —— `agent.cancel()` 会清空待处理的收件箱工作，因此在 `context` 下等待的消息会从它们本该搭上的那次请求中被丢掉。持久的 `whatsapp/inbound` 记录仍然保有它们。
- **待处理上下文无上限累积** —— 没有自动的一轮，繁忙的对话会持续注入直到操作者写下提示，届时所有等待中的消息都搭上那一次请求。`chats`、`allowChatIds` 与 `denyChatIds` 就是控制手段；按对话的上限被推迟。
- **去重在内存中** —— `seenMessageLimit` 个 id 与插件同生共死，因此重启后 provider 重放的消息可能被再次投递。持久的 `whatsapp/inbound` 日志知道得更准；在加载时查询它被推迟。
- **agent 的回复不会被发到任何地方** —— 本包把消息投递进会话。agent 是否回答、回答给谁，是模型通过 `whatsapp_send_message` 做的决定，而那个工具每次都会询问操作者。按设计，这里没有自动回复路径。
- **会话无上限地打开** —— 每段对话一个会话，首次接触时创建，既不淘汰也无上限。`chats`、`allowChatIds` 与 `denyChatIds` 就是对话很多的账号所拥有的控制手段。
- **更早的常驻会话形态所留下的会话不再被路由** —— 运行过已移除的 `category` 或 `single` 形态的部署，其日志仍挂载在工作区上且可读，新消息会在它们旁边打开按对话的会话。不迁移，也不删除。
- **每个工作区一个账号，每个账号一个进程** —— seam 只持有一个已认证账号，因此第二个账号意味着第二个 fiber 及其自己的目录。更严格的规则来自 provider：两个连接共用一个认证目录时会互相顶替已链接设备，较早的那个会以连接冲突死亡。与前一个进程重叠的重启，或指向同一目录的第二个 harness，会让账号下线，而不是共享它。
