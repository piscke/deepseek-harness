# @deepseek-ai/dsh-whatsapp-baileys

[English](README.md) | 中文

面向 harness [WhatsApp 能力 seam](../whatsapp/README.md)（`ctx.whatsapp`）的 `WhatsAppProvider`，由一条连接个人 WhatsApp 账号的 [Baileys](https://github.com/WhiskeySockets/Baileys) 连接支撑。

这是**实现**包：它向 `ctx.whatsapp` 注册一个 provider，既不拥有该键，也不注册任何面向模型的工具。它是 function/namespace 插件（`inject: ['whatsapp']`）。

## Baileys 不是依赖

`baileys` 不出现在本包清单的任何字段中，安装本包也不会带来它的任何内容。Baileys 会传递依赖到 `libsignal`，后者采用 GPL-3.0 并从 git 仓库解析；本仓库是 MIT，其 pnpm 策略直接拒绝 git 解析的传递依赖（`ERR_PNPM_EXOTIC_SUBDEP`），通过可选 peer 也一样，因为 peer 仍会在安装时解析。

部署方自行安装 Baileys 并通过 `moduleSpecifier` 指明它；本包在首次连接时用动态 `import()` 加载它。接受 Baileys 许可证与账号封禁风险的位置，就是那次安装。

```sh
pnpm add baileys   # in the deployment, not in this repository
```

缺少它时，连接失败于 `WHATSAPP_BAILEYS_MISSING`，provider 将自身标记为终止，并且不再尝试重连 —— 没有任何重试能安装一个包。此时 `ctx.whatsapp` 上报 `offline`，每个操作都失败于 `WHATSAPP_PROVIDER_UNAVAILABLE`。

由于 Baileys 不在仓库中，这里的一切改为针对 `WhatsAppSocket` 端口固定下来：状态机、重连策略、消息规范化与对话索引都由基于 socket 替身的测试覆盖。与真实库的绑定只由人工验证，如今一个真实账号已确认本包提供的每一项操作 —— 连接、二维码、`online`、入站消息、凭据复用重连、`send`、引用回复、带 `before` 的 `fetchMessages` 以及 `markRead`。

## 连接

provider 拥有一条连接的生命周期。它在插件加载时立即打开，并通过 `status()` 与 `whatsapp/status` 上报进展：先 `connecting`，再是携带人工扫描 QR 负载的 `pairing`，随后是带账号 id 的 `online`。意外关闭会在 `reconnectDelay` 之后重开，直到连续 `maxReconnectAttempts` 次尝试耗尽，此后 provider 停止并报告 `WHATSAPP_RECONNECT_EXHAUSTED`。已登出导致的关闭是终止性的：凭据已失效，因此直接进入 `logged-out` 而不重试。

拆解顺序为 LIFO —— 连接先于注册被撤回而关闭，因此不会有任何调用派发到正在关闭的 socket 上。

auth state 是可变的多文件目录（`authDir`），而非凭据引用。它使已配对账号无需重新扫码即可恢复；它授予对账号的完全访问权限，必须留在 git 之外。

Baileys 在每次凭据更新时就地重写 `creds.json`，因此进程在写入中途被杀死、或两个进程共用同一目录，都会留下被截断的文件 —— 而 Baileys 自身会把它读作"没有凭据"，并以注册新设备作答，从而悄悄丢弃原有配对，并在账号的已链接设备列表中留下一个孤立条目。因此 provider 拒绝在无法解析的凭据文件上连接，报告 `WHATSAPP_AUTH_STATE_DAMAGED` 并指明该文件，使这一损失可见，而不是伪装成一个新的二维码。恢复需手动进行：删除该目录并重新配对。

## 对话

Baileys 不提供 message store，因此 `listChats` 与 `fetchMessages` 只回答**本连接自加载以来观察到的内容**：重启会丢弃索引，随后随消息到达而增长。它在连接时并不必然为空，因为 WhatsApp 会在握手期间重放离线流量。`listChats` 按最新观察到的消息排序；`fetchMessages` 返回最新在前，并用 `before` 翻页。本连接从未观察过的对话失败于 `WHATSAPP_UNKNOWN_CHAT`，而不是返回空页，因为空页与未知地址是两个不同的答案。每个对话的保留量以 `historyPerChat` 为上限，最旧者先被逐出。

除非消息带有 id、对话地址以及由人撰写的内容，否则一律丢弃。`messageContextInfo` 与 `senderKeyDistributionMessage` 描述的是投递而非内容，`protocolMessage` 属于撤回、历史同步通知一类的事务性帧；仅含这些字段的信封会被丢弃，而当它们伴随真实内容出现时会被跳过，使上报的类型指向载荷本身，而不是恰好最先解码的那个字段。seam 无法表示的媒体变为带媒体类型的 `unsupported`，使消费者仍能看到确有内容到达。

## Config

| 键 | 默认值 | 含义 |
|---|---|---|
| `moduleSpecifier` | `baileys` | 部署方所安装的 Baileys 库的模块说明符。 |
| `authDir` | `.dsh/whatsapp/auth` | 存放多文件 auth state 的目录，用于恢复已配对账号。 |
| `deviceName` | `DeepSeek Harness` | 在 WhatsApp 已关联设备列表中显示的名称。 |
| `reconnectDelay` | `5000` | 重开意外关闭的连接前等待的毫秒数。 |
| `maxReconnectAttempts` | `5` | 放弃并等待插件重新加载之前的连续重开尝试次数。 |
| `historyPerChat` | `200` | 每个对话为 `fetchMessages` 保留的消息数。 |

`reconnectDelay` 与 `historyPerChat` 必须是正的有限数，`maxReconnectAttempts` 必须是非负整数（`0` 确实表示“永不重连”）；无效值会在插件构造时抛出，而不是产出一个静默永不重连的 provider。

## 模型体验

通过把这些对话呈现给模型的消费者间接影响；本包不注册任何工具、提示词或 schema，而这样的消费者会把私人消息发送给 LLM 供应商并写入会话日志。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由消费方负责。

## 已知限制与暂缓事项

- **Baileys 绑定不在 CI 内** —— 每个自动化测试都驱动 socket 替身，且一个真实账号已人工确认每一项操作。该库为非官方逆向工程实现，WhatsApp 可能随时封禁号码或使客户端失效；请使用专用测试号码。
- **每个 `authDir` 只允许一个进程** —— WhatsApp 会替换既有的已链接设备会话，因此第二个进程打开同一份凭据会以 `conflict` 流错误关闭第一个，而两个互不同步的凭据写入方还可能把文件写成截断状态，导致配对丢失。目前没有任何机制强制这种独占；对该目录加建议锁属于待办工作。请为每条连接分配各自的目录。
- **`listChats` 只报告本连接观察到的内容** —— 索引由观察到的事件构建，从不来自名册拉取，因此不含进程未见过的对话。它在连接时并不必然为空：WhatsApp 会在握手期间重放离线流量，已配对账号曾在首次调用时就报告出对话。消费者既不能假定索引为空，也不能假定它完整；需要持久性时自行保存名册。
- **对话 id 不透明，且未必是电话号码** —— WhatsApp 通过不止一个域为一对一对话编址；已观察到线上账号将一个具名对话报告为 `<id>@lid`，即其链接身份地址空间，此外还存在 `@newsletter` 与 `@broadcast`。本 provider 将 `@g.us` 视为群组域，其余一律视为一对一，因此新增地址空间会退化为可用的分类而非报错。消费者必须把 `WhatsAppChatId` 当作不透明值：用封闭的后缀集合去解析它，会拒绝本 provider 合法报告的地址。
- **解密失败的消息被静默丢失** —— 对于无法解密的帧，Baileys 报告 `Bad MAC` 或 `No matching sessions found for message`，通常来自本连接缺少其 Signal 会话的设备。此类帧永远不会成为 `whatsapp/message-received`，且 seam 没有表示该丢失的事件，因此统计消息数的消费者会看到一个自己无法察觉的缺口。
- **历史仅存在于进程内** —— 重启会丢失对话索引，重连时的历史回放会重复消费者已见过的消息 id。必须只处理一次的消费者要自行保存已处理 id 集合。
- **群名在被观察到之前缺失** —— 对话显示名派生自入站直聊消息上的 `pushName`，因此群主题在连接观察到之前一直无法解析。
- **仅文本、无在线状态** —— 发送媒体、下载媒体、输入指示与送达回执均属推迟的工作。
- **`unreadCount` 统计的是本连接观察到的内容**，而非 WhatsApp 自身的未读状态；`markRead` 在账号上清除未读，而不是在本索引中清除。
