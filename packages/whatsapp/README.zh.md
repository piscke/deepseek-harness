# whatsapp/ — WhatsApp 能力族

[English](README.md) | 中文

本能力族将 harness 接入一个 WhatsApp 账号，使会话能够读取对话并在人工批准下回复。

| 包 | 角色 | ctx 键 |
|---|---|---|
| [`whatsapp/`](whatsapp/README.md) | 定义连接状态、对话、消息、发送以及 provider 槽位 | `ctx.whatsapp` |
| [`whatsapp-baileys/`](whatsapp-baileys/README.md) | 通过 Baileys 库连接一个账号 | 注册到 `ctx.whatsapp` |

一个 WhatsApp 账号是一条长期存在的已认证连接，而非按请求使用的凭据，因此该 seam 把状态作为能力的一部分上报，并且在账号未在线时拒绝每一个操作。

Baileys 是非官方的逆向工程客户端，且**不是本仓库的依赖**：其传递依赖 `libsignal` 采用 GPL-3.0 并从 git 仓库解析，供应链策略直接拒绝。部署方自行安装，该安装行为即表示接受 Baileys 的许可证及其账号封禁风险。请使用专用号码。[运行时说明符决定](../../.agents/notes/implemented/architecture/2026-08-21-baileys-runtime-specifier.md)记录了它的代价。

模型从对话中读到的一切都会到达 LLM 供应商和会话日志。对于私人消息，这是一项有意的隐私取舍，两个包的 README 中都会重申。
