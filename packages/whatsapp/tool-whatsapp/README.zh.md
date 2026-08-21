# @deepseek-ai/dsh-tool-whatsapp

[English](README.md) | 中文

面向模型的 WhatsApp 工具套件——`whatsapp_list_chats`、`whatsapp_read_chat`、`whatsapp_mark_read`，以及经审批把关的 `whatsapp_send_message`——建立在 [WhatsApp 能力 seam](../whatsapp/README.md)（`ctx.whatsapp`）之上。它只拥有面向模型的关切：工具名、JSON schema、snake_case 参数名、每次调用的上限、结果格式、审批提示文本，以及 UI 呈现投影。所有账号访问都经过 `ctx.whatsapp`；本包从不导入任何具体 provider。

每个工具独立注册，因此只读部署可以关掉 `send` 而保留其余三个。

## 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `whatsapp_list_chats` | `unread_only`、`limit` | 账号自连接以来观察到的对话，每条带上它的 `chat_id`、显示名、种类与未读数。 |
| `whatsapp_read_chat` | `chat_id`（必填）、`limit`、`before` | 一页对话历史，最新在前。`before` 按消息 id 继续往前翻页。 |
| `whatsapp_mark_read` | `chat_id`（必填） | 把一段对话标记为读到最新一条。对方会看到已读回执，因此这是真实副作用，不是本地标志。 |
| `whatsapp_send_message` | `chat_id`（必填）、`text`（必填）、`quoted_message_id` | 在操作者批准后发送一条文本消息。 |

### 对话索引以连接为界

provider 从它观察到的活动构建对话索引，因此它持有的是这次连接碰巧看到的内容——有时在刚连接时空无一物，有时则是从 app-state 同步恢复出来的对话。于是索引成员资格无法用来把关寻址：每个指名对话的工具都直接采用交给它的 `chat_id`，在账号已观察到该对话时使用其显示名，并把可达性留给 provider 判断。

`whatsapp_list_chats` 在自己的描述里对模型说了同一件事，否则一个空列表会被读成“该账号没有任何对话”。`whatsapp_read_chat` 出于同样的理由也这么说：历史记录以连接为界，因此空页报告的是被保留下来的内容，而不是被说过的内容，读起来为空的对话依然可以发送消息。

### 对话 id 是不透明的

本包从不解析 `chat_id`。[`WhatsAppChatId`](../whatsapp/README.md) 按契约就是不透明的，因为地址空间由 WhatsApp 拥有并不断扩充，而追踪 WhatsApp 的 provider 已经在每段对话和每条消息上报告 `kind`。此处早先的一版曾按后缀给 id 分类并拒绝了 `…@lid`——那是 WhatsApp 用于一对一对话的关联身份空间，而真实账号刚刚通过 `whatsapp_list_chats` 把这个 id 交给了模型，于是文档中的 `list_chats` → `read_chat` 路径在自己的输出上失败，还断言该 id 不是 WhatsApp 地址。

因此每个工具都经由 `ctx.whatsapp.resolveChat()` 解析：由它判定对话的 kind、在本次连接观察过该对话时为其命名，并且只对根本没有指名任何对话的取值以 `WHATSAPP_UNKNOWN_CHAT` 拒绝。先解析也正是让已登出的账号在操作者被要求批准一次发送之前就失败的原因。

### `chat_id` 永远必填

`whatsapp_send_message` 不接受隐式收件人。没有「回复上一段对话」，没有会话级默认值，也不从对话历史推断——一个会话服务多段对话，因此默认目的地迟早会是错的人。工具描述用模型自己的语言这么说，schema 也把 `chat_id` 标为必填。

### 审批

发送是本包中唯一以操作者身份对网络采取行动的路径，因此 `whatsapp_send_message` 在派发前询问 `ctx.approval`。提示语先完整地指名目的地，然后引用正文（超过 200 个字符后省略）：

```text
send a WhatsApp message to Ana (5511999990000@s.whatsapp.net): "boa tarde, chego às 18h"
```

账号没有解析出显示名时，操作者要凭一串裸地址下判断，这读起来像是一个他们无法做出的决定。该情形直接说明这份缺失，而不是把数字装扮成能指认某个人的名字：

```text
send a WhatsApp message to an unnamed conversation at 5511999990000@s.whatsapp.net: "boa tarde"
```

