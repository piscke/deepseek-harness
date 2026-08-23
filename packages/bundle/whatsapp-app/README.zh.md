# `@deepseek-ai/dsh-whatsapp-app`

[English](README.md) | 中文

dsh 的 WhatsApp 助手 bundle。[`cordis.patch.yml`](cordis.patch.yml) 覆盖在 [`dsh-web-app`](../web-app/README.md) 之上：它插入[能力 seam](../../whatsapp/whatsapp/README.md)、把凭据放在 harness home 下的 [Baileys provider](../../whatsapp/whatsapp-baileys/README.md)、按 `category` 路由的[工作区路由器](../../whatsapp/whatsapp-workspace/README.md)、[四个面向模型的工具](../../whatsapp/tool-whatsapp/README.md)，以及[为账号配对的设置页](../../client/ui-settings-whatsapp/README.md)。除此之外不新增任何 UI：审批、工作区侧边栏与 Session 视图都是 Web profile 已经提供的界面。本 bundle 自身不挂载任何插件。

`whatsapp` profile 就是这一层叠加在 Web profile 之上，`dsh whatsapp` 是它的别名：

```sh
dsh plugin --profile whatsapp add baileys   # once
dsh whatsapp
```

## 把 Baileys 安装进 profile

Baileys 不是本仓库的依赖，也不得被加为依赖：它会传递依赖到 `libsignal`，后者采用 GPL-3.0 而本仓库是 MIT，且 `6.x` 线从 git 解析它，pnpm 会拒绝这种子依赖（`ERR_PNPM_EXOTIC_SUBDEP`），通过可选 peer 也一样。`dsh plugin --profile whatsapp add baileys` 会把它安装进 `$DSH_HOME/profiles/whatsapp/` —— 一个独立的项目，接受该许可证与账号封禁风险的位置正是这里。registry 上以 `latest` 提供的 `7.x` 线可原样安装于此。

patch 通过 `configModulePath('baileys')` 解析这次安装，它读取所启动 profile 自己的 `node_modules`（[`dsh-app-boot`](../../boot/app-boot/README.md)）。优先级由高到低：供操作者显式指明安装位置的 `DSH_WHATSAPP_BAILEYS`、profile 自身的依赖，然后是裸名 `baileys` —— 后者只在库位于 harness 安装本体中时才解析得到。

没有可解析的安装时，provider 失败于 `WHATSAPP_BAILEYS_MISSING` 并保持停止——没有任何重连能安装一个包——而 harness 的其余部分照常启动，设置 › WhatsApp 会上报该状态。

## 配对账号，每个进程一次

patch 把凭据目录固定在 `$DSH_HOME/whatsapp/auth`，把路由后的对话固定在 `$DSH_HOME/whatsapp/chats`；两者的默认值本来分别相对于 cwd 与 `~`，会让第二个账号被拆到两个 home 中。启动进程，在该机器的浏览器中打开**设置 › WhatsApp**，用 WhatsApp 应用的已关联设备界面扫描二维码。该页面跟随连接状态，并在二维码轮换时替换它。

该页面只应答回环浏览器，且是刻意如此：扫码者链接的设备拥有账号的完全访问权限，因此该二维码就是凭据，只留在运行 harness 的机器上。从网络中其他位置访问服务器的浏览器，会发现该页面根本读不到状态。

WhatsApp 每个已链接设备只允许一条连接，而新连接会**替换**旧连接。因此在同一凭据目录上的第二个进程会以 `conflict` 流错误杀掉第一个，两者随后争夺账号。由于两个目录都跟随 `DSH_HOME`，需要记住的规则是：**每个 `DSH_HOME` 只运行一个 WhatsApp harness。** 第二个账号请从第二个 `DSH_HOME` 运行，绝不要用第二个进程对着同一个 home；它是第二台已链接设备，需要自己的扫码。

出于同样的原因，请把这一层保留在 `whatsapp` profile 中，而不要放进每个 profile 都会继承的 home 级 `$DSH_HOME/cordis.patch.yml`：任何第二个携带该 provider 的 profile 都会对同一份凭据打开自己的连接，并从第一个那里夺走账号。

## 操作者看到什么

路由器在 `WhatsApp` 工作区中创建两个常驻 Session —— `Groups` 与 `Contacts` —— 并把每条收到的消息排入与其对话相匹配的那个。一个 Session 服务多个对话，因此每个被路由的回合都会指明它的对话，发送的审批提示同样如此：批准前请核对目的地，因为目的地由 Agent 选择。

## 模型体验

通过插入的行间接产生影响：工具套件拥有 `whatsapp_list_chats`、`whatsapp_read_chat`、`whatsapp_mark_read` 与 `whatsapp_send_message`，其中只有发送需要审批；该 bundle 自身不贡献任何模型可见文本。

#### KV Cache 影响

无直接影响；每条插入行的影响由其所属的包负责。

## 已知限制与暂缓事项

- **每条被路由的消息都会到达 LLM 供应商与 Session 日志** —— 请把该进程、它的 `DSH_HOME` 及其日志，视为与账号所在手机同等敏感。
- **聊天索引只保存本连接观察到的内容** —— 它在重启时被丢弃，且不是名册，因此空列表只表示尚未观察到任何内容。它在连接时也并不必然为空，因为 WhatsApp 会在握手期间重放离线流量。`unreadCount` 统计的是同一批观察结果，而非 WhatsApp 自身的未读状态；群组显示名往往要等到它的某条消息到达后才出现。
- **Baileys 绑定不在 CI 内** —— provider 的测试驱动 socket 替身，本 bundle 的测试解析 patch。组合后的连接由人工对着真实账号确认；请使用专用测试号码，因为该库为非官方实现，WhatsApp 可能随时封禁它或使客户端失效。
