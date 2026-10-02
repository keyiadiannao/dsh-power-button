# dsh-power-button

[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek-Harness-blue)](https://github.com/deepseek-ai/DeepSeek-Harness)

[English](README.md) | [中文](README.zh-CN.md)

[DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 的自包含**电源与生命周期控制**插件:侧边栏底部**电源按钮** + 上拉**重启/关机**菜单 + 全屏过渡动画。重启/关机引擎内置在本插件中,**不依赖第三方插件**。

> 由 DeepSeek AI 辅助开发,发布前经人工 review。

## 功能

- **侧边栏电源按钮**:注册到页脚操作位(`sidebar.footer.action`),主题自适应,外观与旁边的"设置"按钮一致
- **重启/关机菜单** + Windows 关机风格全屏过渡动画;重启确认后页面自动刷新
- **自包含重启引擎**:写一个 detached 的 `.cjs` helper,经 ARM → COMMIT → ACK 握手接手拉起职责,等旧进程退出、端口释放、会话日志停止增长后,用相同的 `execPath/execArgv/argv/cwd` 重新拉起 DSH,并以 `restartId` 确认新实例。不使用 PowerShell、不使用 `taskkill`
- **`/restart` 与 `/shutdown` 命令**、**`restart_harness` 模型工具**(与 `anweat/dsh-restart` 同名;若名字已被其它插件占用则跳过注册),以及只读的 **`restart_status`** 诊断工具
- **界面与宿主文案本地化**(中文 / English),跟随 profile 的 `locale.preference`
- **启动清理**:自动清理运行目录下超过 7 天的 helper 日志与脚本、每次重启的握手记录,以及尚未投递的重启通知

## 截图

**① 侧边栏电源按钮** —— 主题适配的底部常驻入口，风格与相邻的设置按钮一致。

![侧边栏底部的电源按钮](docs/screenshots/zh/power-button.png)

**② 重启 / 关机菜单** —— 点击电源按钮展开，两个动作一次到位。

![重启 / 关机菜单](docs/screenshots/zh/power-menu.png)

**③ 关机确认对话框** —— 防误触设计：默认焦点在「取消」，只有显式确认才会真正停止进程。

![关机确认对话框](docs/screenshots/zh/shutdown-confirm.png)

**④ 关机进度遮罩** —— Windows 风格全屏过渡，进程收尾时显示当前阶段。

![关机进度遮罩](docs/screenshots/zh/shutdown-progress.png)

**⑤ 重启完成提示** —— 页面自动重载后，成功提示确认 DSH 已恢复。

![重启完成提示](docs/screenshots/zh/restart-done.png)

## 安装

```sh
dsh plugin --profile web add "github:keyiadiannao/dsh-power-button#master"
```

重启 DSH 后生效:侧边栏底部出现电源按钮。需要 Node ≥ 22.19。

## 配置

通过 profile 的 cordis 层配置(`cordis.patch.yml` 或设置界面):

| 键 | 默认 | 含义 |
|---|---|---|
| `enableModelTool` | `true` | 注册 `restart_harness` 模型工具。设 `false` 则重启仅保留在 GUI 按钮与 `/restart`。 |
| `maxDelayMs` | `5000` | 模型工具 `delayMs` 参数的上限(ms)。有效下限为 1000 ms。 |

示例:

```yaml
- id: dsh-power-button
  config:
    enableModelTool: true
```

## 工作原理

旧进程在有一个存活的继任者接手拉起职责之前，不得退出。这是一次显式的
ARM → COMMIT → ACK 握手：没有任何进程负责拉起是 UI 唯一无法挽回的结果，
因此 ACK 之前的任何失败都会让旧进程继续运行。

```
点击电源 → 菜单 → 重启
[宿主]   POST /api/dsh-power-button/restart
         → 写出本次重启专用的 helper .cjs(0600:其中内嵌拉起 argv)
         → spawn `node <helper>` (detached, windowsHide)
[助手]   ARM   → status { stage: 'armed', armedAt }
[宿主]   等到 ARMED(5 秒)→ 写入本次 restartId 的 COMMIT 文件
[助手]   ACK   → status { stage: 'committed', committedAt }
[宿主]   此时才:unref helper → flush 所有活跃会话(上限 5 秒)
         → 在 delayMs 后请求退出,其后有 15 秒看门狗
[助手]   等旧 PID 退出(以宿主自身的退出预算为上限)
         → 等端口释放
         → 等会话日志停止增长(静止)
         → 写 v2 marker,然后用相同 execPath/argv/cwd 拉起 DSH
           并带上 DSH_POWER_RESTART_ID 启动令牌
         → 轮询 /health 直到 ok && instanceId != 旧 && restart.restartId 匹配
         → 自删
[客户端] 轮询 health → 确认新 instanceId → 自动刷新
```

关机则 POST `/api/dsh-power-button/shutdown`,终止且不拉起。由于关机不可逆(进程停止后需手动启动),**电源按钮和 `/shutdown` 命令都会先弹确认对话框**,需要再次点击确认才执行。模型不暴露关机。

开发中踩过的坑:

- helper 必须**脱离进程树**(detached + unref),否则终止 DSH 时 helper 一起被杀
- helper 写成**真实 .cjs 文件**而非 `node -e`:多行 `node -e` 脚本会被 Windows `CreateProcess` 破坏成静默 `SyntaxError`
- 重启成功以**每次进程独立的 `instanceId` 变化**(旧→新)为准,短暂离线本身不算成功
- **持久写静止检查**:旧进程退出、端口释放后,helper 轮询所有会话日志的 `(size, mtimeMs)` 直到连续两次采样一致(上限约 15 秒)才重启。旧进程主循环退出后其会话写缓冲可能仍在落盘;在仍在追加的文件上拉起新进程会插入旧 seq 造成会话损坏——此检查封堵了这个窗口
- **启动器的退出请求要当服务读,不能当属性读**:它在 `ctx.get('appExit')`。`appExit` 是本插件未在 `inject` 中声明的可选宿主值,上下文代理会把 `ctx.appExit` 解析为 `undefined`——按属性读取会**在每次重启和关机时静默跳过优雅销毁**,直接走 `process.exit` 硬杀(丢失树销毁、存储 flush、端口释放)。官方读取方(`dsh-cmdline`、`dsh-headless`)同样走 `ctx.get`
- **优雅退出与退出前 flush 都有界**:请求 `appExit` 后,若进程仍存活,15 秒看门狗会硬退出;其前的会话 flush 上限为 5 秒。helper 等旧 PID 的耐心**由该预算推导**(flush 上限 + delayMs + 看门狗,再加余量),而不是写成第二个常量。此前 flush 无上限,夹在 helper 的 COMMIT 与进程退出之间,而 helper 只固定等 30 秒——flush 超过约 13.5 秒就足以让 helper 放弃且**不再拉起新进程**,用户落得没有服务。把两者绑成推导关系,正是防止它们日后各自漂移

## 安全

- 破坏性 POST 带 **同源/loopback 防护**(CSRF):socket 必须是 loopback、`Host` 必须是 loopback 权威、浏览器 `Origin` 必须匹配
- **at-most-once 锁**:并发重复触发会被拒绝(第二次返回 `409`)
- 模型工具 `delayMs` **下限 1000 ms**——模型无法在自身 turn 结束前杀掉进程
- 重启 marker 在启动时**消费即删除**,后续普通启动不会误报"重启过"
- 命令行日志**脱敏**(凭据不会进入 `~/.dsh/restart-helper-<pid>.log`);helper 与 marker 文件以 `0600` 写入,运行目录 `0700`

## 重启后,会话能知道什么

三件独立的事,刻意不合并成一件:

- **界面**弹出本地化的 `已重启` / `Restarted` toast。进程在整个生命周期内都
  通过 `/health` 的 `restart.fromInstanceId`、`restart.restartId` 暴露自己的
  重启身份;确认 toast 只清 pending 标志,不会抹掉身份。
- **发起重启的那个会话**会收到一条重启通知。当重启来自 `restart_harness` 或
  `/restart` 时,新进程会通过 `Agent.inject()` 给那个确切的会话排队一条通知。
  只有记录了 causal session 的重启才会排;GUI 点击不记录任何会话,也就**不会**
  被归到恰好打开着的那个会话上。每个会话最多排队一条,投递后即删除。
- **其他会话**可以调用 `restart_status` 工具,它报告那份持久记录:是否发生过
  重启、restartId、阶段、被替换的实例与新实例、各阶段时间、发起者,以及当前
  运行的进程是否就是这次重启产生的实例。模型正是靠它发现自己**没有**发起的重启。

本插件**从不自己追加模型可见的消息、不伪造 turn、也不唤醒 agent**。
`Agent.inject()` 会持久登记一条 `agent/inbox/spliced` 记录,交给下一个合法的
step 去认领——这就是为什么空闲会话保持空闲,只是下次运行时已然知情。此前的
设计会向恢复的会话追加合成的 `assistant/message`(`turn: 0, step: 0`)——该方案
会触发 token-meter 的 step 配对不变量并可能损坏大会话,已移除。上游跟踪:
[deepseek-ai/DeepSeek-Harness#802](https://github.com/deepseek-ai/deepseek-harness/discussions/802)。

机制:
- 启动时若消费到重启 marker,`/health` 会报告 `restarted: true, fromInstanceId: <old>`
- `/health` 还会报告 `appExit: "available" | "missing"`——启动器提供的退出通道在当前宿主是否真的可解析。`missing` 意味着每次重启都退化为 `process.exit`(无优雅销毁);该字段把"重启卡 30 秒"变成一次请求即可确诊
- 客户端加载后查询一次 `/health`;若 `restarted` 为真则显示 toast,然后通过
  `POST /api/dsh-power-button/notice-shown` 确认,避免刷新后重复弹出
- 重启通知走 DSH 官方的 inbox 机制,不直接 append 会话事件,因此重启**不会**损坏会话日志或留下未配对事件

## 开发

```sh
npm run build        # tsdown:host + client bundle
npm run typecheck    # tsc --noEmit
npm test             # vitest:marker 生命周期、delayMs 下限、argv 脱敏、日志清理、退出通道
```

测试通过 vitest setup 文件隔离 `DSH_HOME`,不会触碰真实的 `~/.dsh`。
产物:host 在 `lib/index.js`,client bundle 在 `lib/client.js`(均已入库,git 安装免构建)。

## License 与致谢

MIT。"detached helper 重新拉起"的思路参考了
[anweat/dsh-restart](https://github.com/anweat/dsh-restart)(MIT);
实现为独立编写(真实 .cjs 文件、无 PowerShell、动态端口),未复制其代码。