除明确授予之外的每条路径，审批都以失败收场：拒绝、取消、通道不可用、组合中没有审批服务，以及没有 agent 的执行，都会让调用失败。`ctx.approval` 被刻意排除在 `inject` 之外，因此没有审批通道的组合仍会注册那些只读工具，只拒绝发送。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `listChats` | `true` | 注册 `whatsapp_list_chats`。 |
| `readChat` | `true` | 注册 `whatsapp_read_chat`。 |
| `markRead` | `true` | 注册 `whatsapp_mark_read`。 |
| `send` | `true` | 注册 `whatsapp_send_message`。 |
| `listChatsMaxResults` | `100` | 一次 `whatsapp_list_chats` 调用返回的对话数上限。 |
| `readChatDefaultLimit` | `20` | `whatsapp_read_chat` 未指定上限时的历史页大小。 |
| `readChatMaxLimit` | `100` | 一次 `whatsapp_read_chat` 调用返回的消息数上限。 |
| `sendMaxTextChars` | `4096` | 单条消息正文的字符数上限。 |
| `timeoutMs` | `30000` | 每个 WhatsApp 工具的协作式工具调用超时预算。 |

每个计数与字符上限都必须是正整数，且 `readChatDefaultLimit` 不得超过 `readChatMaxLimit`；违反会让插件加载失败，而不是在调用时被截断。解析后的上限会出现在模型读到的 schema 描述里，因此改动其一就会改动请求前缀。

```yaml
- id: tool-whatsapp
  name: '@deepseek-ai/dsh-tool-whatsapp'
  config:
    send: true
```

## 事件

一次确认的发送会在 provider 确认之后，向调用方 agent 的会话追加 `whatsapp/outbound`，因此日志绝不会声称一次被 WhatsApp 拒绝的发送。入站的一半由 [`dsh-whatsapp-workspace`](../whatsapp-workspace/README.md) 写入。

## 模型体验

### 工具 schema

#### 模型看到什么

四个生成的 [WhatsApp 工具 schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-whatsapp)。页大小上限与超时预算是部署设置，只作为参数描述里的文字出现，绝不作为模型参数。

#### Token 影响

已启用工具的每请求固定 schema 开销；配置关闭会整体移除一个 schema，而作用域限制只移除它的可见性。

#### KV Cache 影响

只要启用集合与解析后的上限不变，前缀就保持稳定。改动 `listChatsMaxResults`、`readChatDefaultLimit`、`readChatMaxLimit` 或 `sendMaxTextChars` 会重写某条参数描述，并可能从第一个改动的 schema token 起使复用失效。

### 对话列表

#### 模型看到什么

一行头部 `<shown> of <total> WhatsApp conversations:`，随后每段对话一行，形如 `- <name> [chat_id: <id>] <kind>, <count> unread`。账号未解析出名字的对话渲染为 `(unnamed)`，并在返回对象中省略 `name`，以便模型能把一段无名对话与一段真的以号码相称的对话区分开。空索引恰好是 `No WhatsApp conversations observed on this connection yet.`，它说明为什么为空，而不是暗示该账号没有对话。

#### Token 影响

取决于数据，并以 `listChatsMaxResults` 为界；结果会一直重发到压缩为止。

#### KV Cache 影响

仅追加；新出现的内容跟在可复用的请求前缀之后，不会使既有的 KV cache 条目失效。

### 对话历史

#### 模型看到什么

一行头部 `<count> message(s) in <name> [chat_id: <id>], newest first:`，随后每条消息一行，形如 `- <timestamp> <sender>: <body>`，其中账号自己的消息把发送者渲染为 `(you)`，seam 无法表示的媒体渲染为 `[unsupported media: <type>]`。空页恰好是 `No messages retained on this connection for <name> [chat_id: <id>]. The conversation is still writable.` 未解析出的名字在这里同样渲染为 `(unnamed)`，返回对象中也不含 `chat_name`。

#### Token 影响

取决于数据，并以解析后的页大小为界；结果会一直重发到压缩为止。

#### KV Cache 影响

仅追加；新出现的内容跟在可复用的请求前缀之后，不会使既有的 KV cache 条目失效。

### 发送结果

#### 模型看到什么

一次确认的发送恰好是 `Sent to <name> [chat_id: <id>] at <timestamp> (message_id: <id>).`。被拒绝的一次是一个指名同一目的地的错误结果，因此模型能把「用户说不」与「WhatsApp 拒绝了」区分开，不会盲目重试。

