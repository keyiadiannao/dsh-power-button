# 桌面端重启：宿主侧改动

桌面端重启无法在插件内实现。Host 是 Electron 外壳的子进程，外壳把 Host 的任何退出都当作崩溃，而插件自行 spawn 的 helper 只会留下一个没有窗口、没有 IPC 的第二份 Host。要实现它必须修改 DeepSeek Harness 本身，这超出本插件的安全边界。请先看下面的步骤，再决定是否允许你的 agent 在当前安装上执行。在此之前，本插件在桌面端拒绝重启与关机，返回 `503 desktop-unsupported`。

## 为什么必须改宿主

`apps/desktop/src/host-process.ts` 把 Host 的每次退出都记为失败，退出码 0 也一样，所以"被请求的退出"和"崩溃"分不开：

```ts
child.once('close', (code) => {
  if (code !== 0 && code !== null) this.fail(new Error(`dsh desktop host exited with …`))
  else this.fail(new Error(`dsh desktop host stopped…`))
  resolve()
})
```

`app.relaunch()` 只出现在致命恢复对话框里。

## 改动 1 — 一次性交接记录

新增 `apps/desktop/src/restart-handoff.ts`。`app.relaunch()` 不传参数也不传环境，重启身份必须落盘。

```ts
export const DESKTOP_RESTART_ID_ENV = 'DSH_DESKTOP_RESTART_ID'
export const DESKTOP_RESTART_PROTOCOL_ENV = 'DSH_DESKTOP_RESTART_PROTOCOL'
export const DESKTOP_RESTART_PROTOCOL_VERSION = 1

export function restartHandoffPath(userData: string): string {
  return join(userData, 'restart-handoff.json')
}

export function writeRestartHandoff(path: string, restartId: string, now = new Date()): void {
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, restartId, requestedAt: now.toISOString(), pid: process.pid }),
    { encoding: 'utf8', mode: 0o600 })
}

/** 读取即删除：普通启动不可能认领一次它没有发起的重启。 */
export function consumeRestartHandoff(path: string, now = new Date()): string | undefined {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return undefined }
  try { rmSync(path, { force: true }) } catch { /* 启动照常进行 */ }
  let parsed: { schemaVersion?: unknown, restartId?: unknown, requestedAt?: unknown } | null
  try { parsed = JSON.parse(text) } catch { return undefined }
  if (parsed === null || parsed.schemaVersion !== 1 || typeof parsed.restartId !== 'string'
    || parsed.restartId.length === 0 || typeof parsed.requestedAt !== 'string') return undefined
  const age = now.getTime() - Date.parse(parsed.requestedAt)
  return Number.isFinite(age) && age <= 60 * 60 * 1000 ? parsed.restartId : undefined
}
```

## 改动 2 — 只接受一次重启请求

`apps/desktop/src/host-process.ts`：在事件联合类型中加入 `{ readonly type: 'desktop-restart-requested'; readonly restartId: string }`，校验函数接受它（`typeof candidate.restartId === 'string' && candidate.restartId.length > 0`），并在关机分支之前处理：

```ts
else if (message.type === 'desktop-restart-requested') {
  // 只接受一次，且必须在开始停止之前：重复请求会拉起第二个应用。
  if (this.restartRequest === undefined && !this.stopping) {
    this.restartRequest = message.restartId
    this.onRestartRequested?.(message.restartId)
  } else if (this.restartRequest !== message.restartId) {
    this.fail(new Error('dsh desktop host requested a restart the shell did not ask for'))
  }
}
```

构造函数追加可选回调 `onRestartRequested?: (restartId: string) => void` 与字段 `restartRequest: string | undefined`。

## 改动 3 — 记录后 relaunch 一次

`apps/desktop/src/main.ts`：

```ts
const previousRestartId = consumeRestartHandoff(restartHandoffPath(app.getPath('userData')))

// 传给 Host 子进程的环境
{
  ...hostEnvironment,
  // 每次启动都广播，不是只在重启后：插件据此判断宿主能否接管重启。
  [DESKTOP_RESTART_PROTOCOL_ENV]: String(DESKTOP_RESTART_PROTOCOL_VERSION),
  ...(previousRestartId === undefined ? {} : { [DESKTOP_RESTART_ID_ENV]: previousRestartId }),
}

let relaunchRequested = false
function requestApplicationRestart(restartId: string): void {
  if (relaunchRequested) return
  try {
    writeRestartHandoff(restartHandoffPath(app.getPath('userData')), restartId)
  } catch (error) {
    // 没有记录，新 Host 无法证明自己；保持运行而不是重启成不可认领状态。
    console.error('desktop restart: could not record the handoff', error)
    return
  }
  relaunchRequested = true
  app.relaunch()
  quitWithoutConfirmation()
}
```

退出时会按正常流程停止 Host，此时 `stopping` 为真，该退出不会进入失败分支，恢复对话框不会出现。

## 插件侧

外壳广播该协议后，插件需要恢复它的能力分支：以正整数 `DSH_DESKTOP_RESTART_PROTOCOL` 为门槛，用 `DSH_POWER_RESTART_ID ?? DSH_DESKTOP_RESTART_ID` 认领，写 v2 marker、有界 flush，然后发送 `desktop-restart-requested`。这部分代码在 PR #9（已关闭、未合并）里，可直接复用。

## 验收

按顺序执行，任一条不通过就说明改动未就绪。

1. Host 子进程环境里有 `DSH_DESKTOP_RESTART_PROTOCOL=1`
2. 重启请求只到达外壳一次；重复发送不会 relaunch 第二次
3. 重启后 `electron` 进程数不变，且只有一个 `dsh-desktop-host` 子进程
4. 新 Host 的 `/health` 报出与请求一致的 `restartId`，`fromInstanceId` 是旧实例
5. 无崩溃报告、无恢复对话框、无孤儿 Host；新端口可以不同（桌面端绑定 `--port 0`）
6. 之后一次普通启动不报重启，且交接记录在读取后已删除

## 已知限制

- `process.send` 只证明消息送达，不证明外壳已接受：若外壳写交接记录失败，它会保持运行，而请求方已被告知接受。
- 桌面端不生成 helper，因此 `restartStatus` 没有条目，确认只看 `/health.restart`。
