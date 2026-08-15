# dsh-restart-button

[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek-Harness-blue)](https://github.com/deepseek-ai/DeepSeek-Harness)

[DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 的自包含电源控制插件:侧边栏底部**电源按钮** + 上拉**重启/关机**菜单 + 全屏过渡动画。重启/关机引擎内置在本插件中,**不依赖其它插件**。

> 由 DeepSeek AI 辅助开发,发布前经人工 review。

## 功能

- **电源按钮**:注册到侧边栏底部(`sidebar.footer.action`),外观与旁边的"设置"按钮一致(34px 行高,主题变量,跟随深浅色)
- **上拉菜单**:「重启」「关机」两项,点外部或 Esc 关闭
- **重启**:写 `.cjs` helper → `node <file>` detached 启动(无控制台窗口)→ 等端口释放 → 用相同 execPath/execArgv/argv/cwd 重新拉起 DSH → 响应刷出后终止旧进程
- **关机**:终止进程,不再拉起
- **过渡动画**:Windows 关机风格遮罩 + 环形进度 + 阶段文字;重启后自动刷新
- **`restart_harness` 模型工具**:与 `anweat/dsh-restart` 同名,单独安装时由本插件提供;名字被占用则自动跳过

## 安装

```sh
dsh plugin --profile web add "github:keyiadiannao/dsh-restart-button#master"
```

重启 DSH 后生效:侧边栏底部出现电源按钮。需要 Node ≥ 22.19。

## 工作原理

```
点击电源 → 菜单 → 重启
[宿主]   POST /api/dsh-restart-button/restart
         → 写 $USERPROFILE/.dsh/restart-helper-<pid>-<ts>.cjs
         → spawn `node <helper>` (detached, windowsHide)
[助手]   等旧 PID 退出 → 等端口释放 → 用相同 execPath/argv/cwd 重新拉起 DSH → 自删
[宿主]   响应刷出后终止
[客户端] 轮询 health → 确认新 instanceId → 自动刷新
```

关机则 POST `/api/dsh-restart-button/shutdown`,终止且不拉起。

开发中踩过的两个坑:

- helper 必须**脱离进程树**(detached + unref),否则杀 DSH 时 helper 一起死
- helper 写成**真实 .cjs 文件**而非 `node -e`:多行 `node -e` 脚本会被 Windows CreateProcess 破坏成静默 SyntaxError

## 安全

- 破坏性 POST 带 **同源/loopback 防护**(CSRF)
- **at-most-once 锁**:并发重复重启会被拒绝(第二次返回 409)
- 重启成功以**每次进程独立的 instanceId 变化**为准(旧→新),而非仅凭短暂离线

## 开发

```sh
npm run build        # tsdown:host + client bundle
npm run typecheck    # tsc --noEmit
```

产物:host 在 `lib/index.js`,client bundle 在 `lib/client.js`(已入库,git 安装免构建)。

## License 与致谢

MIT。"detached helper 重新拉起"的思路参考了
[anweat/dsh-restart](https://github.com/anweat/dsh-restart)(MIT);
实现为独立编写(真实 .cjs 文件、无 PowerShell、动态端口),未复制其代码。