##### 审批拒绝

```markdown
Error: the user rejected sending this message to Ana (5511999990000@s.whatsapp.net)
Error: approval for sending to Ana (5511999990000@s.whatsapp.net) was cancelled
Error: whatsapp_send_message requires approval, but no approval channel is available
```

#### Token 影响

每次发送尝试一行短文本，保留到压缩为止。操作者审批期间的等待不消耗 token。

#### KV Cache 影响

仅追加；新出现的内容跟在可复用的请求前缀之后，不会使既有的 KV cache 条目失效。

### 参数与账号错误

#### 模型看到什么

取值错误恰好成为 `Error: invalid limit: expected an integer between 1 and <max>, got <value>`、`Error: invalid text: a WhatsApp message must carry a non-empty body` 或 `Error: invalid text: at most <max> characters (got <length>)`。没有指名任何对话的 `chat_id` 会浮现账号自己的 `WHATSAPP_UNKNOWN_CHAT` 消息，已登出或未注册的账号则浮现其 `WHATSAPP_NOT_ONLINE` / `WHATSAPP_PROVIDER_UNAVAILABLE` 消息。

#### Token 影响

只有失败的那次调用才会增加这些被保留的 token。

#### KV Cache 影响

仅追加；新出现的内容跟在可复用的请求前缀之后，不会使既有的 KV cache 条目失效。

## 已知限制与推迟的工作

- **只有文本** —— seam 承载文本，因此 `whatsapp_send_message` 只接受正文，别无其他。发送图片、文档或语音，以及读取超出 `[unsupported media: …]` 占位符的媒体，随 seam 自身的媒体支持一并推迟。
- **超界的 limit 会被拒绝，而不是截断** —— 返回比请求更少的消息在模型看来就像对话本来就那么短，因此该调用失败并指明上限。
- **审批按次进行，没有长期授权** —— 每次发送都会再问一次，因为被批准的决定是「这段文字发给这个人」，而不是「WhatsApp 一律放行」。按对话或按会话的授权需要自己的持久化策略，已推迟。
- **`whatsapp_list_chats` 不分页** —— 它返回 provider 报告的前 `listChatsMaxResults` 段对话，没有游标。对话数超过上限的账号，模型侧够不到列表尾部；至少 `total` 告诉了它列表被截断过。
- **没有持久名册** —— 由于 provider 的索引以连接为界，一个刚连接的进程能列出多少并不是模型可以指望的，模型只能寻址它已经持有 id 的对话。跨连接持久化的名册可以解决这一点，已推迟给拥有持久 WhatsApp 状态的包。
- **能被解析出来的地址不等于能到达的地址** —— `resolveChat` 会为本次连接从未观察过的地址作答，因此一个看似合理却写错的 id 会走到审批，只有在真正尝试发送时才被账号拒绝。挡在写错的 id 与陌生人之间的，是操作者审批提示中写明的收件人；当账号没有解析出名字时，提示写作 `an unnamed conversation at <id>`，于是「我不知道这是谁」是被说出来的，而不是被伪装成一个名字。
- **每段对话的 `unread_count` 是下界** —— provider 依据这次连接观察到的内容推导它，而不是依据 WhatsApp 自己的未读状态，因此它可能少报操作者手机上显示的数量。`total` 统计的是本次工具返回的条目，是精确的；`unread_only` 依据的是同一个近似计数器。
- **媒体占位符尚未在真实媒体上验证** —— `[unsupported media: <type>]` 由单元测试和无密钥快照覆盖，但还没有来自真实账号的图片、文档或语音抵达过它。
- **工具包已在真实账号上验证，组装出的 workspace 尚未** —— seam 包的维护者通过本包自己的组合方式（真实 `ToolRuntime`、真实 `ApprovalService`、处于开启轮次中的真实 `Session`），在一个真实配对账号上运行了全部四个工具，确认了 `whatsapp_list_chats`、一次普通发送、一次带 `quoted_message_id` 的发送、`whatsapp_read_chat`、`whatsapp_mark_read`，以及每次工具发送恰好一条 `whatsapp/outbound` 事件。把一条入站消息经 [`dsh-whatsapp-workspace`](../whatsapp-workspace/README.md) 路由成一次会话轮次尚未在真实条件下验证，因为那需要来自第三方而非账号本人的消息。
