# Agent Note: 以运行时说明符加载 Baileys，而不依赖它

Status: implemented

[English](2026-08-21-baileys-runtime-specifier.md) | 中文

## 问题

WhatsApp provider 需要 Baileys —— 唯一仍在维护、可连接个人 WhatsApp 账号的客户端。Baileys 传递依赖到 `libsignal`，后者采用 GPL-3.0，并且在避开原生插件的那条版本线上从 git URL 解析。本仓库是 MIT，其 pnpm 策略拒绝 git 解析的传递依赖（`ERR_PNPM_EXOTIC_SUBDEP`）。把 Baileys 声明为可选 peer 并不能避开这一点：peer 在安装时解析，因此无论是否需要 WhatsApp，工作区中每个人的安装都会失败。把一个 GPL 库 vendoring 进 MIT 发行物则更糟。

除许可证之外，非官方逆向工程客户端还是每个工作区成员都要背负的负担：WhatsApp 一变它就失效，并且可能导致所连号码被封。没有人应当因为运行 `pnpm install` 而继承这些。

## 决策

`@deepseek-ai/dsh-whatsapp-baileys` 在任何清单字段中都不提及 `baileys`。部署方自行安装它，并通过插件的 `moduleSpecifier` 配置（默认 `'baileys'`）指明；`loadBaileys()` 在 provider 首次连接时用动态 `import()` 解析它。该库的表面在 `src/socket.ts` —— 唯一接触它的模块 —— 中以本地结构化接口声明，因此本包在库不存在时仍能通过类型检查并发布。

库缺失是一个正常且具名的结果：`WhatsAppError`，code 为 `WHATSAPP_BAILEYS_MISSING`，并附安装指引。provider 将自身标记为终止且不再重连，因为没有任何重试能安装一个包。此时 `ctx.whatsapp` 上报 `offline`，每个操作都失败于 `WHATSAPP_PROVIDER_UNAVAILABLE`。

由于该库不在仓库中，测试改为针对 `WhatsAppSocket` 端口而非 Baileys 固定 provider：状态机、重连预算、消息规范化与对话索引均由 socket 替身覆盖。绑定后来在真实账号上跑通，确认了 provider 提供的每一项操作，包 README 写明哪些覆盖来自自动化、哪些来自人工。

## 曾考虑的替代方案

**把 `baileys` 声明为可选 peer 依赖。** 这是原本设想的形态，也是最先尝试的做法。pnpm 在安装期间解析 peer，因此无论 `peerDependenciesMeta.optional` 如何，`ERR_PNPM_EXOTIC_SUBDEP` 都会对整个工作区触发。它同样会在 MIT 仓库的 lockfile 中留下一个 GPL-3.0 包。

**使用 `baileys@7`，其 `libsignal` 来自 npm。** 它消除了 git 解析，却向运行平台矩阵 CI 的仓库引入原生插件 `whatsapp-rust-bridge` —— 用一个预发布的原生依赖换掉一个许可证问题，而 GPL 的可达性依然存在。

**在 `vendor/` 下 vendoring Baileys。** vendoring 流程面向仓库愿意拥有并做许可证核查的固定源码副本。GPL-3.0 的逆向工程客户端恰恰是 MIT 发行物不能携带的源码，而维护成本正是使用该库的初衷所要避免的。

**把 provider 放进 `packages/experimental/`。** 实验性放置改变的是发布过滤，而非安装：依赖仍会为每个工作区成员解析。它还错误地标注了这个 seam —— 该 seam 本身平常且完整。

**在进程外与 Baileys 通信**（由部署方启动的 worker 或 sidecar）。这会把许可证隔离在进程边界之外，并且在进程内拆解被证明不可靠时仍然可用；但它为一项动态 `import()` 已能挡在清单之外的绑定，额外引入了一套协议与进程生命周期。

## 后果

仓库保持 MIT，lockfile 中没有 GPL 包，而从不启用 WhatsApp 的成员在 `pnpm install` 上不付出任何代价。接受 Baileys 许可证与封号风险的位置是那次安装，而这正是该决定应有的归属。

代价是一个类型上的空洞。Baileys 的表面由手写结构化接口描述，因此库的变更会在运行时而非 `tsc` 处崩溃，也没有任何 gate 会注意到被重命名的事件或选项。这个空洞并非假想：手写的 `sendMessage` 签名把被引用的消息声明为仅其 key，它通过了类型检查，也通过了断言引用 id 的测试，却在第一条真实的引用回复上于库内部崩溃 —— 因为 Baileys 会读取被引用消息自身的内容。`WHATSAPP_BAILEYS_MISSING` 与 README 承载了编译器无法承载的部分。同样的缺席也意味着：provider 的首次真实配对就是它的首次真实测试。

这一模式可推广到任何 harness 包无法合法或安全地替所有人安装的 peer：让它不出现在任何清单字段中，通过校验过的配置指明它，动态加载它，并带着安装指引大声失败 —— 绝不静默降级。
