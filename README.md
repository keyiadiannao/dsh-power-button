# dsh-restart-button

[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

一个给 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 用的电源控制小插件:在 Web UI 侧边栏底部加一个电源按钮,点击弹出上拉菜单,可以**重启**或**关机**。重启/关机逻辑内置在插件里,不依赖其它插件。

个人项目,简单实现,欢迎指正。

> 开发说明:本插件由 DeepSeek AI 配合 DeepSeek Harness 开发,代码经人工 review 后发布。

## 功能

- **电源按钮**:注册到侧边栏底部(`sidebar.footer.action`),外观与旁边的"设置"按钮一致(34px 行高、相同边距/圆角),跟随 DSH 深浅色主题
- **上拉菜单**:点击弹出「重启」「关机」两项,点外部或 Esc 关闭
- **重启**:写一个 `.cjs` helper 文件 → `node <file>` detached 启动(无控制台窗口)→ helper 等端口释放 → 用与当前进程相同的 execPath/execArgv/argv/cwd 重新拉起 DSH → 旧进程主动终止（响应发送后）
- **关机**:`process.exit(0)`,不再拉起;DSH 保持关闭,需要时手动启动
- **全屏动画**:重启/关机时的过渡遮罩(环形进度 + 阶段文字);重启完成后自动刷新页面
- **`restart_harness` 工具**:注册与 `anweat/dsh-restart` 同名的模型工具。若其它插件已占用该名字则自动跳过;单独安装时由本插件提供

## 安装

```sh
dsh plugin --profile web add "github:keyiadiannao/dsh-restart-button#master"
```

重启 DSH 后生效:侧边栏底部出现电源按钮。需要 Node ≥ 22.19。

## 工作原理(简述)

```
点击电源 → 菜单 → 选「重启」
[宿主]   POST /api/dsh-restart-button/restart
         → 写 $USERPROFILE\.dsh\restart-helper-<pid>-<ts>.cjs
         → spawn `node <helper>` (detached, windowsHide)
[助手]   轮询当前监听端口直到释放 → 用相同 execPath/argv/cwd 重新 spawn DSH
[宿主]   延迟后 process.exit(0)
[客户端] 轮询 health → 恢复后自动 location.reload()
```

选「关机」则只 `process.exit(0)`,不拉起新进程。

两个实现细节(踩过坑所以记一下):
- helper 必须**脱离当前进程树**(detached + unref),否则杀 DSH 时 helper 一起死
- helper 写成**真实 .cjs 文件**而非 `node -e`:多行 `node -e` 脚本在 Windows 下会被 CreateProcess 破坏成静默 SyntaxError

## 开发

```sh
npm run build        # tsdown 构建 host + client bundle
npm run typecheck    # tsc --noEmit
```

产物:host 在 `lib/index.js`,client bundle 在 `lib/client.js`(已入库,git 安装免构建)。

## 致谢

MIT。"detached helper 脱离进程树重新拉起"的思路参考了
[anweat/dsh-restart](https://github.com/anweat/dsh-restart)(MIT);
实现为独立编写(真实 .cjs 文件、无 PowerShell、动态端口),未复制其代码。