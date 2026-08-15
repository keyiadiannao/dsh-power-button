/**
 * Locale dictionaries for dsh-restart-button (zh / en).
 * Registered under the `restart.button` namespace; components receive `t`
 * through the slot's declared `locale:` and follow the DSH UI language.
 */

export const zh = {
  power: '电源',
  powerTitle: '电源（重启 / 关机）',
  restart: '重启',
  restartHint: '重新启动 DeepSeek Harness',
  shutdown: '关机',
  shutdownHint: '停止 DeepSeek Harness，之后需手动启动',
  // overlay — restart
  restartDialog: '重启 DeepSeek Harness',
  restartClosing: '正在关闭 DeepSeek Harness…',
  restarting: '正在重启…',
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
  retry: '重试',
  close: '关闭',
} as const

export const en = {
  power: 'Power',
  powerTitle: 'Power (restart / shutdown)',
  restart: 'Restart',
  restartHint: 'Restart DeepSeek Harness',
  shutdown: 'Shutdown',
  shutdownHint: 'Stop DeepSeek Harness; start it manually when needed',
  // overlay — restart
  restartDialog: 'Restart DeepSeek Harness',
  restartClosing: 'Shutting down DeepSeek Harness…',
  restarting: 'Restarting…',
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
  retry: 'Retry',
  close: 'Close',
} as const
