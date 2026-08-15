# dsh-restart-button

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

## 安装

```sh
dsh plugin --profile web add "github:keyiadiannao/dsh-restart-button#master"
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
- id: dsh-restart-button
  config:
    enableModelTool: true
```

## 工作原理

```
点击电源 → 菜单 → 重启
[宿主]   POST /api/dsh-restart-button/restart
         → 写 ~/.dsh/restart-helper-<pid>-<ts>.cjs
         → spawn `node <helper>` (detached, windowsHide)
[助手]   等旧 PID 退出 → 等端口释放 → 用相同 execPath/argv/cwd 重新拉起 DSH → 自删
[宿主]   响应刷出后终止
[客户端] 轮询 health → 确认新 instanceId → 自动刷新
```

关机则 POST `/api/dsh-restart-button/shutdown`,终止且不拉起。

开发中踩过的坑:

- helper 必须**脱离进程树**(detached + unref),否则终止 DSH 时 helper 一起被杀
- helper 写成**真实 .cjs 文件**而非 `node -e`:多行 `node -e` 脚本会被 Windows `CreateProcess` 破坏成静默 `SyntaxError`
- 重启成功以**每次进程独立的 `instanceId` 变化**(旧→新)为准,短暂离线本身不算成功

## 安全

- 破坏性 POST 带 **同源/loopback 防护**(CSRF):socket 必须是 loopback、`Host` 必须是 loopback 权威、浏览器 `Origin` 必须匹配
- **at-most-once 锁**:并发重复触发会被拒绝(第二次返回 `409`)
- 模型工具 `delayMs` **下限 1000 ms**——模型无法在自身 turn 结束前杀掉进程
- 重启 marker 在启动时**消费即删除**,后续普通启动不会误报"重启过"
- 命令行日志**脱敏**(凭据不会进入 `~/.dsh/restart-helper-<pid>.log`);helper 与 marker 文件以 `0600` 写入,运行目录 `0700`

## 会话内的重启确认

重启成功后,插件会向恢复的会话追加一条本地化的 `已重启` / `Restarted`
提示,使其像普通消息一样出现在聊天记录中(产品需求)。严格说它**并非零
token**:它以 `surfaceOp: append` 追加到会话 **surface**,因此可能进入后续
模型轮次的输入上下文——只是它本身从不触发 LLM 请求。它使用了合成的
`assistant/message`(`turn: 0, step: 0`),这是兼容性方案,而非官方支持的
assistant 边界。上游跟踪:
[deepseek-ai/DeepSeek-Harness#802](https://github.com/deepseek-ai/deepseek-harness/discussions/802)
(下游插件无法持久化自己的非 surface 事件)。最终目标是使用 durable、
非 surface 的 `restart/completed` 事件 + 客户端 `ConversationNodeDefinition`
渲染,使其完全脱离模型 surface。

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
