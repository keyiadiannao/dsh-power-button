# dsh-restart-button

[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![DSH-plugin](https://img.shields.io/badge/DSH-plugin-blue)](https://modelcontextprotocol.io)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

**DeepSeek Harness 电源控制插件(独立仓库,不依赖其它插件)**:在 Web UI 侧边栏底部加一个**电源按钮**,点击弹出上拉菜单,可选**重启**或**关机**。重启/关机引擎完全内置在本插件中。

## 特性

- **电源按钮**:注册到侧边栏底部(`sidebar.footer.action`),几何尺寸与旁边的"设置"按钮逐字节一致(34px 行高、相同边距/圆角/悬停),跟随 DSH 深浅色主题
- **上拉菜单**:点击弹出,含「重启」「关机」两项(关机为危险样式红色);点外部或 Esc 关闭
- **重启**:独立引擎——写 `.cjs` helper 文件 → `node <file>` detached 启动(无控制台窗口)→ helper 等端口释放 → 以完全相同 execPath/execArgv/argv/cwd 重新拉起 DSH → 旧进程优雅自退。无 taskkill、无 PowerShell
- **关机**:优雅 `process.exit(0)`,不再拉起;DSH 保持关闭直到你手动启动
- **自带 `restart_harness` 模型工具**:由本插件自己的引擎注册。若其它插件(如 `anweat/dsh-restart`)已占用该名字,本插件自动跳过注册(模型沿用对方的);单独安装时,模型用的是**我们的**实现
- **全屏动画**:Windows 关机/重启风格遮罩 + 环形进度 + 阶段文案;重启后自动轮询 health 并刷新页面

## 安装

```sh
# 本地开发(link 方式)
dsh plugin --profile web add "link:D:\\path\\to\\dsh-restart-button"

# 或发布后
dsh plugin --profile web add "github:you/dsh-restart-button#main"
```

重启 DSH 后生效:侧边栏底部出现 ⏻ 电源按钮。需要 Node ≥ 22.19,无其它插件依赖。

## 工作原理

```
[客户端] 点击电源 → 上拉菜单 → 选「重启」
[宿主]   POST /api/dsh-restart-button/restart
         → 写 $USERPROFILE\.dsh\dsh-restart-helper.cjs
         → spawn `node <helper>` (detached: true, unref, windowsHide: true)
[助手]   轮询 127.0.0.1:3080 直到端口释放 → 等 ~1.2s 让 socket 稳定
         → 用与当前进程相同的 execPath/execArgv/argv/cwd 重新 spawn DSH
[宿主]   延迟后 process.exit(0)(先让 HTTP 响应刷出)
[客户端] 轮询 /api/dsh-restart-button/health → 恢复后自动 location.reload()
```

选「关机」则只执行 `POST /api/dsh-restart-button/shutdown` → 延迟后 `process.exit(0)`,无 helper、无拉起,连接自然断开。

关键点:helper 必须**脱离当前进程树**(detached + unref),否则杀 DSH 时 helper 一起死;helper 写成**真实 .cjs 文件**而非 `node -e`,因为多行 `node -e` 脚本会被 Windows CreateProcess 破坏成静默 SyntaxError。

## 模型工具

`restart_harness`(可选参数 `delayMs`)——让 agent 直接安排一次进程重启。与 `anweat/dsh-restart` 同名同参;两者共存时先注册者生效(通常是 anweat 版),单独安装本插件时用我们的实现。

## 开发

```sh
npm run build        # tsdown 构建 host + client bundle
npm run typecheck    # tsc --noEmit
```

产物:host 在 `lib/index.js`,client bundle 在 `lib/client.js`。

## 版权与致谢

MIT。本插件为**独立实现**。"detached helper 脱离进程树重新拉起"这一设计思路参考了
[anweat/dsh-restart](https://github.com/anweat/dsh-restart)(MIT);
实现细节不同(真实 .cjs 文件而非 `node -e`、无 PowerShell、自带端点与工具),未复制其代码。