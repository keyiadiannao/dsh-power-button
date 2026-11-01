# Desktop 重启审查记录

本次审查覆盖 `dsh-power-button` 主线、PR #8、关闭但未合并的 PR #9，以及两个无需修改 Harness 的第三方方案。审查基线为插件 `b9fa2df`；官方 Harness master 查询结果为 `ce7073d51254c26cd63b22a60835b8f948deb447`，Desktop Host 协议版本为 4。第三方方案仅阅读源码，没有安装，也没有对现有应用执行退出、重启或进程终止。

## 为什么 Web 能重启，Desktop 不能照搬

Web 的服务进程可以由独立 helper 重放启动参数。Desktop 中，同一个 Host 还依赖 Electron 父进程、IPC 通道、动态端口和窗口。重放 Host 参数不能重建这些父进程资源；单独让 Host 退出则会进入外壳的崩溃恢复流程。`appExit` 控制当前 Host，不等于 `app.relaunch()`。

官方源码中有开发菜单的 `Restart App and Host`，因此外壳确实有重启能力；当前公开的插件接口没有暴露这项操作。Host IPC 接收器会把不在协议中的消息判为无效并终止 Host，不能用任意 `process.send()` 消息试探。

## 各方案的适用范围

| 方案 | 实际机制 | 结论 |
|---|---|---|
| PR #8 | 写固定名 intent 文件后退出 Host；另加跨端口 marker 查找和端口发现 | 当前官方外壳没有 intent 文件消费者，不能独立完成正常重启。跨端口身份查找可用于后续完整方案；端口握手在实际端口解析前写入，可能发布默认端口 |
| PR #9 | 外壳公布能力，插件经 IPC 请求外壳 relaunch，交接 restartId | 需要另一个 Harness 分支；不满足无需修改上游的要求。发送回调只证明消息送达，不能替代外壳接受请求的 ACK |
| `foreee/dsh-app-restart` | 先派生 relauncher，再通过平台退出机制请求整个应用退出 | macOS 的 Quit Apple Event 值得验证。Windows 用 `taskkill /PID` 请求关闭窗口；当前 Harness 会取消关闭并隐藏到托盘，不能据此保证退出。helper 超时后仍会尝试启动，不能把返回 `ok` 当作重启完成 |
| `MoonSand/dsh-desktop-restart` | 任务计划程序启动外部 watchdog，按可执行文件路径终止应用并重新启动 | 能避开应用进程内 helper 的限制，但会终止同路径的所有实例，且没有会话最终保存确认。固定任务名与临时脚本名也不隔离并发尝试；不宜直接复制为默认路径 |

这里的“没有插件接口”不等于“插件绝对做不到”。外部启动器可以实现进程层面的重新启动，但其退出保证、数据保存和身份确认需要另行验证。README 或某台机器的成功记录不能替代这些验收。

## 本次修复

1. Desktop 误走 Web 电源路径：Electron Node 模式中，HTTP 重启和关机在创建 helper、写 marker 或安排退出之前返回 `503` / `desktop-unsupported`；模型工具与命令报告可操作的错误。独立 Node 仅继承了 `ELECTRON_RUN_AS_NODE` 时不会被误判。
2. 慢启动误报：helper 的 180 秒就绪窗口由共享协议常量提供；前端完整重启轮询预算为 300 秒，涵盖旧 Host 退出、端口释放和启动准备。原实现只轮询 90 次，120 秒后就绪的实例无法恢复界面。
3. 错误被轮询覆盖：拒绝响应使本轮操作失效；关机探测在异步响应后重新检查操作身份。这样不会把权限拒绝显示成“已关机”，也不会在用户关闭提示后重新进入终态。

测试先于修复运行，明确观察到慢启动无法刷新、拒绝重启后变回等待、拒绝关机后变成已关机、取消操作后迟到探测修改状态。Desktop 拒绝测试额外检查无 helper 调用、无退出计时器、无退出调用，而不仅检查响应文本。

## 推荐的后续实现

优先寻求外壳公开一个可选生命周期服务：插件负责入口，外壳负责确认活动任务、停止 Host、退出和重开。请求应有关联 id，外壳完成交接记录后返回接受或拒绝；只有接受后才进入不可撤销阶段。这是生命周期所有者提供扩展接口，插件不需要直接操作 Electron 内部对象。

若必须无需修改上游，可以另做 Windows 实验实现：启动器使用每次尝试独立的任务名和私有目录；验证当前外壳 PID、创建时间、路径和用户；取得外部启动器 ACK 后才请求退出；退出未确认时停止后续拉起；新实例就绪必须匹配 restartId。不能只按进程名或路径终止全部实例，也不能以一次提前 flush 声称覆盖退出前所有追加写入。当前没有验证能绕过“关闭到托盘”而仍进入外壳正常保存流程的稳定入口，这项限制需要先解决。

## 验证与交付范围

修复先在独立工作目录 `dsh-power-button-review`、分支 `codex/power-button-review` 中验证，再交付到 `master`。审查与验证没有主动退出或重启现有应用。新增测试使用隔离的测试 home 和假时钟；现有进程级验收覆盖真实 helper、TCP 端口、动态端口固定、握手拒绝和 Windows 注册表刷新。

在 Windows、Node 24.22.1 上执行的检查：`pnpm typecheck`、`pnpm typecheck:tests`、`pnpm test`（6 个文件、150 项通过）、`pnpm build`、`git diff --check`。`pnpm pack --pack-destination <临时目录>` 的实际 tarball 包含宿主 JavaScript、类型声明、客户端 bundle、patch 和清单，未包含测试与审查记录；检查后已删除测试 tarball。`lib/` 已由构建更新，版本与依赖清单未改。

本次不声称实现了 Desktop 自动重启，也不将自动化状态机测试描述为真实 Electron 窗口验收。发布前仍需对隔离的 Desktop 安装验证拒绝提示，并在真实 Web profile 中检查较慢重启的界面恢复。

## 源码与讨论

- [共享对话](https://chatgpt.com/share/6ae6ce59-9914-83e8-b153-48e6fef13a6d)
- [PR #8](https://github.com/keyiadiannao/dsh-power-button/pull/8)、[PR #9](https://github.com/keyiadiannao/dsh-power-button/pull/9)、[已合并的鉴权修复 #10](https://github.com/keyiadiannao/dsh-power-button/pull/10)
- [官方 Host IPC 接收器](https://github.com/deepseek-ai/DeepSeek-Harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/apps/desktop/src/host-process.ts)、[外壳菜单与关闭处理](https://github.com/deepseek-ai/DeepSeek-Harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/apps/desktop/src/main.ts)
- [`foreee` 审查版本](https://github.com/foreee/dsh-app-restart/blob/bb52ac4c5cfcbbb1dd403a7468d4142d7e9281a5/lib/index.js)
- [`MoonSand` 审查版本](https://github.com/MoonSand/dsh-desktop-restart/blob/2e0afe744aaa06d0c4e7902f91387fe41af54749/index.js)
- [Electron 窗口 close 事件](https://www.electronjs.org/docs/latest/api/browser-window#event-close)、[Microsoft taskkill](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)
