/**
 * Locale dictionaries for dsh-power-button (zh / en).
 * Registered under the `power.button` namespace; components receive `t`
 * through the slot's declared `locale:` and follow the DSH UI language.
 */

export const zh = {
  power: '电源',
  powerTitle: '电源（重启 / 关机）',
  powerBusy: '正在重启 / 关机中…',
  restart: '重启',
  restartHint: '重新启动 DeepSeek Harness',
  shutdown: '关机',
  shutdownHint: '停止 DeepSeek Harness，之后需手动启动',
  shutdownStops: '停止 Harness',
  // shutdown confirm dialog (irreversible — confirm before going down)
  // Question-form title: reads as a confirmation prompt, not a page heading.
  shutdownConfirmTitle: '关闭 DeepSeek Harness？',
  shutdownConfirmBody: '关机后 DeepSeek Harness 将停止运行，需要你手动重新启动。',
  confirmShutdown: '关机',
  cancel: '取消',
  // overlay — restart
  restartDialog: '重启 DeepSeek Harness',
  restartClosing: '正在关闭 DeepSeek Harness…',
  restarting: '正在重启…',
  restartPreparing: '正在准备重启…',
  recovering: '正在恢复…',
  restartProblem: '重启出现问题',
  restartSaving: '正在结束进程，即将断开连接',
  restartWaiting: '等待旧进程退出，新实例即将启动',
  restartReady: '新实例已就绪，正在刷新页面',
  // overlay — shutdown
  shutdownDialog: '关机 DeepSeek Harness',
  shutdownClosing: '正在关机 DeepSeek Harness…',
  shutdownWaiting: '正在关机…',
  shutdownProblem: '关机出现问题',
  shutdownSaving: '正在结束进程，即将断开连接',
  shutdownWaitingSub: '等待进程退出',
  off: '已关机',
  offHint: '可以关闭此页面了；需要时请手动重新启动 DSH',
  // errors
  opFailed: '操作失败',
  opFailedHttp: '操作失败 (HTTP {0})',
  restartNoEffect: '重启未生效，请重试',
  restartTimeout: '重启超时，请手动刷新',
  shutdownNoEffect: '未检测到 DSH 进程关闭，请手动确认',
  // errors — why the trust fence refused a destructive request. The server
  // reports a stable reason code; the sentence is localized here so the refusal
  // is actionable instead of a bare "forbidden".
  trustSocketNotLoopback: '请求不是从 loopback 接口进来的。DSH 通过 LAN 地址或端口转发提供服务时会这样，本插件目前只服务 loopback。',
  trustHostMissing: '请求没有携带 Host 头。',
  trustHostUnparseable: 'Host 头不是合法的权威。',
  trustHostUntrusted: 'Host 指向的权威本插件不提供服务：目前只接受 127.0.0.1、::1 和 localhost，比 DSH 自身更窄。',
  trustCrossSite: '浏览器把该请求标记为 sec-fetch-site: cross-site。',
  trustOriginNull: 'Origin 为 null 或无法解析（沙箱 iframe、file: 页面）。',
  trustOriginMismatch: 'Origin 与 Host 权威不相等。若 Host 带端口而 Origin 不带，属于已报告的浏览器行为。',
  retry: '重试',
  close: '关闭',
  // toast — restart complete (UI-only, never written into the session log)
  restartedToast: '已重启',
  restartedToastSub: 'DeepSeek Harness 已重启完成',
} as const

export const en = {
  power: 'Power',
  powerTitle: 'Power (restart / shutdown)',
  powerBusy: 'Restarting / shutting down…',
  restart: 'Restart',
  restartHint: 'Restart DeepSeek Harness',
  shutdown: 'Shutdown',
  shutdownHint: 'Stop DeepSeek Harness; start it manually when needed',
  shutdownStops: 'Stops Harness',
  // shutdown confirm dialog (irreversible — confirm before going down)
  shutdownConfirmTitle: 'Shut down DeepSeek Harness?',
  shutdownConfirmBody: 'After shutdown the process stops and you must start it manually.',
  confirmShutdown: 'Shut down',
  cancel: 'Cancel',
  // overlay — restart
  restartDialog: 'Restart DeepSeek Harness',
  restartClosing: 'Shutting down DeepSeek Harness…',
  restarting: 'Restarting…',
  restartPreparing: 'Preparing to restart…',
  recovering: 'Recovering…',
  restartProblem: 'Restart problem',
  restartSaving: 'Ending processes, connection will drop',
  restartWaiting: 'Waiting for the old process to exit; a new instance is starting',
  restartReady: 'New instance ready, refreshing page',
  // overlay — shutdown
  shutdownDialog: 'Shut down DeepSeek Harness',
  shutdownClosing: 'Shutting down DeepSeek Harness…',
  shutdownWaiting: 'Shutting down…',
  shutdownProblem: 'Shutdown problem',
  shutdownSaving: 'Ending processes, connection will drop',
  shutdownWaitingSub: 'Waiting for the process to exit',
  off: 'Shut down',
  offHint: 'You can close this page now; start DSH manually when needed',
  // errors
  opFailed: 'Operation failed',
  opFailedHttp: 'Operation failed (HTTP {0})',
  restartNoEffect: 'Restart did not take effect, please retry',
  restartTimeout: 'Restart timed out, please refresh manually',
  shutdownNoEffect: 'Could not confirm DSH shut down; please check manually',
  // errors — why the trust fence refused a destructive request
  trustSocketNotLoopback: 'The request did not arrive over the loopback interface. That happens when DSH is served through a LAN address or a port forward; this plugin currently serves loopback only.',
  trustHostMissing: 'The request carried no Host header.',
  trustHostUnparseable: 'The Host header is not a valid authority.',
  trustHostUntrusted: 'The Host names an authority this plugin does not serve: it currently accepts 127.0.0.1, ::1 and localhost only, which is narrower than DSH itself.',
  trustCrossSite: 'The browser marked the request sec-fetch-site: cross-site.',
  trustOriginNull: 'The Origin is null or unparseable (sandboxed iframe, file: page).',
  trustOriginMismatch: 'The Origin does not equal the Host authority. If the Host carries a port and the Origin does not, that is a reported browser behaviour.',
  retry: 'Retry',
  close: 'Close',
  // toast — restart complete (UI-only, never written into the session log)
  restartedToast: 'Restarted',
  restartedToastSub: 'DeepSeek Harness restarted successfully',
} as const
