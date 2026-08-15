import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { createAssistantMessage } from "@deepseek-ai/dsh-llm";
//#region src/index.ts
/**
* dsh-restart-button — host half.
*
* Fully self-contained restart & shutdown engine for DeepSeek Harness — no
* dependency on any other plugin (the earlier revision delegated to
* anweat/dsh-restart; this one reimplements the engine here so the plugin is
* an independent repo that works standalone).
*
* Endpoints:
*   POST /api/dsh-restart-button/restart   — relaunch DSH (detached helper)
*   POST /api/dsh-restart-button/shutdown  — stop DSH (graceful exit, no relaunch)
*   GET  /api/dsh-restart-button/health    — liveness probe for the client flow
*
* Model tool:
*   restart_harness — registers the SAME tool name as anweat/dsh-restart so
*   this plugin can stand in for it. If that plugin already registered the
*   name (both installed), the registration is skipped to avoid the
*   "already registered" collision; if only this plugin is installed, the
*   model gets OUR restart tool backed by this host's own engine.
*
* Restart mechanism (Node-native, verified reliable):
*   - The helper MUST run outside this process tree, otherwise killing the
*     dsh web process (which owns this plugin) also kills the helper
*     mid-flight. So the helper is written to a real .cjs FILE under
*     $USERPROFILE\.dsh and spawned as `node <file>` (detached + windowsHide,
*     no console window). A `node -e` one-liner with a multiline script gets
*     mangled on Windows (CreateProcess command line) and dies with a silent
*     SyntaxError — the button then "restarts" into a dead instance.
*   - The helper waits for the listen port to free, then relaunches DSH with
*     the SAME execPath/execArgv/argv/cwd as the current process. The old
*     process self-exits after a short delay so the HTTP response flushes.
*   - No taskkill /T /F (it walks the parent-child chain and kills the helper),
*     no PowerShell (window popup + quoting traps).
*
* Shutdown: a plain `process.exit(0)` after the response flushes — nothing
* relaunches, so DSH stays down until the user starts it again.
*
* Design note (license): the detached-helper relaunch idea is the same
* approach used by anweat/dsh-restart (MIT); the implementation here is
* original — the helper is written to a real .cjs file rather than a `node
* -e` one-liner, which avoids a Windows CreateProcess mangling failure. See
* README for the full attribution note.
* @module dsh-restart-button
*/
const name = "dsh-restart-button";
const inject = [
	"webServer",
	"tools",
	"commands",
	"agents",
	"sessions",
	"sessionPersistence"
];
/** Schemastery schema; cordis validates and provides it as apply(ctx, config). */
const Config = z.object({
	enableModelTool: z.boolean().default(true),
	maxDelayMs: z.number().default(5e3)
});
const BASE = "/api/dsh-restart-button";
/** DSH home per the official contract: explicit $DSH_HOME, else ~/.dsh. */
function dshHome() {
	const env = process.env.DSH_HOME?.trim();
	if (env !== void 0 && env !== "") return path.resolve(env);
	return path.join(os.homedir(), ".dsh");
}
const RUNTIME_DIR = dshHome();
/** Per-instance marker paths (keyed by port). */
function resumeMarkerPath() {
	return path.join(RUNTIME_DIR, `dsh-restart-resume-${CURRENT_PORT}.json`);
}
/** Port this instance serves, resolved at apply time. Markers are keyed by
* port so concurrent instances (e.g. :3080 and :3081) never read each other's
* restart/resume markers — otherwise instance B would consume instance A's
* marker and wrongly report "restarted from A". */
let CURRENT_PORT = 3080;
function markerPath() {
	return path.join(RUNTIME_DIR, `dsh-restart-marker-${CURRENT_PORT}.json`);
}
/** Per-process identity: fixed for this instance's lifetime. The client can
* compare it across a restart to confirm a NEW process answered (stronger
* than "saw a down, then an up" — works even if the down was missed). */
const INSTANCE_ID = randomUUID();
/** Set at apply time when this process is the freshly-restarted instance:
* health reports `restarted: true, fromInstanceId: <old>` so a /restart
* command, the model tool, or a UI click can be confirmed after the fact. */
let restartConfirmation = null;
/** Unique helper file + per-pid log so concurrent DSH instances (e.g. a
* profile on :3080 and the test copy on :3081) cannot overwrite each other's
* restart helper, and logs are attributable per instance. */
const HELPER_FILE = path.join(RUNTIME_DIR, `dsh-restart-helper-${process.pid}-${Date.now()}.cjs`);
const LOG_FILE = path.join(RUNTIME_DIR, `restart-helper-${process.pid}.log`);
/** Restart marker: durable evidence that a restart happened and the current
* process is the NEW instance. Written by restartDsh (intent), updated by the
* helper (relaunch confirmation), read by the new process at apply time.
* Lets a /restart command, the model tool, or a UI click answer the question
* "did it really restart?" — the new instance reports
* `restarted: true, fromInstanceId: <old>` on /health. Keyed by port. */
function readMarker() {
	try {
		return JSON.parse(fs.readFileSync(markerPath(), "utf8"));
	} catch {
		return null;
	}
}
function writeMarker(data) {
	try {
		fs.mkdirSync(RUNTIME_DIR, { recursive: true });
		fs.writeFileSync(markerPath(), JSON.stringify(data), "utf8");
	} catch {}
}
/** Whether THIS process is the freshly-restarted instance. */
function consumeRestartConfirmation() {
	const marker = readMarker();
	if (marker === null) return null;
	const oldId = marker.fromInstanceId;
	if (typeof oldId !== "string" || oldId === INSTANCE_ID) {
		try {
			fs.unlinkSync(markerPath());
		} catch {}
		return null;
	}
	return { fromInstanceId: oldId };
}
/** Session ids that were live (open) at restart time. Recording every live
* session — not only agents currently mid-turn — makes the "已重启"
* confirmation appear even when the restarted session's agent happened to be
* idle at the moment of the restart (e.g. a GUI-button restart while the
* conversation is quiet, or a message that arrived just before the exit). */
function runningSessionIds(ctx) {
	try {
		const live = ctx.sessions.list().map((session) => String(session.id));
		const running = ctx.agents.roots().filter((agent) => agent.status === "running").map((agent) => String(agent.id));
		return [.../* @__PURE__ */ new Set([...live, ...running])];
	} catch {
		return [];
	}
}
function writeResumeMarker(sessionIds) {
	try {
		fs.mkdirSync(RUNTIME_DIR, { recursive: true });
		fs.writeFileSync(resumeMarkerPath(), JSON.stringify({
			sessionIds,
			at: (/* @__PURE__ */ new Date()).toISOString()
		}), "utf8");
	} catch {}
}
function readResumeMarker() {
	try {
		const j = JSON.parse(fs.readFileSync(resumeMarkerPath(), "utf8"));
		return Array.isArray(j.sessionIds) ? j.sessionIds : [];
	} catch {
		return [];
	}
}
function clearResumeMarker() {
	try {
		fs.unlinkSync(resumeMarkerPath());
	} catch {}
}
/**
* Resolve the port the current web server listens on. Prefer the actual
* `--port` argument (the CLI accepts `--port 0` for an OS-assigned port, in
* which case the real port is only known after listen — fall back to the
* webServer service's bound address when available). The helper must wait for
* THIS port to free; a hardcoded 3080 breaks restart on any other port
* (e.g. the test copy on 3081).
*/
function resolvePort(ctx) {
	try {
		const bound = ctx.webServer?.server?.address?.();
		if (bound && typeof bound === "object" && typeof bound.port === "number" && bound.port > 0) return bound.port;
	} catch {}
	const argv = process.argv;
	const idx = argv.indexOf("--port");
	if (idx >= 0 && idx + 1 < argv.length) {
		const n = Number(argv[idx + 1]);
		if (Number.isFinite(n) && n > 0) return n;
	}
	return 3080;
}
function json(res, status, payload) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(payload));
}
/** Append to a log file, rotating (truncating) once it exceeds 1MB so an
* 长期运行的实例不会无限增长。Best-effort: never throws. */
const LOG_MAX_BYTES = 1048576;
function appendLog(file, line) {
	try {
		const { size } = fs.statSync(file);
		if (size > LOG_MAX_BYTES) fs.writeFileSync(file, "", "utf8");
	} catch {}
	try {
		fs.appendFileSync(file, line, "utf8");
	} catch {}
}
try {
	fs.mkdirSync(RUNTIME_DIR, { recursive: true });
	appendLog(LOG_FILE, `${(/* @__PURE__ */ new Date()).toISOString()} loaded execArgv=${JSON.stringify(process.execArgv)} argv=${JSON.stringify(process.argv)} cwd=${process.cwd()}\n`);
} catch {}
/**
* Relaunch DSH. Returns immediately; the actual restart happens in a helper
* that is fully detached from this process tree.
*/
function restartDsh(ctx, delayMs = 1500) {
	try {
		const port = resolvePort(ctx);
		writeMarker({
			fromInstanceId: INSTANCE_ID,
			requestedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
		writeResumeMarker(runningSessionIds(ctx));
		const relaunch = JSON.stringify([
			process.execPath,
			...process.execArgv,
			...process.argv.slice(1)
		]);
		const cwd = process.cwd();
		const serverLog = path.join(RUNTIME_DIR, "dsh-web.log");
		const helperScript = `'use strict';
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const relaunch = ${relaunch};
const cwd = ${JSON.stringify(cwd)};
const PORT = ${port};
const OLD_PID = ${process.pid};
const OLD_INSTANCE = ${JSON.stringify(INSTANCE_ID)};
const MARKER = ${JSON.stringify(markerPath())};
const LOG = ${JSON.stringify(LOG_FILE)};
const SERVER_LOG = ${JSON.stringify(serverLog)};
function log(m) {
  try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + m + '\\n'); } catch {}
}
function pidGone(pid) {
  try { process.kill(pid, 0); return false; } catch { return true; }
}
function portFree(p) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port: p });
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(true));
  });
}
(async () => {
  log('helper up: old pid ' + OLD_PID + ', waiting for it to exit');
  let gone = false;
  for (let i = 0; i < 60; i++) {
    if (pidGone(OLD_PID)) { gone = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!gone) { log('old process never exited - giving up'); cleanup(); return; }
  log('old pid gone, waiting for port ' + PORT + ' to free');
  let freed = false;
  for (let i = 0; i < 60; i++) {
    if (await portFree(PORT)) { freed = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!freed) { log('port never freed - giving up'); cleanup(); return; }
  await new Promise((r) => setTimeout(r, 500)); // settle: let the socket fully release
  log('relaunching: ' + relaunch.join(' ').replace(/((?:api[_-]?key|token|secret|password|auth)=?)[^\s]+/ig, '$1***'));
  const out = fs.openSync(SERVER_LOG, 'a');
  // spawn() reports many failures asynchronously ('error'), not synchronously;
  // wait for 'spawn' to confirm the new process is actually up, retry with
  // short backoff, and only then clean up the helper.
  const RELAUNCH_RETRIES = 3;
  async function tryRelaunch(attempt) {
    if (attempt > RELAUNCH_RETRIES) {
      log('relaunch failed after ' + RELAUNCH_RETRIES + ' attempts - giving up');
      cleanup();
      return;
    }
    const child = spawn(relaunch[0], relaunch.slice(1), {
      cwd, detached: true, stdio: ['ignore', out, out], windowsHide: true,
    });
    const spawned = await new Promise((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    });
    if (spawned) {
      child.unref();
      log('spawned pid ' + child.pid + ' (attempt ' + attempt + ')');
      // Confirm the relaunch in the marker so the new process can prove it
      // is the restarted instance.
      try {
        fs.writeFileSync(MARKER, JSON.stringify({
          fromInstanceId: OLD_INSTANCE,
          requestedAt: new Date().toISOString(),
          newPid: child.pid,
          relaunchedAt: new Date().toISOString(),
        }), 'utf8');
      } catch {}
      cleanup();
    } else {
      log('spawn error on attempt ' + attempt + ', retrying in ' + (attempt * 800) + 'ms');
      await new Promise((r) => setTimeout(r, attempt * 800));
      tryRelaunch(attempt + 1);
    }
  }
  await tryRelaunch(1);
  function cleanup() { try { fs.unlinkSync(__filename); } catch {} }
})();
`;
		fs.mkdirSync(RUNTIME_DIR, { recursive: true });
		fs.writeFileSync(HELPER_FILE, helperScript, "utf8");
		spawn(process.execPath, [HELPER_FILE], {
			detached: true,
			stdio: "ignore",
			windowsHide: true
		}).unref();
		const scheduleExit = () => {
			setTimeout(() => {
				const appExit = ctx.appExit;
				if (typeof appExit === "function") appExit(0);
				else try {
					process.exit(0);
				} catch {}
			}, delayMs);
		};
		try {
			const live = typeof ctx.sessions?.list === "function" ? ctx.sessions.list() : [];
			if (live.length === 0) scheduleExit();
			else Promise.allSettled(live.map((session) => ctx.sessions.flush(session))).then(scheduleExit).catch(scheduleExit);
		} catch {
			scheduleExit();
		}
		return {
			ok: true,
			action: "restart",
			note: "DeepSeek Harness 正在重启"
		};
	} catch (e) {
		return {
			ok: false,
			action: "restart",
			error: e.message
		};
	}
}
/**
* Shut down DSH gracefully. Prefers DSH's official `ctx.appExit` channel
* (launcher-provided), which disposes the plugin tree (sessions, watchers,
* subprocesses) with a bounded grace period instead of hard-killing via
* `process.exit`. Falls back to `process.exit` only when the launcher did
* not provide `appExit` (non-standard embedding).
*
* The exit is armed on THIS response's 'finish' so the client sees the ack
* before the connection drops. Nothing relaunches — the user must start DSH
* again manually.
*/
function shutdownDsh(ctx, res) {
	try {
		const exitNow = () => {
			const appExit = ctx.appExit;
			if (typeof appExit === "function") appExit(0);
			else try {
				process.exit(0);
			} catch {}
		};
		const exitSoon = () => {
			try {
				const live = typeof ctx.sessions?.list === "function" ? ctx.sessions.list() : [];
				if (live.length === 0) {
					exitNow();
					return;
				}
				Promise.allSettled(live.map((session) => ctx.sessions.flush(session))).then(exitNow).catch(exitNow);
			} catch {
				exitNow();
			}
		};
		if (res !== void 0 && typeof res.once === "function") {
			res.once("finish", exitSoon);
			setTimeout(exitSoon, 500).unref();
		} else setTimeout(exitSoon, 300).unref();
		return {
			ok: true,
			action: "shutdown",
			note: "DeepSeek Harness 正在关机（进程停止后需手动重新启动）"
		};
	} catch (e) {
		return {
			ok: false,
			action: "shutdown",
			error: e.message
		};
	}
}
/**
* Trust fence for the destructive POST endpoints. These actions kill the DSH
* process, so a malicious webpage must not trigger them cross-origin (a
* `fetch(..., { mode: 'no-cors' })` still sends the request even though the
* response is unreadable).
*
* Defense in depth — mirrors the official DSH browser-trust fence
* (`isTrustedApiRequest` in dsh-client-connection) without importing the
* client package:
*   1. Loopback socket check — the request must arrive on 127.0.0.1/::1.
*   2. Host-header fence (DNS-rebinding defense): Host must be loopback or a
*      bare 127.0.0.1 authority — a rebound page carries the attacker's
*      domain in Host even though the socket lands here.
*   3. Cross-site fence: an explicit `sec-fetch-site: cross-site` is refused.
*   4. Origin fence: when a browser attaches Origin it must equal Host
*      (normalized); absent Origin is fine (curl/non-browser — Host already
*      bound the request).
*
* NOTE: our `/api/dsh-restart-button/*` prefix is LONGER than the official
* `/api` route, so webServer's longest-prefix-wins matching means these
* requests never pass through the official fence automatically — this guard
* is the only line of defense for them.
*/
function isTrustedPowerRequest(req) {
	const address = req.socket?.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	const { host, origin, "sec-fetch-site": secFetchSite } = req.headers;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	const hn = hostUrl.hostname;
	if (hn !== "127.0.0.1" && hn !== "::1" && hn !== "[::1]" && hn !== "localhost") return false;
	if (typeof secFetchSite === "string" && secFetchSite === "cross-site") return false;
	if (origin === void 0) return true;
	if (typeof origin !== "string" || origin === "null") return false;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
/**
* At-most-once latch for destructive power transitions. Restart and shutdown
* both end the current process; a second POST (duplicate tab, model tool +
* UI race, client retry) must not spawn a second helper or double-exit.
* Claimed on first POST, released only if the action fails synchronously
* (the process is exiting on success, so the latch never needs clearing).
*/
let powerTransition = null;
function claimPowerTransition(action) {
	if (powerTransition !== null) return false;
	powerTransition = action;
	return true;
}
function releasePowerTransition() {
	powerTransition = null;
}
/**
* After a restart, append a visible "restart complete" ASSISTANT message to
* each recorded session — the UI renders it as a normal AI reply, which is
* the semantically correct owner: the assistant informs the user that the
* harness restarted. It is written straight into the session event log, so
* it does NOT depend on the agent being alive and does NOT wake any LLM turn
* (zero token cost). The message becomes part of the session context for the
* next natural turn, which is fine: it is a plain notice, not a prompt.
*
* The event is an `assistant/message` carrying turn 0 / step 0 — a step
* number real turns never use (steps start at 1), so it groups into its own
* assistant bubble at the log tail without colliding with any historical
* turn/step. It carries no usage, so token meters ignore it.
*
* Write safety (the corruption seen when a user message races a restart):
* the session's durable file must stop changing before we append (a dying
* predecessor still draining its write-behind buffer keeps appending), and
* the append is immediately flushed. Polls the session store briefly (a
* resumed session may not be live yet); clears the marker once all notices
* are appended.
*/
function scheduleRestartConfirmation(ctx) {
	const sessionIds = readResumeMarker();
	if (sessionIds.length === 0) {
		clearResumeMarker();
		return;
	}
	if (restartConfirmation === null) {
		clearResumeMarker();
		return;
	}
	const pending = new Set(sessionIds);
	const attempts = /* @__PURE__ */ new Map();
	const interval = setInterval(() => {
		(async () => {
			for (const sessionId of [...pending]) {
				let session;
				try {
					session = ctx.sessions.get(sessionId);
				} catch {}
				if (session === void 0) continue;
				let stable = true;
				try {
					const sp = ctx.sessionPersistence;
					const location = sp !== void 0 && typeof sp.locate === "function" ? sp.locate(session.header) : void 0;
					if (location !== void 0 && typeof location.path === "string") {
						const stamp = () => {
							try {
								const s = fs.statSync(location.path);
								return `${s.size}:${s.mtimeMs}`;
							} catch {
								return;
							}
						};
						const a = stamp();
						await new Promise((r) => setTimeout(r, 400));
						stable = a !== void 0 && a === stamp();
					}
				} catch {}
				if (!stable) {
					const n = (attempts.get(sessionId) ?? 0) + 1;
					attempts.set(sessionId, n);
					if (n >= 15) {
						pending.delete(sessionId);
						try {
							appendLog(LOG_FILE, `${(/* @__PURE__ */ new Date()).toISOString()} restart confirmation skipped for ${sessionId}: file never stabilized\n`);
						} catch {}
					}
					continue;
				}
				try {
					session.append("assistant/message", {
						turn: 0,
						step: 0,
						message: createAssistantMessage({
							content: [{
								type: "text",
								text: "已重启"
							}],
							source: {
								provider: "dsh-restart-button",
								model: "restart-confirmation"
							}
						})
					}, { surfaceOp: "append" });
					try {
						await ctx.sessions.flush(session);
					} catch {}
				} catch (error) {
					try {
						appendLog(LOG_FILE, `${(/* @__PURE__ */ new Date()).toISOString()} restart confirmation append failed for ${sessionId}: ${String(error)}\n`);
					} catch {}
				}
				pending.delete(sessionId);
			}
			if (pending.size === 0) {
				clearInterval(interval);
				clearResumeMarker();
			}
		})();
	}, 1e3);
	interval.unref?.();
}
function apply(ctx, config) {
	CURRENT_PORT = resolvePort(ctx);
	restartConfirmation = consumeRestartConfirmation();
	if (restartConfirmation !== null) {
		try {
			appendLog(LOG_FILE, `${(/* @__PURE__ */ new Date()).toISOString()} restart confirmed: fromInstanceId=${restartConfirmation.fromInstanceId} thisInstanceId=${INSTANCE_ID}\n`);
		} catch {}
		scheduleRestartConfirmation(ctx);
	}
	ctx.on("session/event", (session, event) => {
		if (event?.type === "turn/end" && event.data?.reason?.kind === "aborted") try {
			ctx.sessions.flush(session);
		} catch {}
	});
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: BASE,
		handler: async (req, res) => {
			const sub = new URL(req.url, "http://x").pathname.slice(23).replace(/\/+$/, "") || "/";
			if ((sub === "/restart" || sub === "/shutdown") && req.method === "POST" && !isTrustedPowerRequest(req)) return json(res, 403, {
				ok: false,
				error: "forbidden: cross-origin power request"
			});
			try {
				if (sub === "/restart" && req.method === "POST") {
					if (!claimPowerTransition("restart")) return json(res, 409, {
						ok: false,
						error: `power transition already in progress: ${powerTransition}`
					});
					const result = restartDsh(ctx);
					if (!result.ok) releasePowerTransition();
					return json(res, result.ok ? 200 : 500, result);
				}
				if (sub === "/shutdown" && req.method === "POST") {
					if (!claimPowerTransition("shutdown")) return json(res, 409, {
						ok: false,
						error: `power transition already in progress: ${powerTransition}`
					});
					const result = shutdownDsh(ctx, res);
					if (!result.ok) releasePowerTransition();
					return json(res, result.ok ? 200 : 500, result);
				}
				if (sub === "/health" && req.method === "GET") {
					const body = {
						ok: true,
						instanceId: INSTANCE_ID
					};
					if (restartConfirmation !== null) {
						body.restarted = true;
						body.fromInstanceId = restartConfirmation.fromInstanceId;
					}
					return json(res, 200, body);
				}
				json(res, 404, {
					ok: false,
					error: `no dsh-restart-button endpoint ${sub}`
				});
			} catch (e) {
				releasePowerTransition();
				json(res, 500, {
					ok: false,
					error: e.message
				});
			}
		}
	}), "dsh-restart-button: http routes");
	const cfg = config;
	if (cfg.enableModelTool) try {
		ctx.tools.register({
			name: "restart_harness",
			description: "重启整个 DeepSeek Harness 进程，用于重新加载插件与配置（profile 的 cordis 组合、settings 等）。由 dsh-restart-button 提供（独立实现）：派生一个 detach 的 helper，在旧进程退出并释放端口后以原命令行在原目录重新拉起，然后旧进程退出。触发后当前会话连接会短暂中断，网页随后自动重连到新进程。返回 ok 与说明文本。",
			parameters: {
				type: "object",
				properties: { delayMs: {
					type: "number",
					description: `旧进程退出前等待的毫秒数（给当前结果留出回传时间），默认 2000，上限 ${cfg.maxDelayMs}。`
				} }
			},
			output: {
				schema: {},
				render(_args, value) {
					return [{
						type: "text",
						text: JSON.stringify(value, null, 2)
					}];
				}
			},
			async execute(args) {
				const raw = Number((args ?? {}).delayMs);
				const clamped = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), cfg.maxDelayMs) : 2e3;
				if (!claimPowerTransition("restart")) return {
					ok: false,
					error: `power transition already in progress: ${powerTransition}`
				};
				const result = restartDsh(ctx, clamped);
				if (!result.ok) releasePowerTransition();
				return result;
			}
		});
	} catch (error) {
		if (String(error).includes("already registered")) try {
			appendLog(LOG_FILE, `${(/* @__PURE__ */ new Date()).toISOString()} restart_harness already registered by another plugin; skipping our tool\n`);
		} catch {}
		else throw error;
	}
	ctx.effect(() => {
		ctx.commands.register({
			name: "restart",
			description: "重启 DeepSeek Harness（重载插件与配置）",
			recordInput: false,
			async handler() {
				if (!claimPowerTransition("restart")) return {
					kind: "error",
					text: `power transition already in progress: ${powerTransition}`
				};
				const result = restartDsh(ctx);
				if (!result.ok) releasePowerTransition();
				return result.ok ? {
					kind: "success",
					text: result.note
				} : {
					kind: "error",
					text: result.error ?? "重启失败"
				};
			}
		});
		ctx.commands.register({
			name: "shutdown",
			description: "关机 DeepSeek Harness（停止进程，需手动重新启动）",
			recordInput: false,
			async handler() {
				if (!claimPowerTransition("shutdown")) return {
					kind: "error",
					text: `power transition already in progress: ${powerTransition}`
				};
				const result = shutdownDsh(ctx, void 0);
				if (!result.ok) releasePowerTransition();
				return result.ok ? {
					kind: "success",
					text: result.note
				} : {
					kind: "error",
					text: result.error ?? "关机失败"
				};
			}
		});
	}, "dsh-restart-button: commands");
}
//#endregion
export { Config, apply, inject, name };
