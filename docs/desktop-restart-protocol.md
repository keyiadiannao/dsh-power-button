# 桌面端重启：宿主侧改造说明

本文件面向其他 agent，不是本插件已实现的功能。

插件在 Desktop 面无法自主重启：Desktop 的 Host 是 Electron 外壳的子进程，外壳把 Host 的任何退出都当作崩溃并走自己的恢复流程，插件 spawn 的 detached helper 只会留下一个没有窗口、没有 IPC 的第二份 Host。所以本插件在 Desktop 面的行为是**拒绝**：`POST /api/dsh-power-button/{restart,shutdown}` 在创建 helper、写 marker、安排退出之前返回 `503 desktop-unsupported`，界面给出可操作提示。

要让 Desktop 重启真正可用，需要宿主项目（DeepSeek Harness）放开一个生命周期接口。**这超出本插件的边界，采纳与否、以及是否落地，由宿主项目自己决定。** 本文件只提供经过真机验证的最小改造方案。

## 已验证的事实

在 DSH `0.2.1-rc.2` 基线上，按下述改动修改 `apps/desktop` 后，在真实 Electron 环境（开发构建、隔离 home）跑通了完整重启：

```
重启前  shell pid 31444  host pid 28108  端口 57938
POST /api/dsh-power-button/restart → restartId 1090cdc1-…
重启后  shell pid 33088  host pid 7656   端口 59156
        electron 进程数 6 → 6（一个外壳、一个受管 Host，无孤儿）
        崩溃报告 0 个；新 Host 的 /health 报同一个 restartId、fromInstanceId = 旧实例
        之后一次普通启动的 /health 没有 restart 字段（不误报）
```

## 为什么必须改宿主

`apps/desktop/src/host-process.ts` 里，Host 子进程的 `close` 事件**无条件**记为失败：

```ts
child.once('close', (code) => {
  if (code !== 0 && code !== null) this.fail(new Error(`dsh desktop host exited with …`))
  else this.fail(new Error(`dsh desktop host stopped…`))
  resolve()
})
```

退出码 0 也走 `fail()`，于是"被请求的退出"和"崩溃"无法区分。`app.relaunch()` 只出现在致命恢复对话框的按钮里，插件无法触达。

## 需要宿主做的三件事

### 1. 新增 `apps/desktop/src/restart-handoff.ts`

`app.relaunch()` 不传递参数也不传递环境，所以重启身份必须落盘一次，由新外壳读回、注入新 Host。

```ts
export const DESKTOP_RESTART_ID_ENV = 'DSH_DESKTOP_RESTART_ID'
export const DESKTOP_RESTART_PROTOCOL_ENV = 'DSH_DESKTOP_RESTART_PROTOCOL'
export const DESKTOP_RESTART_PROTOCOL_VERSION = 1

export function restartHandoffPath(userData: string): string {
  return join(userData, 'restart-handoff.json')
}

export function writeRestartHandoff(path: string, restartId: string, now = new Date()): void {
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1, restartId, requestedAt: now.toISOString(), pid: process.pid,
  }), { encoding: 'utf8', mode: 0o600 })
}

/** 读取即删除：普通启动不可能认领一次它没有发起的重启；超过一小时视为残留。 */
export function consumeRestartHandoff(path: string, now = new Date()): string | undefined {
  let text: string
  try { text = readFileSync(path, 'utf8') } catch { return undefined }
  try { rmSync(path, { force: true }) } catch { /* 启动照常进行 */ }
  const parsed = JSON.parse(text) as { schemaVersion?: unknown, restartId?: unknown, requestedAt?: unknown } | null
  if (parsed === null || parsed.schemaVersion !== 1 || typeof parsed.restartId !== 'string'
    || parsed.restartId.length === 0 || typeof parsed.requestedAt !== 'string') return undefined
  const age = now.getTime() - Date.parse(parsed.requestedAt)
  return Number.isFinite(age) && age <= 60 * 60 * 1000 ? parsed.restartId : undefined
}
```

### 2. `host-process.ts`：接受一次重启请求

在事件联合类型中加入 `{ readonly type: 'desktop-restart-requested'; readonly restartId: string }`，在校验函数里加对应 case（`typeof candidate.restartId === 'string' && candidate.restartId.length > 0`），并在消息处理链里加：

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

构造函数追加一个可选回调 `onRestartRequested?: (restartId: string) => void`。

### 3. `main.ts`：记录交接并 relaunch 一次

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
    // 没有记录，新 Host 无法证明自己是本次重启的产物，保持运行而不是重启成不可认领状态。
    console.error('desktop restart: could not record the handoff', error)
    return
  }
  relaunchRequested = true
  app.relaunch()
  quitWithoutConfirmation()
}
```

`quitWithoutConfirmation()` 会让外壳按正常流程停止 Host；因为停止方是外壳，`stopping` 为真，`close` 事件不会走失败分支，恢复对话框不会出现。

## 插件侧需要的对应改动

宿主采纳后，本插件还需要一次对应改动才能用上这条协议：

- 能力检测：`DSH_DESKTOP_RESTART_PROTOCOL` 是正整数且 IPC 通道可用，才走桌面交接；否则保持今天的拒绝行为
- 认领：启动身份取 `DSH_POWER_RESTART_ID ?? DSH_DESKTOP_RESTART_ID`，按 `restartId` 跨端口查找 marker
- 交接：写 v2 marker → 有界 flush → 发送 `desktop-restart-requested`

这部分代码已在 PR #9（已关闭、未合并）里实现并测过，可直接作为参照；本仓库当前不包含它。

## 采纳后的验收清单

宿主改完后，按下列顺序验证，任一条不通过就不应发布：

1. 启动 Desktop，`DSH_DESKTOP_RESTART_PROTOCOL=1` 出现在 Host 子进程环境里
2. 插件请求重启，外壳收到一次 `desktop-restart-requested`；**重复发送不会产生第二次 relaunch**
3. 重启后 `electron` 进程数与重启前相同，`dsh-desktop-host` 子进程只有一个
4. 新 Host 的 `/health` 报出与请求一致的 `restartId`，`fromInstanceId` 是旧实例
5. 无崩溃报告、无恢复对话框、无孤儿 Host；新 Host 的监听端口可以与旧的不同（桌面端是 `--port 0`）
6. 之后一次普通启动，`/health` **没有** restart 字段
7. 交接记录文件在读取后被删除；超过一小时未消费的残留不会让下一次普通启动误报

## 不采纳时的后果

本插件在 Desktop 面保持拒绝：点击后得到 `503 desktop-unsupported` 与可操作提示，不会产生孤儿进程或错误的成功提示。这是安全但不够友好的状态，`README` 的 Desktop 小节已如实写明。

## 已知未解决项

- `process.send` 的回调只证明消息送达，不证明外壳已接受请求。若外壳写交接记录失败，它会保持运行，而插件已返回 `ok`。彻底的解法是外壳回一条接受消息，本轮未实现。
- 桌面端不生成 helper，因此没有 `restartStatus` 记录；重启确认只看 `/health.restart`。
