# dsh-power-button

[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek-Harness-blue)](https://github.com/deepseek-ai/DeepSeek-Harness)

[English](README.md) | [中文](README.zh-CN.md)

[DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 的自包含**电源与生命周期控制**插件:侧边栏底部**电源按钮** + 上拉**重启/关机**菜单 + 全屏过渡动画。重启/关机引擎内置在本插件中,**不依赖第三方插件**。

> 由 DeepSeek AI 辅助开发,发布前经人工 review。

## 功能

- **侧边栏电源按钮**:注册到页脚操作位(`sidebar.footer.action`),主题自适应,外观与旁边的"设置"按钮一致
- **重启/关机菜单** + Windows 关机风格全屏过渡动画;重启确认后页面自动刷新
- **自包含重启引擎**:写一个 detached 的 `.cjs` helper,等旧进程退出、端口释放后,用相同的 `execPath/execArgv/argv/cwd` 重新拉起 DSH。不使用 PowerShell、不使用 `taskkill`
- **`/restart` 与 `/shutdown` 命令**,以及 **`restart_harness` 模型工具**(与 `anweat/dsh-restart` 同名;若名字已被其它插件占用则跳过注册)
- **界面与宿主文案本地化**(中文 / English),跟随 profile 的 `locale.preference`
- **启动清理**:自动清理运行目录下超过 7 天的 `restart-helper-*.log`

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

```
点击电源 → 菜单 → 重启
[宿主]   POST /api/dsh-power-button/restart
         → 写 ~/.dsh/restart-helper-<pid>-<ts>.cjs
         → spawn `node <helper>` (detached, windowsHide)
[助手]   等旧 PID 退出 → 等端口释放 → 用相同 execPath/argv/cwd 重新拉起 DSH → 自删
[宿主]   响应刷出后终止
[客户端] 轮询 health → 确认新 instanceId → 自动刷新
```

关机则 POST `/api/dsh-power-button/shutdown`,终止且不拉起。由于关机不可逆(进程停止后需手动启动),GUI 在关机前会**弹确认对话框**,需要再次点击确认才执行。(`/shutdown` 命令与模型工具保持单次触发;模型不暴露关机。)

开发中踩过的坑:

- helper 必须**脱离进程树**(detached + unref),否则终止 DSH 时 helper 一起被杀
- helper 写成**真实 .cjs 文件**而非 `node -e`:多行 `node -e` 脚本会被 Windows `CreateProcess` 破坏成静默 `SyntaxError`
- 重启成功以**每次进程独立的 `instanceId` 变化**(旧→新)为准,短暂离线本身不算成功
- **持久写静止检查**:旧进程退出、端口释放后,helper 轮询所有会话日志的 `(size, mtimeMs)` 直到连续两次采样一致(上限约 15 秒)才重启。旧进程主循环退出后其会话写缓冲可能仍在落盘;在仍在追加的文件上拉起新进程会插入旧 seq 造成会话损坏——此检查封堵了这个窗口

## 安全

- 破坏性 POST 带 **同源/loopback 防护**(CSRF):socket 必须是 loopback、`Host` 必须是 loopback 权威、浏览器 `Origin` 必须匹配
- **at-most-once 锁**:并发重复触发会被拒绝(第二次返回 `409`)
- 模型工具 `delayMs` **下限 1000 ms**——模型无法在自身 turn 结束前杀掉进程
- 重启 marker 在启动时**消费即删除**,后续普通启动不会误报"重启过"
- 命令行日志**脱敏**(凭据不会进入 `~/.dsh/restart-helper-<pid>.log`);helper 与 marker 文件以 `0600` 写入,运行目录 `0700`

## 重启确认——纯 UI 提示,绝不写入会话

重启成功后,插件会在界面角落弹出一条本地化的 `已重启` / `Restarted`
toast。这是**纯 UI 提示**:不会向任何会话日志写入内容。(此前的设计会向
恢复的会话追加合成的 `assistant/message`(`turn: 0, step: 0`)——该方案会
触发 token-meter 的 step 配对不变量并可能损坏大会话,已移除。上游跟踪:
[deepseek-ai/DeepSeek-Harness#802](https://github.com/deepseek-ai/deepseek-harness/discussions/802)。)

机制:
- 启动时若消费到重启 marker,`/health` 会报告 `restarted: true, fromInstanceId: <old>`
- 客户端加载后查询一次 `/health`;若 `restarted` 为真则显示 toast,然后通过
  `POST /api/dsh-power-button/notice-shown` 确认,避免刷新后重复弹出
- 由于确认消息完全不触碰会话文件,重启**不再可能损坏会话日志**或留下未配对事件

## 开发

```sh
npm run build        # tsdown:host + client bundle
npm run typecheck    # tsc --noEmit
npm test             # vitest:marker 生命周期、delayMs 下限、argv 脱敏、日志清理
```

测试通过 vitest setup 文件隔离 `DSH_HOME`,不会触碰真实的 `~/.dsh`。
产物:host 在 `lib/index.js`,client bundle 在 `lib/client.js`(均已入库,git 安装免构建)。

## License 与致谢

MIT。"detached helper 重新拉起"的思路参考了
[anweat/dsh-restart](https://github.com/anweat/dsh-restart)(MIT);
实现为独立编写(真实 .cjs 文件、无 PowerShell、动态端口),未复制其代码。
