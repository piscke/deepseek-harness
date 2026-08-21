# Agent Note：可运行的 WhatsApp 助手示例

Status: implemented

[English](2026-08-23-whatsapp-assistant-example.md) | 中文

## 问题

WhatsApp 能力接缝、它的 Baileys 提供方、工作区路由器，以及面向模型的工具套件各自都带着自己的测试交付，但没有任何东西把它们组合起来。驱动真实账号的唯一途径是一个一次性脚本，因此该功能既没有面向操作者的形态，也没有任何组装证据证明这四个包能作为一个助手协同工作。

有两条约束让这次组合不同寻常。`baileys` 完全不能成为本仓库的依赖：它会引入 `libsignal`——GPL-3.0 许可且从 git 解析——而本仓库为 MIT 许可，其 pnpm 策略会拒绝从 git 解析的传递依赖（`ERR_PNPM_EXOTIC_SUBDEP`），即使经由可选 peer 也一样，因为 peer 在安装期仍会被解析。而且 WhatsApp 每个链接设备只允许一个连接并会替换旧连接，因此两个共享凭据目录的进程会以 `conflict` 流错误互相关闭。

## 决定

[`examples/whatsapp-assistant`](../../../../examples/whatsapp-assistant/README.md) 是覆盖在已发布 `web` profile 之上的 patch overlay，沿用 `examples/web-schedule` 的形态。它插入四行——接缝、Baileys 提供方、按 `category` 路由的工作区路由器，以及工具套件——并且不新增任何 UI：审批、工作区侧边栏与 Session 视图都是 Web profile 已经提供的界面。默认 Web 树保持不变。

覆盖层作出了两项提供方默认值未决定的选择。

`authDir` 被固定为 `dshHomePath('whatsapp', 'auth')` 而非提供方相对 cwd 的默认值，路由器的 `directory` 也被固定为 `dshHomePath('whatsapp', 'chats')` 而非其 `~/.dsh/whatsapp` 默认值。「只允许一个连接」这条规则依附于凭据目录，而相对 cwd 的默认值会让冲突取决于操作者恰好在哪里启动 `dsh`；一个忽略 `DSH_HOME` 的路由器默认值则会在凭据已经搬走之后，把第二个账号的会话留在第一个账号的目录里。锚定到 Harness home 之后，操作者需要遵守的规则就变成「每个 `DSH_HOME` 只跑一个 `dsh web`」，这一点无需了解链接设备也能核对。

`moduleSpecifier` 读取 `DSH_WHATSAPP_BAILEYS`，默认为裸写的 `baileys`。该库由操作者安装在本工作区之外，因此组合必须接受一个绝对位置；该值会被传给动态 `import()`，这也是 README 要求使用 `file:` URL 而非文件系统路径的原因。无法解析的库对应具名结果 `WHATSAPP_BAILEYS_MISSING`（[运行时说明符](../architecture/2026-08-21-baileys-runtime-specifier.md)）。

工具套件是 host 层的一行，而不是 agent preset 的一行。Web profile 已把面向模型的工具移到 preset 之后，而带作用域的工具注册是遮蔽全局注册而非隐藏它，因此一行全局注册即可抵达每个 session 所组合的任何 preset——包括操作者之后新增的 preset。

## 考虑过的替代方案

**以 bundle 或 profile 默认值的形式发布该组合。** 否决：该助手会链接一个私人账号，把每条被路由的消息发送给所配置的 LLM 提供方，并写入 Session 日志。这必须是显式的 opt-in，而 overlay 正是本仓库已有的表达形式。

**把 `baileys` 声明为可选 peer 依赖，好让 manifest 记录它。** 否决：pnpm 在安装期解析 peer，因此那个从 git 解析的 GPL-3.0 子依赖仍会到来，所有人的安装都会失败。缺失改为在运行时处理，并新增测试断言仓库中没有任何 manifest 声明它。

**通过在组合测试中启动覆盖层来验证它。** 工作区路由器在 `apply` 期间就打开其常驻 session，因此启动需要真实的 agent factory，而后者需要模型。说明符解析已由 `verify-cordis-config` 证明，路由行为已由路由器自身的服务级测试证明，因此新增测试固定的是两者都未覆盖的内容：覆盖层的操作者契约与许可证约束。

## 验证

`apps/cli/tests/whatsapp-assistant-config.spec.ts` 解析已签入的覆盖层，固定所组合的行、`category` 路由、被固定的 `authDir`、由环境变量命名的模块说明符，以及不含任何凭据材料。它还会遍历仓库中每个 `package.json`，若任一依赖字段声明了 `baileys` 则失败，从而把许可证约束从评审惯例变成一道被执行的关卡。

`pnpm run verify-cordis-config` 会从 `apps/cli` 解析全部四个裸包说明符，这正是把它们加入该 manifest、并把覆盖层加入 `appOverlayFiles` 的原因。

## 影响

已完成配对的操作者今天就拥有一个可用的助手，而下层的这些包也终于有了可供演示的组装形态。该覆盖层同时是 Web 面板所扩展的组合：面板的行被插入到这同一个文件，而不是已发布的 bundle。

安装 Baileys 仍然是操作者自己的步骤，并且会持续困扰那些认为 `pnpm install` 就够了的人。README 在失败发生的地方说明了许可证原因，`WHATSAPP_BAILEYS_MISSING` 则在运行时再次点明。
