# WhatsApp 助手

[English](README.md) | 中文

本覆盖层让一个 `dsh web` 进程成为 WhatsApp 助手：账号被链接到 Harness，收到的消息以 Session 形式出现在 `WhatsApp` 工作区中，Agent 起草回复，发送前由你批准。

```sh
DSH_WHATSAPP_BAILEYS=file:///abs/path/to/wa-deps/node_modules/baileys/lib/index.js \
  dsh web --patch examples/whatsapp-assistant/cordis.yml
```

它组合了能力接缝、Baileys 提供方、按 `category` 路由的工作区路由器，以及四个面向模型的工具。审批、工作区侧边栏与 Session 视图都是 Web 已有的界面；本覆盖层不新增任何 UI。

## 自行安装 Baileys

该库不是本仓库的依赖，也不得被加为依赖。它会引入 `libsignal`——GPL-3.0 许可且从 git 解析——而本仓库为 MIT 许可，其 pnpm 策略会直接拒绝从 git 解析的传递依赖（`ERR_PNPM_EXOTIC_SUBDEP`），即使经由可选 peer 也一样，因为 peer 在安装期仍会被解析。请把它装在本工作区之外的目录里：

```sh
mkdir -p ~/wa-deps && cd ~/wa-deps
npm install baileys@^6.7.24
```

然后在 `DSH_WHATSAPP_BAILEYS` 中指明该安装位置。该值是传给动态 `import()` 的模块说明符，因此请使用 `file:` URL 而非文件系统路径；裸写 `baileys` 仅在该说明符能从 Harness 自身解析时才有效。若解析不到安装，提供方会以 `WHATSAPP_BAILEYS_MISSING` 失败并保持停机：任何重连都不可能装上一个包。

## 配对账号，每个进程一次

覆盖层把凭据目录固定为 `$DSH_HOME/whatsapp/auth`。启动进程，打开任一 WhatsApp Session 的会话日志，用 WhatsApp 应用的「链接设备」界面扫描二维码。未被扫描前二维码会不断轮换。

WhatsApp 每个链接设备只允许一个连接，且新连接会*替换*旧连接。因此第二个进程使用同一凭据目录会以 `conflict` 流错误杀死第一个，两者随后争夺该账号。由于目录跟随 `DSH_HOME`，需要记住的规则是：**每个 `DSH_HOME` 只跑一个 `dsh web`。** 第二个账号请用第二个 `DSH_HOME`，绝不要用第二个进程对着同一个。

## 操作者看到什么

路由器在 `WhatsApp` 工作区中创建两个常驻 Session——`Groups` 与 `Contacts`——并把每条收到的消息排入与其聊天相匹配的那个。一个 Session 服务于许多会话，因此每个路由进来的轮次都会写明其聊天，发送的审批提示同样如此：批准前请核对目的地，因为聊天是由 Agent 选择的。

Agent 通过 `whatsapp_list_chats`、`whatsapp_read_chat`、`whatsapp_mark_read` 与 `whatsapp_send_message` 读写。只有发送需要审批，读取不需要。

## 依赖它之前值得知道的限制

- 聊天索引只保存*本次连接*观察到的内容。它在重启时被丢弃，也不是通讯录：空列表意味着尚未观察到任何内容。它在连接时也未必为空，因为 WhatsApp 会在握手期间重放离线流量。
- `unreadCount` 计的是本次连接观察到的数量，而非 WhatsApp 自身的未读状态。
- 在连接观察到某个群的消息之前，该群的显示名常常是缺失的。
- 每条路由进来的消息都会发送给所配置的 LLM 提供方并写入 Session 日志。请把该进程、它的 `DSH_HOME` 及其日志视作与账号所在手机同等敏感。
