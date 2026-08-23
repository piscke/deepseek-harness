# Agent Note: 把 WhatsApp 变成一等的 profile

Status: implemented

[English](2026-08-25-whatsapp-profile-bundle.md) | 中文

## 问题

启动这个助手，每次都要作出三项彼此协调的决定：把 Baileys 安装到工作区之外的某处、在 `DSH_WHATSAPP_BAILEYS` 中写出那个位置，再给 `dsh web` 传入 `--patch examples/whatsapp-assistant/cordis.yml`。这是演示的形态。而一套**目的就是** WhatsApp 助手的安装，要永远重复这三项，其中任何一项都可能被遗忘或拼错，从而启动出一个没有该能力的 Harness。

[示例覆盖层](../../archived/feature/2026-08-23-whatsapp-assistant-example.md)是刻意选择那种形态的：它否决了 bundle，因为链接私人账号必须保持为显式的 opt-in。opt-in 这条理由成立，但结论并不由它推出。覆盖层把 opt-in 的代价从一次性变成了每次调用一次，而且它把库的位置完全留在组合之外，那里没有任何东西能解析它。

## 决定

组合是一个 bundle，安装形态是一个 profile，而库是那个 profile 的依赖：

```sh
dsh plugin --profile whatsapp add baileys   # once
dsh whatsapp                                # always
```

[`@deepseek-ai/dsh-whatsapp-app`](../../../../packages/bundle/whatsapp-app/README.md) 是叠加在 `dsh-web-app` 之上的 patch-only bundle，承载覆盖层原有的五行，`authDir` 与路由器 `directory` 仍是同样的 `dshHomePath` 锚点，工具仍是同一行 host 层注册。`PROFILE_TEMPLATES.whatsapp` 列出 `base`、`web-app` 与它，因此该 profile 在首次使用时自行初始化；`dsh whatsapp` 是 `dsh --profile whatsapp` 的别名，通过同一处 `addProfileAlias` 注册，与 `dsh web` 共享全部标志与拒绝行为。

opt-in 并没有被削弱，只是换了位置：从重复两个标志加一个环境变量，变成选择一个 profile。bundle 自身不挂载任何插件，`dsh web` 与默认树保持不变，只有列出该 bundle 的 profile 才会组合它。

### 解析操作者的安装

`dsh plugin --profile whatsapp add baileys` 安装到 `$DSH_HOME/profiles/whatsapp/`，那是一个独立的 pnpm 项目。本仓库的 manifest 依旧不含 `baileys`——遍历每个 `package.json` 的测试仍在执行这一点——因此那个从 git 解析的 GPL-3.0 子依赖永远不会进入这里的 `pnpm install`，许可证与账号封禁风险由操作者在他自己接受它们的地方接受。

树外安装留下的未决部分是解析：提供方的 `import()` 从 dsh 安装目录出发，永远看不到该 profile 的 `node_modules`。因此 `boot()` 在 `dshHomePath` 之外，再向 `!!js` 表达式提供第二个辅助函数。`configModulePath(specifier)` 以**根配置所在目录**为起点解析——在 profile 启动中即该 profile 目录——使用 `createRequire`，并返回一个 `file:` URL（用 `pathToFileURL`，因为 Windows 路径不是合法的 import 说明符），未安装时返回 `undefined`。它以配置而非 profile 命名，是因为 `boot()` 根本不知道 profile 的存在；配置所在目录才是真正的锚点。

该 patch 写作 `!!js process.env.DSH_WHATSAPP_BAILEYS ?? configModulePath('baileys') ?? 'baileys'`——先是显式命名某个安装的操作者，然后是该 profile 的依赖，最后是裸名称；裸名称只在库位于 Harness 安装自身时才解析得到，否则提供方报告 `WHATSAPP_BAILEYS_MISSING`（[运行时说明符](../architecture/2026-08-21-baileys-runtime-specifier.md)），而 Harness 的其余部分照常启动。该结果现在会点明两种补救方式，因为一条只说库缺失的消息无法据以行动。

新建的 profile 会在其 `pnpm-workspace.yaml` 中写入 `strictDepBuilds: false`。pnpm 在存在被忽略的构建脚本时以非零码退出，而 `dsh plugin add` 只在退出码为 0 时才对账，Baileys 恰好带有被忽略的构建脚本——没有这一项，一次成功的安装会被报告为失败，且不会记录任何插件。profile 的依赖本就由操作者信任，而 `dsh plugin add` 已经打印出它所执行的命令。

## 考虑过的替代方案

**保留示例覆盖层，只新增解析器。** 否决：那只解决三项决定中的一项，仍把 `dsh web --patch <path>` 留作运行该产品的方式。profile 正是本仓库对「这套安装是这样组合的」的既有表达，而且在这三项中，只有它能由模板提供。

**在启动时发现缺失就自动安装 Baileys。** 否决：一个启动时就对网络运行包管理器的 Harness 既不可预测，又恰好在最糟的时刻变慢；而且它会替操作者接受一个 GPL-3.0 依赖，以及非官方客户端的封号风险。安装仍是操作者亲手输入的命令。

**继续只通过 `DSH_WHATSAPP_BAILEYS` 命名该库。** 作为唯一机制被否决，作为最高优先级的机制被保留：环境变量是每个 shell 各自的状态，必须在每个启动器、服务管理器与重启之后都存活下来，而这种持久性 profile 本就具备。它仍是命名 profile 不拥有的安装的覆盖手段。

**随包发布该 bundle，但不放进 CLI 的依赖闭包，改由 profile 像其他插件那样安装。** 否决：那样 `dsh whatsapp` 在能工作之前就需要一次安装，`PROFILE_TEMPLATES` 也无法列出它。代价是每套 dsh 安装的闭包里都带着这些 WhatsApp 包，无论它是否组合它们——这正是换来单条命令的东西。

**把这些行放进 home 级的 `$DSH_HOME/cordis.patch.yml`。** 否决：每个 profile 都会继承该文件，于是第二个 profile 会对同一份凭据开出第二条连接，把账号从第一个手里夺走——「只允许一个连接」的规则就此变成陷阱。这一层属于唯一想要它的那个 profile。

## 验证

`packages/bundle/whatsapp-app/tests/whatsapp-app.spec.ts` 解析已签入的 patch，固定 manifest 的接线、五行及其顺序、`category` 路由、`dshHomePath` 锚点、说明符表达式，以及不含任何凭据材料；它继承了「仓库中没有任何 manifest 声明 `baileys`」这项全仓库检查。`app-boot` 的测试覆盖 `configModulePath` 的两个分支，以及带 `strictDepBuilds` 字段的 `whatsapp` 模板；`apps/cli/tests/args.spec.ts` 针对与 `web` 相同的标志面固定该别名；`verify-cordis-config` 则从该 bundle 自身的依赖解析这五个说明符。

## 影响

操作者只运行一条命令，而该组合也只有一个归属地：bundle 的 README 取代了 `examples/whatsapp-assistant/`，后者已被删除。

有两件事没有改变，只是改在 bundle 处陈述。WhatsApp 仍然每个链接设备只允许一个连接，因此规则仍是**每个 `DSH_HOME` 只跑一个 WhatsApp Harness**；每条被路由的消息仍会抵达 LLM 提供方并写入 Session 日志。

组合后的连接仍在 CI 之外：bundle 的测试解析一个文件，提供方的测试驱动一个 socket 替身，只有真实账号才会同时驱动两者。
