# @deepseek-ai/dsh-client-ui-settings-whatsapp

[English](README.md) | 中文

Web 设置中的 **WhatsApp** 页面，以及为它供数的 Host 通道。两半放在同一个包里，是因为它们共用同一套线上词汇：通道名、端点名，以及把 JSON 负载还原为 [`whatsapp`](../../whatsapp/whatsapp/README.md) 能力接缝 `WhatsAppStatus` 联合类型的解码函数。

Host 半边 inject `connection` 与 `whatsapp`，以 `authority: 'loopback'` 注册 `/whatsapp`；其唯一的 `status` 端点返回 `ctx.whatsapp.status()`，其他端点一律返回 `bad-request`。loopback 授权正是本包存在的理由：`pairing` 状态携带的是凭据——扫码者会把一台设备链接到该账号并取得完全访问权——因此它只到达运行 harness 那台机器上的浏览器。转发 Host 事件会广播给每一个已连接的浏览器，而 Typert `/api` 平面只为受信任主机注册一次，两者都无法为一个可选特性表达这道围栏。

浏览器半边注册一个 id 为 `whatsapp`、order 为 25 的本地化 `settings.section` 贡献，位于“模型”与“插件”之后。插件激活期间不读取状态：页面挂载后才调用 `status`，并在页面打开期间每两秒重读一次，因为 Baileys 会以秒级节奏替换配对码，过期的码无法扫描。页面在封闭的状态联合上分派——离线、连接中、配对中（二维码、轮换提示，以及“扫码即链接设备”的警告）、在线（提供方报告了账号 id 时展示）、已登出（提供方给出的原因）——并以 `assertNever` 收尾。加载、失败与重试都只属于已挂载的组件。注册通过 `ctx.slots.inject()` 完成，因此能跟随分区 slot 的延迟声明、重新声明、本地化变化与 teardown，而无需 import 设置外壳。

组合本包本身就创建了该页面，因此它的存在即是能力检查：没有 WhatsApp 的 harness 不会显示 WhatsApp 页面，而不是显示一个空页面。[`examples/whatsapp-assistant`](../../../examples/whatsapp-assistant/README.md) 负责插入这一行。

## 模型体验

无，因为本包只在浏览器设置中渲染 Host 拥有的连接状态，不注册任何模型接口。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **只读** —— 页面展示状态并完成配对。解除链接、强制重连与账号命名属于同一界面后续的改动。
- **轮询而非推送** —— 这是 loopback 围栏的直接结果。把二维码推送到局域网浏览器，是关于“谁可以看到凭据”的又一次明确决定，而不是传输层的改良。
- **配对无法在 CI 中演练** —— 真实配对码需要运维方自行安装的 Baileys 与一部手机。fixture 传输会提供每一个状态分支，因此无需账号即可验证页面；扫码本身仍是手动步骤。
