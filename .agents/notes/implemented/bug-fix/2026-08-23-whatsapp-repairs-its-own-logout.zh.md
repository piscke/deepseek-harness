# Agent Note：已登出的 WhatsApp 连接自行丢弃凭据并重新配对

Status: implemented

[English](2026-08-23-whatsapp-repairs-its-own-logout.md) | 中文

## Problem

在手机上解除设备链接，是一个人结束 WhatsApp 配对的方式，也是这个 provider 的凭据最常见的失效途径。此后 WhatsApp 会以 `DisconnectReason.loggedOut`（401）关闭下一条连接，而 Baileys 仍把这套被拒绝的身份留在 `authDir` 中，于是之后的每次尝试都在以一台账号已不认识的设备登录。

provider 对这种关闭的回应是把自己标记为终止：状态 `logged-out`，不再重开，`available()` 在该进程余下的时间里都是 false。引发它的凭据仍留在磁盘上，因此重新加载只会复现同一个 401。唯一的出路是操作者找到 `authDir`、手工删除、再重启 —— 而 Web UI 中没有任何地方指出那个目录。设置区显示的是"已退出登录 …… 需要重新配对"，旁边却是一个永远不会出现的二维码。

## Decision

已登出的关闭对那套凭据是终止性的，对 provider 本身不是。

`BaileysProvider.handle()` 先上报携带关闭原因的 `logged-out` —— 操作者仍能看到连接为何结束 —— 随后执行 `repair()`：调用 `deps.forgetPairing()`，并通过原有的重连预算重新打开连接。下一条连接面对的是一个未配对的目录，于是 Baileys 发出二维码，状态机走 `logged-out → connecting → pairing`，这正是账号可以据以行动的状态。

`pairingForgetter(authDir)` 就是这一丢弃动作，它只删除 `useMultiFileAuthState` 写入的 `.json` 文件，保留目录本身以及其中的其他内容。若操作者把 `authDir` 指向了一个共享目录，无关内容绝不能因一次凭据重置而丢失。目录不存在时，本就已处于该丢弃动作所要求的状态。

让重开走 `retry()` 而非直接连接，是这个循环的边界所在：若某个账号不断拒绝新的配对，它会耗尽 `maxReconnectAttempts` 并以 `WHATSAPP_RECONNECT_EXHAUSTED` 停止，而不是永远地清除凭据。丢弃失败 —— 例如 `authDir` 不可写 —— 是致命的，报告 `WHATSAPP_PAIRING_NOT_DISCARDED`，因为那正是"手工删除目录"确实成为补救方式的唯一情形。

## Damaged credentials stay terminal

`WHATSAPP_AUTH_STATE_DAMAGED` 保持原有行为。被截断的 `creds.json` 是有歧义的：其背后的配对可能仍活在账号的已链接设备列表中，丢弃它就会抛弃一条可用的链接，并留下一个孤立条目。只有 WhatsApp 自己给出的 401 才能证明所存身份已死，也只有这一证明才授权删除它。

## Alternatives considered

**保持手工恢复，并把 `authDir` 写进文档。** 改动最小，且让每一次凭据删除都是操作者的行为。之所以被否决，是因为它保留下来的状态毫无用处：provider 无法连接、无法配对，也无法向展示它的界面报告任何可据以行动的信息。文档只会把一条死路描述得更精确。

**新增一个"重置配对"RPC 端点和设置区中的按钮。** 这是一个明确的动作，且出现在故障被展示的地方。之所以未被选作主要修复，是因为它要人去确认 WhatsApp 已经给出的那个结论；这次点击并不比 401 多出任何信息。作为在 `online` 时主动解除链接的手段，它仍然合理，但那是另一项能力，此处未构建。

**递归删除 `authDir`。** 比过滤更简单，也与 README 曾告诉操作者的做法一致。之所以被否决，是因为 `authDir` 由操作者配置：若某个取值指向的目录还存放着认证状态之外的内容，那些内容会被一并带走，而这种失败既无声又不可恢复。

**把该行为做成 `Config` 开关。** 被否决，因为不存在"保留已死凭据更好"的部署 —— 不重新配对的另一种结果，是根本连不上。

## Consequences

seam 的 `logged-out` 状态含义发生变化：对它所报告的那套凭据仍不可恢复，但它不再是一个 provider 生命的终点。`WhatsAppStatus`、子系统文档与设置区文案都已如此陈述，且 `available()` 现在会跨越一次登出保持为 true。

一次已登出的关闭会不经询问地删除凭据。这是自动路径上新增的破坏性行为，其边界正是上文两点：只有 401 会触发它，且只有认证状态文件会被删除。

## Testing

provider 测试在 socket 替身之上驱动整条路径 —— 丢弃、重开，以及随之而来的二维码 —— 还包括致命的丢弃失败，以及正落在丢弃过程中的一次销毁。socket 测试针对真实临时目录检验 `pairingForgetter`，涵盖它必须保留的非认证文件与必须容忍的不存在目录。Baileys 绑定本身仍在 CI 之外，因此真实的 401 关闭只能靠人工确认。
