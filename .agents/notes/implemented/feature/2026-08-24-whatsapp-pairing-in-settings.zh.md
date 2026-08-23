# Agent Note: The WhatsApp pairing QR lives in Settings, on its own loopback channel

Status: implemented

[English](2026-08-24-whatsapp-pairing-in-settings.md) | 中文

## 问题

WhatsApp 接缝从发布起就会报告 `{ state: 'pairing', qr }`，并在每次轮换时重新发出，但浏览器里没有任何东西渲染它。于是配对账号发生在产品之外：运维方从会话日志里读出负载，或者由一个独立 URL 上的临时页面画出二维码。这项能力唯一需要人参与的步骤没有落脚点，而其他所有 harness 级设置都住在同一个面板里。

它没有落脚点的原因不是布局。`pairing` 负载是一份凭据：扫码者会把一台设备链接到该账号，取得包括历史消息在内的完全访问权。因此“二维码放哪里”真正的问题是“哪些浏览器可以看到它”，而现有两条把 host 状态送到浏览器的共享路径，对这份负载给出的答案都是错的。

## 决定

[`@deepseek-ai/dsh-client-ui-settings-whatsapp`](../../../../packages/client/ui-settings-whatsapp/README.md) 为 Web 设置贡献一个 **WhatsApp** 页面（`settings.section`，id 为 `whatsapp`，order 为 25），展示连接状态，并在账号处于配对中时展示实时二维码。[`@deepseek-ai/dsh-whatsapp-app`](../../../../packages/bundle/whatsapp-app/README.md) 插入它的行，因此该页面恰好存在于组合了 WhatsApp 的地方；页面的存在即是能力检查，无需用插件清单探测来决定要不要画它。

本包注册自己的 Connection RPC 通道，而不是搭载共享平面：

```ts ignore-check
ctx.connection.rpc.handle('/whatsapp', handler, { authority: 'loopback' })
```

`authority: 'loopback'` 会把该路由的受信任主机列表钉为空，这正是配置平面其余部分已经在用的围栏——只不过在这里由拥有该秘密的特性自己声明，而不是由一份代它修改的中心列表声明。通道只有一个无参端点 `status`，返回接缝的 `WhatsAppStatus`；其他端点一律 `bad-request`。浏览器按分支逐字段解码负载，并把无法解读的负载视为读取失败，因为即使两端一起发布，通道应答仍是一处线上边界。

页面在打开期间每两秒轮询一次 `status`，关闭时完全不轮询。轮询是这道围栏的直接结果，而不是权宜之计：推送意味着 host 事件，而 host 事件会到达每一个已连接的浏览器。

**两半放在同一个包里。** 它们共用同一套线上词汇——通道名、端点名与状态解码函数——拆开就要么把这套词汇放进第三个包，要么复制一份，而唯一的收益只是符合目录选择器那对包 `packages/host/*` + `packages/client/ui-*` 的命名。`packages/client/connection` 与 `packages/api/gateway` 出于同样理由本就同时承载两半。代价是包内的编译面拆分（`tsconfig.host.json` + `tsconfig.client.json`，上面覆一个 `files: []` 聚合）：Host 半边会引入 `ctx.connection` 的 Context 合并，若两半编译进同一个程序，浏览器半边的 `ctx.get('connection') as ConnectionHandle` 断言就不合法。根 Host 聚合显式引用了本包，因为它本来会排除 `packages/client/*/src`。

## 备选方案

**把 `whatsapp/status`加入转发事件白名单。** 这是最短的路径——接缝本就发出该事件，浏览器也本就接收转发的 host 事件。拒绝的理由是：转发事件会广播给每一个已连接的浏览器且没有来源围栏，一个在局域网可达的 `dsh web` 会把配对码交给任何打开它的人。该白名单同时也是一份共享的安全列表，一个可选特性会因此替所有人放宽它。

**把 `status` 暴露为 Typert 远程方法。** 因同一道围栏被拒。Typert 网关只以 `authority: 'trusted-host'` 注册一个 `/api` 拦截器，因此“按方法 loopback”要么扩展网关，要么把方法名加进 `dsh-client-connection` 的 `PRIVILEGED_METHODS`——同样是替一个可选特性去改共享列表。`packages/api/remotes` 挂载的也是覆盖层无法扩展的固定远程列表。

**让二维码留在自己的页面上，只在设置里加一个链接。** 拒绝：独立 URL 正是被抱怨的东西。第二个界面需要自己的授权决定、自己的本地化与自己的生命周期，而运维方仍然得离开那个配置了其他一切的面板。

**改为在会话日志里渲染二维码。** 拒绝：会话日志是一段对话的记录，而配对码既不面向模型也不属于对话。把一份会轮换的凭据写进持久日志，也与接缝自身的隐私立场相悖。

**把页面放进默认 Web bundle，在接缝缺席时隐藏。** 拒绝：那会在每个 harness 的设置导航里放一个 WhatsApp 入口，并需要运行时能力探测来决定可见性。组合本身已经精确回答了这个问题。

**把轮询间隔做成 `Config` 字段。** 拒绝：该读取经由 loopback 返回一个进程内字段，真正起作用的界限只是“轮换后的码要多快替换掉人正拿手机对着的那一个”。这是 UI 节奏，不是部署选择。

## 测试

包级测试对两半都做到逐文件覆盖：Host 半边的端点分派与其他端点的 `bad-request`；浏览器半边的注册（inject 列表、id、order、本地化标签、语言切换、slot 延迟声明、teardown）、读取器的成功/错误/无法解码路径、页面的每一个状态分支、轮询节奏、卸载时的取消，以及读取失败后的重试。

`packages/client/connection` 的 fixture 传输现在也服务 `/whatsapp`，由 `?fixtureWhatsApp=pairing|online|offline|connecting|logged-out` 选择分支，使组装后的 Web 测试环境无需账号即可驱动每个分支。`packages/bundle/whatsapp-app/tests/whatsapp-app.spec.ts` 固定了该 patch 的第五行。

`apps/web/tests/whatsapp-settings.snapshot.ts` 以应用了该覆盖层的方式启动构建产物的浏览器图，打开设置、选中 WhatsApp，固定配对卡片及其渲染出的 `<svg>` 二维码与凭据警告、已连接的账号，以及未应用覆盖层时 WhatsApp 页面不存在这一事实。为此，jsdom 启动测试环境（`apps/web/tests/assembled-boot.ts`）必须像 `dsh web` 那样接受同样的 `--patch` 层，而不再只组合随附 bundle；否则任何可选装的插件行都无法出现在组装后的记录中。

真实配对在任何 CI 中都无法演练：它需要运维方自行安装的 Baileys 与一部手机。fixture 才是页面的证据；扫码本身仍是手动步骤，这一点与本次改动之前相同。

## 后果

这项能力唯一需要人参与的步骤现在成了产品的一部分，而“谁可以看到这个码”的答案被写在产生该码的地方，而不是一份共享白名单里。使用远程浏览器的运维方会看到页面读不到状态——这是刻意的，示例 README 也如此说明。

远程浏览器拿不到二维码，且今天没有任何配置能改变这一点。如果某个部署确实需要远程配对，那是一个关于“是否要把凭据经网络披露”的独立决定，并且应当走转发事件那条路径，而不是放宽这里的围栏。

`qrcode.react` 因此进入依赖集合（ISC 许可，除 React 外无运行时依赖），而不是手写编码器，这符合“优先使用维护良好的依赖而非手写”的政策：QR 编码器是一份规范，不是产品逻辑。
