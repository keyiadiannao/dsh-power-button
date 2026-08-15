# dsh-restart-button

[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek-Harness-blue)](https://github.com/deepseek-ai/DeepSeek-Harness)

[English](README.md) | [中文](README.zh-CN.md)

A self-contained power control plugin for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness): a **power button** in the sidebar footer with an upward **Restart / Shutdown** menu and a full-screen transition overlay. The restart & shutdown engine is built into this plugin — no dependency on other plugins.

> Developed with DeepSeek AI assistance, reviewed before release.

## Features

- **Power button** in the sidebar footer (`sidebar.footer.action`), styled to match the adjacent Settings trigger (34px row, theme tokens — follows light/dark).
- **Upward menu**: Restart / Shutdown, closes on outside click or Esc.
- **Restart**: writes a `.cjs` helper → spawns `node <file>` detached (no console window) → waits for the port to free → relaunches DSH with the same `execPath/execArgv/argv/cwd`, then terminates the old process after the response flushes.
- **Shutdown**: terminates the process without relaunching.
- **Overlay**: Windows-shutdown-style transition screen with ring progress and stage captions; auto-reload after restart.
- **`restart_harness` model tool**: same name as `anweat/dsh-restart`, provided by this plugin when installed alone; skipped if another plugin already owns the name.

## Install

```sh
dsh plugin --profile web add "github:keyiadiannao/dsh-restart-button#master"
```

Restart DSH; a power button appears in the sidebar footer. Requires Node ≥ 22.19.

## How it works

```
click power → menu → Restart
[host]    POST /api/dsh-restart-button/restart
          → write $USERPROFILE/.dsh/restart-helper-<pid>-<ts>.cjs
          → spawn `node <helper>` (detached, windowsHide)
[helper]  wait for old PID to exit → wait for port to free
          → spawn DSH again with same execPath/argv/cwd → self-delete
[host]    terminate after the HTTP response flushes
[client]  poll health → confirm new instanceId → auto reload
```

Shutdown posts `/api/dsh-restart-button/shutdown` and terminates without relaunching.

Design notes (from real issues hit in development):

- The helper must be **outside the process tree** (`detached` + `unref`), otherwise killing DSH kills the helper too.
- The helper is a **real `.cjs` file**, not `node -e`: multi-line `node -e` scripts get mangled by Windows `CreateProcess` and die with a silent `SyntaxError`.

## Safety

- Destructive POSTs are protected by a **same-origin / loopback guard** (CSRF).
- An **at-most-once latch** prevents duplicate restarts from concurrent requests (a second POST gets `409`).
- Restart success is confirmed by the **per-process `instanceId`** changing (old → new), not just a transient down.
- The model tool's `delayMs` is **floored at 1000 ms** — the model cannot kill the process before its own turn settles — and the restart marker is **consumed (deleted) on boot** so a later ordinary launch never misreports a restart.
- Command-line logging is **redacted** (credentials never reach `~/.dsh/restart-helper-<pid>.log`); helper/marker files are written `0600`, the runtime dir `0700`.

## Restart confirmation in the transcript

After a successful restart the plugin appends a `已重启` notice to the resumed
conversation so it appears in the transcript like a normal message (product
requirement). It is **not** a zero-token operation in the strict sense: it is
appended to the conversation **surface** (`surfaceOp: append`), so it may
contribute to input context on later model turns — it just never triggers an
LLM request of its own. It also uses a synthetic `assistant/message`
(`turn:0, step:0`), which is a compatibility measure, not an officially
supported assistant boundary. Tracked upstream:
[deepseek-ai/DeepSeek-Harness#802](https://github.com/deepseek-ai/deepseek-harness/discussions/802)
(downstream plugins cannot persist non-surface events); the intended final
design is a durable, non-surface `restart/completed` event rendered by a
client ConversationNode, which would remove it from the model surface
entirely.

## Development

```sh
npm run build        # tsdown: host + client bundle
npm run typecheck    # tsc --noEmit
npm test             # vitest: marker lifecycle, delayMs clamp, argv redaction
```

Artifacts: host at `lib/index.js`, client bundle at `lib/client.js` (committed — git installs build-free).

## License & Attribution

MIT. The "detached helper relaunch" idea follows [anweat/dsh-restart](https://github.com/anweat/dsh-restart) (MIT); the implementation is independently written (real `.cjs` file, no PowerShell, dynamic port), no code copied.