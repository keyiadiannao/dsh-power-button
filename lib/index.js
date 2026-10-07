import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
//#region src/protocol.ts
/**
* Host→client protocol values shared by both halves of dsh-power-button.
*
* Transport constraint: the host has no dedicated plugin→client event channel
* for UI flows, so the `/shutdown` command carries its confirm request inside
* the command result (`kind: 'error'` — the result kind that reaches the
* client's `command/executed` listener). The value is a namespaced, versioned
* protocol string rather than a bare sentinel: unrelated command errors can
* never trigger the dialog, and a future revision can negotiate via v2 while
* the client keeps accepting v1.
*
* @module dsh-power-button/protocol
*/
/** The `/shutdown` command result text that asks the client to open the GUI
* confirm dialog (the same one the power button uses). */
const SHUTDOWN_CONFIRM_REQUEST = "dsh-power-button:shutdown-confirm:v1";
//#endregion
//#region src/index.ts
/**
* dsh-power-button — host half.
*
* Fully self-contained restart & shutdown engine for DeepSeek Harness — no
* dependency on any other plugin (the earlier revision delegated to
* anweat/dsh-restart; this one reimplements the engine here so the plugin is
* an independent repo that works standalone).
*
* Endpoints:
*   POST /api/dsh-power-button/restart   — relaunch DSH (detached helper)
*   POST /api/dsh-power-button/shutdown  — stop DSH (graceful exit, no relaunch)
*   GET  /api/dsh-power-button/health    — liveness probe for the client flow
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
*     the same invocation and cwd. An ephemeral `--port 0` is pinned to the
*     port this process actually bound, so the successor lands where the helper
*     is waiting. The old process self-exits after a short delay so the HTTP
*     response flushes.
*   - No taskkill /T /F (it walks the parent-child chain and kills the helper),
*     no PowerShell (window popup + quoting traps).
*
* Shutdown: prefers DSH's `ctx.appExit` graceful tree dispose (with
* `process.exit(0)` as fallback for non-standard embeddings); nothing
* relaunches, so DSH stays down until the user starts it again.
*
* Design note (license): the detached-helper relaunch idea is the same
* approach used by anweat/dsh-restart (MIT); the implementation here is
* original — the helper is written to a real .cjs file rather than a `node
* -e` one-liner, which avoids a Windows CreateProcess mangling failure. See
* README for the full attribution note.
* @module dsh-power-button
*/
const PLUGIN_VERSION = createRequire(import.meta.url)("../package.json").version ?? "0.0.0";
const name = "dsh-power-button";
const inject = [
	"webServer",
	"tools",
	"commands",
	"sessions",
	"settings",
	"agents"
];
/**
* Message text for a restart notice, used by both wake modes.
*
* The closing constraint is not decoration: waking a session makes the model
* act without a user turn, so the notice has to bound that action to reporting
* the restart it is about.
*/
function restartNoticeText(restart) {
	return [
		"DeepSeek Harness lifecycle notice: this process restarted successfully.",
		restart.restartId !== void 0 ? `Restart id: ${restart.restartId}.` : "",
		`It replaced instance ${restart.fromInstanceId}; port, profile and working directory are unchanged.`,
		"This restart was requested by this session, and it has already happened — do not repeat it unless something is still wrong.",
		"Report the restart result and continue only what the user asks for next; do not resume other side-effecting work on your own."
	].filter((line) => line !== "").join(" ");
}
/** Schemastery schema; cordis validates and provides it as apply(ctx, config). */
const Config = z.object({
	enableModelTool: z.boolean().default(true),
	maxDelayMs: z.number().default(5e3).min(1e3),
	restartWakeMode: z.union([z.const("quiet"), z.const("notify")]).default("quiet")
});
const BASE = "/api/dsh-power-button";
/** DSH home per the official contract: explicit $DSH_HOME, else ~/.dsh. */
function dshHome() {
	const env = process.env.DSH_HOME?.trim();
	if (env !== void 0 && env !== "") return path.resolve(env);
	return path.join(os.homedir(), ".dsh");
}
const RUNTIME_DIR = dshHome();
/** Port this instance serves, resolved at apply time. Markers are keyed by
* port so concurrent instances (e.g. :3080 and :3081) never read each other's
* restart markers — otherwise instance B would consume instance A's marker
* and wrongly report "restarted from A". */
let CURRENT_PORT = 3080;
/** Per-port marker path. Exported for tests (isolated via DSH_HOME). */
function markerPath() {
	return path.join(RUNTIME_DIR, `dsh-power-marker-${CURRENT_PORT}.json`);
}
/** Per-process identity: fixed for this instance's lifetime. The client can
* compare it across a restart to confirm a NEW process answered (stronger
* than "saw a down, then an up" — works even if the down was missed). */
const INSTANCE_ID = randomUUID();
/** Set at apply time when this process is the freshly-restarted instance.
* Split from the toast acknowledgement: `bootRestart` is this process's
* restart IDENTITY — immutable for its lifetime, reported on /health as
* `restart` forever, so the helper (and future diagnostics) can always tell a
* relaunched instance from a fresh boot. `restartNoticePending` is only the
* UI toast state; ACKing it (/notice-shown) must not erase the identity. */
let bootRestart = null;
let restartNoticePending = false;
/** Unique helper file + per-pid log so concurrent DSH instances (e.g. a
* profile on :3080 and the test copy on :3081) cannot overwrite each other's
* restart helper, and logs are attributable per instance. */
const HELPER_FILE = path.join(RUNTIME_DIR, `dsh-restart-helper-${process.pid}-${Date.now()}.cjs`);
const LOG_FILE = path.join(RUNTIME_DIR, `restart-helper-${process.pid}.log`);
/** Restart marker: durable evidence that a restart happened and the current
* process is the NEW instance. Written by restartDsh (intent), rewritten by
* the helper as a v2 marker bound to a launch env token BEFORE it spawns the
* new process, read by the new process at apply time.
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
/** Record restart intent. Exported for tests (isolated via DSH_HOME). */
function writeMarker(data) {
	try {
		fs.mkdirSync(RUNTIME_DIR, {
			recursive: true,
			mode: 448
		});
		fs.writeFileSync(markerPath(), JSON.stringify(data), {
			encoding: "utf8",
			mode: 384
		});
	} catch {}
}
/**
* Read a recorded restart origin, discarding anything malformed. The marker is
* durable input that outlives the process that wrote it, so an unrecognized
* kind is dropped rather than trusted as an attribution.
*/
function readRestartOrigin(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const record = value;
	const kind = record.kind;
	if (kind !== "model-tool" && kind !== "command" && kind !== "http") return void 0;
	const sessionId = record.sessionId;
	return typeof sessionId === "string" && sessionId.length > 0 ? {
		kind,
		sessionId
	} : { kind };
}
/**
* Whether THIS process is the freshly-restarted instance. Exported for tests.
*
* Two marker generations are accepted:
*  - **v2** (current): the helper writes the marker BEFORE spawning the new
*    process and binds it to that boot with a `DSH_POWER_RESTART_ID` token in
*    the child's environment. A marker only counts when the env token matches,
*    so a manual boot can never claim a restart — and because the marker
*    already exists when the child starts, the new instance can never read
*    "no marker yet" (the v1 race, where the helper confirmed the relaunch
*    only after the child had spawned).
*  - **v1** (plugin 0.2.2 helpers): the helper confirmed the relaunch AFTER
*    spawning by recording the exact child pid. Still accepted so the first
*    restart performed by a pre-upgrade detached helper still reports.
*/
function consumeRestartConfirmation() {
	const envRestartId = process.env.DSH_POWER_RESTART_ID;
	delete process.env.DSH_POWER_RESTART_ID;
	const marker = readMarker();
	if (marker === null) return null;
	const oldId = marker.fromInstanceId;
	if (typeof oldId !== "string" || oldId === INSTANCE_ID) {
		try {
			fs.unlinkSync(markerPath());
		} catch {}
		return null;
	}
	const origin = readRestartOrigin(marker.origin);
	if (marker.schemaVersion === 2 && typeof marker.restartId === "string") {
		try {
			fs.unlinkSync(markerPath());
		} catch {}
		if (envRestartId !== void 0 && marker.restartId === envRestartId) return {
			fromInstanceId: oldId,
			restartId: marker.restartId,
			...origin !== void 0 ? { origin } : {}
		};
		return null;
	}
	const relaunched = typeof marker.relaunchedAt === "string" && Number.isInteger(marker.newPid) && marker.newPid === process.pid;
	try {
		fs.unlinkSync(markerPath());
	} catch {}
	if (!relaunched) return null;
	return {
		fromInstanceId: oldId,
		...origin !== void 0 ? { origin } : {}
	};
}
/** Directory of notices awaiting a live agent, at most one per session. */
function noticeDir() {
	return path.join(RUNTIME_DIR, "power-notice");
}
function noticePath(restartId) {
	return path.join(noticeDir(), `${restartId}.json`);
}
/** The one-line account the `notice` context form carries. */
function restartNoticeSummary(restart) {
	return `DeepSeek Harness restarted (replacing instance ${restart.fromInstanceId})`;
}
/**
* Drop every queued notice already addressed to one session.
*
* A notice says "here is what happened while you were away, do not repeat it",
* so only the newest one for a session is true. Without this, a session that
* stays closed across several restarts would collect the whole backlog and
* receive it in one burst, in directory order, when it finally reopens.
* @param sessionId - the session whose queued notices are superseded.
*/
function dropNoticesForSession(sessionId) {
	let names;
	try {
		names = fs.readdirSync(noticeDir());
	} catch {
		return;
	}
	for (const fileName of names) {
		if (!fileName.endsWith(".json")) continue;
		const file = path.join(noticeDir(), fileName);
		if (readJsonFile(file)?.sessionId !== sessionId) continue;
		try {
			fs.unlinkSync(file);
		} catch {}
	}
}
/**
* Persist one restart's notice, replacing any notice already queued for the
* same session.
*
* Written to disk rather than held in memory so a session that is not live yet
* still receives it after the next boot. A restart whose caller had no causal
* session queues nothing: an origin-less restart must never be attributed to
* whichever conversation happens to be open.
* @param restart - the restart being reported.
* @param mode - whether the notice may wake the session once it is live.
*/
function queueRestartNotice(restart, mode = "quiet") {
	const sessionId = restart.origin?.sessionId;
	if (sessionId === void 0 || sessionId.length === 0) return;
	const restartId = restart.restartId ?? `legacy-${String(Date.now())}`;
	try {
		dropNoticesForSession(sessionId);
		writeJsonAtomic(noticePath(restartId), {
			schemaVersion: 1,
			restartId,
			sessionId,
			summary: restartNoticeSummary(restart),
			text: restartNoticeText(restart),
			mode,
			queuedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
	} catch {}
}
/**
* Deliver every queued notice whose session is live; keep the rest queued.
*
* Delivery is once per notice in normal operation: a delivered notice is
* deleted, so a later boot finds nothing to replay. Two durable states are
* involved and there is no transaction between them — the agent inbox and this
* notice file — so a host crash in the window after the inbox write and before
* the deletion delivers the notice a second time on the next boot. That is
* accepted rather than traded away: claiming the notice first would close the
* duplicate window by opening a lost-notice one, and losing the notice defeats
* its purpose. The notice text is written so that a repeat is harmless — it
* says the restart already happened and that nothing else should be resumed.
*
* A notice whose session is not live is never reassigned to a different session
* and never woken — it waits. At most one notice per session exists, so a
* reconnecting session receives at most one.
*
* A `notify` notice wakes its session with `followup` once it is live, which is
* the only difference from `quiet`: both carry the same text, and neither ever
* restarts again on its own.
* @param ctx - host context carrying the agent registry.
* @returns the number of notices delivered.
*/
function deliverPendingNotices(ctx) {
	let names;
	try {
		names = fs.readdirSync(noticeDir());
	} catch {
		return 0;
	}
	let delivered = 0;
	for (const fileName of names) {
		if (!fileName.endsWith(".json")) continue;
		const file = path.join(noticeDir(), fileName);
		const record = readJsonFile(file);
		if (record === null || typeof record.sessionId !== "string" || typeof record.text !== "string" || typeof record.summary !== "string") {
			try {
				fs.unlinkSync(file);
			} catch {}
			continue;
		}
		const agent = ctx.agents?.get?.(record.sessionId);
		if (agent === void 0 || agent === null) continue;
		const message = createUserMessage({
			content: [{
				type: "text",
				text: record.text
			}],
			source: {
				kind: "dsh-power-button",
				form: "notice",
				summary: record.summary
			}
		});
		try {
			if (record.mode === "notify") agent.followup(message);
			else agent.inject(message);
		} catch {
			continue;
		}
		delivered += 1;
		try {
			appendLog(LOG_FILE, `${(/* @__PURE__ */ new Date()).toISOString()} restart notice delivered to session=${record.sessionId} restartId=${typeof record.restartId === "string" ? record.restartId : "unknown"} mode=${record.mode === "notify" ? "notify" : "quiet"}\n`);
		} catch {}
		try {
			fs.unlinkSync(file);
		} catch {}
	}
	return delivered;
}
/** Whether the newest restart record describes THIS process. */
function recordDescribesThisBoot(record) {
	if (bootRestart === null) return false;
	if (typeof record.restartId !== "string" || typeof bootRestart.restartId !== "string") return record.fromInstanceId === bootRestart.fromInstanceId;
	return record.restartId === bootRestart.restartId;
}
/**
* Read-only view of the most recent restart: the durable record the helper
* wrote, plus whether this process is the instance that restart produced.
*
* This is the authoritative half of restart awareness. A notice reaches the
* session that asked; this answers the question for anyone else — including a
* restart started from the GUI or the command bar, which has no session to
* notify and would otherwise be invisible to a model.
* @param ctx - host context, used to resolve the port the record is keyed by.
* @returns the record, or `{ found: false }` when no restart has happened.
*/
function restartStatus(ctx) {
	const record = readJsonFile(lastRestartPath(resolvePort(ctx)));
	if (record === null && bootRestart === null) return { found: false };
	const requestedAt = record?.requestedAt;
	const readyAt = record?.readyAt;
	const elapsedMs = typeof requestedAt === "string" && typeof readyAt === "string" ? Date.parse(readyAt) - Date.parse(requestedAt) : void 0;
	const optional = {
		restartId: record?.restartId ?? bootRestart?.restartId,
		stage: record?.stage,
		fromInstanceId: record?.fromInstanceId ?? bootRestart?.fromInstanceId,
		toInstanceId: record?.toInstanceId,
		requestedAt,
		readyAt,
		elapsedMs: elapsedMs !== void 0 && Number.isFinite(elapsedMs) ? elapsedMs : void 0,
		origin: record?.origin ?? bootRestart?.origin,
		sessionQuiescent: record?.sessionQuiescent,
		failure: record?.failure
	};
	const status = {
		found: true,
		isCurrentBoot: record === null ? bootRestart !== null : recordDescribesThisBoot(record),
		thisInstanceId: INSTANCE_ID
	};
	for (const [key, value] of Object.entries(optional)) if (value !== void 0) status[key] = value;
	return status;
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
/**
* Rewrite a relaunch argv so the successor binds the SAME port this process
* actually bound.
*
* `--port 0` means "let the OS choose", so replaying the original command line
* verbatim hands the successor a different port. The helper would then probe
* the port this process held until `health-timeout`, while the new instance sat
* healthy on another one; and because the restart marker is keyed by port, the
* successor would look for a marker file that does not exist and could never
* claim its restart identity. Restart means restart in place, so the resolved
* port is pinned into the command line.
*
* An argv with no `--port` is returned unchanged: that port comes from
* configuration, which the successor reads the same way, while adding a flag to
* a command line that did not have one risks introducing an option the app
* never accepted.
* @param argv - this process's arguments after the entry script.
* @param actualPort - the port this process is actually listening on.
* @returns a copy of `argv` with the port pinned, or `argv` unchanged.
*/
function pinRelaunchPort(argv, actualPort) {
	const pinned = [...argv];
	for (let i = 0; i < pinned.length; i++) {
		const arg = pinned[i];
		if (arg === "--port" && i + 1 < pinned.length) {
			pinned[i + 1] = String(actualPort);
			return pinned;
		}
		if (arg?.startsWith("--port=")) {
			pinned[i] = `--port=${String(actualPort)}`;
			return pinned;
		}
	}
	return pinned;
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
/**
* Redact credential-shaped content from a command line before logging.
* Handles both shapes:
*   --api-key=sk-xxx          (inline key=value → value redacted)
*   --api-key sk-xxx          (separate key token → next value redacted)
* Long bare tokens that look like secrets are redacted as a whole so a
* plugin CLI arg that passes a raw credential value cannot leak. Ordinary
* long words ("description", a repo path) would be over-redacted, so the
* bare-token rule only fires when the previous token is a credential key
* OR the token itself looks secret-shaped (starts with a known secret
* prefix such as `sk-`, `ghp_`, `xox`).
*/
function redactCommandLine(parts) {
	const KEY = /^(--?[a-z0-9_-]*)?(api[_-]?key|token|secret|password|passwd|auth|bearer)$/i;
	const INLINE = /((?:api[_-]?key|token|secret|password|passwd|auth|bearer)[=:]\s*)([\w-]{8,})/i;
	const BARE_SECRET = /^(sk-|ghp_|gho_|xox[bap]-|AKIA|-----BEGIN)[\w-]+/i;
	return parts.map((part, index) => {
		if (index > 0 && KEY.test(parts[index - 1] ?? "")) return "***";
		return part.replace(INLINE, "$1***").replace(BARE_SECRET, "***");
	}).join(" ");
}
/** Floor/clamp the model-visible restart delay: the model must never be able
* to kill the process before its own tool/result and turn boundary settle.
* The floor applies whenever a numeric positive delay is given; the ceiling
* (config.maxDelayMs, schema-validated >= 1000) caps every outcome INCLUDING
* the non-numeric fallback, so clamp(anything, maxDelayMs) ∈ [1000, maxDelayMs]. */
function clampModelDelayMs(raw, maxDelayMs) {
	return Math.min(Math.max(Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2e3, 1e3), maxDelayMs);
}
/** Last-resort exit for embeddings that never provided the launcher channel. */
function hardExit() {
	try {
		process.exit(0);
	} catch {}
}
/**
* Bounded grace after the launcher has been asked to exit: DSH disposes the
* application tree with its own 5s cap, but that cap only force-exits while
* disposal is still running — a disposal that resolves early leaves the
* process to end on its own, and one lingering handle (background job, MCP
* child, plugin-owned listener) then keeps the loop alive. The helper gives up
* on the old pid after {@link helperOldPidWaitMs}'s derived bound, and quitting
* then means WITHOUT relaunching, so an unbounded graceful exit can leave the
* user with no server at all. 15s clears DSH's own 5s grace and stays inside
* that bound, which is computed from this constant.
*/
const APP_EXIT_WATCHDOG_MS = 15e3;
/**
* Request the launcher's bounded process exit, falling back to
* {@link hardExit} when the host never provided the channel (non-standard
* embedding) or when the graceful exit has not landed by
* {@link APP_EXIT_WATCHDOG_MS}.
*
* Reads through the global service store (`ctx.get`), NOT the property proxy:
* `appExit` is an optional launcher-provided host value this plugin does not
* declare in `inject`, so `ctx.appExit` is undefined and the graceful branch
* would never run — every restart/shutdown silently took the `process.exit`
* fallback, skipping tree disposal, storage flush, and port release. Official
* readers (dsh-cmdline, dsh-headless) read it through `ctx.get` for the same
* reason.
*
* @param ctx - plugin context; a host without the Cordis store also falls back.
* @param fallbackExit - seam for tests; defaults to the real `process.exit`.
* @param watchdogMs - seam for tests; defaults to {@link APP_EXIT_WATCHDOG_MS}.
*/
function requestAppExit(ctx, fallbackExit = hardExit, watchdogMs = APP_EXIT_WATCHDOG_MS) {
	const appExit = ctx?.get?.("appExit");
	if (typeof appExit !== "function") {
		fallbackExit();
		return;
	}
	appExit(0);
	setTimeout(fallbackExit, watchdogMs).unref?.();
}
/** Startup housekeeping: prune old restart-helper logs and handshake records so
* ~/.dsh does not accumulate one file per restart forever.
*
* The helper SCRIPT is pruned too, and deliberately: it embeds the full
* relaunch argv (which can carry an --api-key), and its self-delete only runs
* on a path the helper reaches itself. A helper that is killed instead of
* finishing — the Host kills a half-armed one when the handshake fails — never
* reaches cleanup(), so the argv-bearing file would otherwise stay forever.
*
* Queued restart notices are pruned on the same window: one whose session never
* comes back must not describe a restart that has long stopped mattering.
* Best-effort, never throws. */
function pruneOldRestartLogs(maxAgeDays = 7) {
	const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1e3;
	const prune = (dir, claims) => {
		let names;
		try {
			names = fs.readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (!claims(name)) continue;
			const full = path.join(dir, name);
			try {
				if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
			} catch {}
		}
	};
	prune(RUNTIME_DIR, (name) => name.startsWith("restart-helper-") && name.endsWith(".log") || name.startsWith("dsh-restart-helper-") && name.endsWith(".cjs"));
	prune(restartDir(), (name) => name.endsWith(".status.json") || name.endsWith(".commit.json"));
	prune(noticeDir(), (name) => name.endsWith(".json"));
}
/** Boot breadcrumb with an ALLOWLIST of diagnostic fields only. The full
* argv is never logged: plugin CLI args can carry credentials (--api-key
* sk-xxx etc), and even a good redactor is one regex away from leaking a
* value. Keep execPath/script/port/profile/pid/cwd-basename only. */
function bootBreadcrumb() {
	const argv = process.argv;
	const portIndex = argv.indexOf("--port");
	const profileIndex = argv.indexOf("--profile");
	const script = argv.find((a) => /(^|[\\/])bin\.(ts|js)$/.test(a)) ?? argv[1] ?? "";
	return [
		`pid=${process.pid}`,
		`execPath=${process.execPath}`,
		`script=${script}`,
		profileIndex > 0 ? `profile=${argv[profileIndex + 1] ?? ""}` : "",
		portIndex > 0 ? `port=${argv[portIndex + 1] ?? ""}` : "",
		`cwd=${path.basename(process.cwd())}`
	].filter(Boolean).join(" ");
}
try {
	fs.mkdirSync(RUNTIME_DIR, {
		recursive: true,
		mode: 448
	});
	appendLog(LOG_FILE, `${(/* @__PURE__ */ new Date()).toISOString()} loaded ${bootBreadcrumb()}\n`);
} catch {}
/** How long the Host waits for the helper to be created, then to ARM. */
const HELPER_ARM_TIMEOUT_MS = 5e3;
/** How long the Host waits for the helper to acknowledge the COMMIT. */
const HELPER_COMMIT_TIMEOUT_MS = 5e3;
/** How long the generated helper waits for the Host's COMMIT before abandoning. */
const HELPER_COMMIT_WAIT_MS = 3e4;
/** How long the generated helper waits for the relaunched DSH to answer /health. */
const HELPER_READY_WAIT_MS = 6e4;
/** Schema version of the handshake status records (not the marker's). */
const RESTART_SCHEMA_VERSION = 2;
/**
* Upper bound on the best-effort pre-exit session flush.
*
* The flush is a durability nicety — `ctx.appExit` disposal is the authority —
* but an unbounded one is a safety hole, not just a slow path. The session
* flush sits between the helper's COMMIT and this process's exit, and the
* helper only waits so long before abandoning a process it believes is stuck.
* A flush that never settles would therefore produce exactly the outcome the
* handshake exists to prevent: nobody left to relaunch.
*/
const PRE_EXIT_FLUSH_CAP_MS = 5e3;
/**
* Extra margin the helper keeps beyond the Host's worst-case exit budget, so
* ordinary scheduling jitter cannot make it abandon a process that is still
* shutting down.
*/
const HELPER_OLD_PID_MARGIN_MS = 15e3;
function sleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
/**
* This process's worst-case time from the helper's COMMIT to actually exiting:
* the capped flush, the delay before the exit is requested, and the graceful
* `ctx.appExit` watchdog that falls back to a hard exit.
* @param delayMs - the delay this restart was asked to observe before exiting.
* @returns milliseconds; the helper's patience is derived from this.
*/
function preExitBudgetMs(delayMs) {
	return PRE_EXIT_FLUSH_CAP_MS + Math.max(0, delayMs) + APP_EXIT_WATCHDOG_MS;
}
/**
* How long the generated helper waits for this process to exit.
*
* Derived from {@link preExitBudgetMs} on purpose. A helper that gives up
* before this process finishes exiting abandons a restart that is still
* completing, and nothing is left to relaunch — the one outcome the handshake
* exists to prevent. Two independently-maintained constants would silently
* re-open that window the next time either side is tuned.
* @param delayMs - the delay this restart was asked to observe before exiting.
* @returns milliseconds, strictly greater than the Host's own budget.
*/
function helperOldPidWaitMs(delayMs) {
	return preExitBudgetMs(delayMs) + HELPER_OLD_PID_MARGIN_MS;
}
/**
* Flush every live session, bounded. Returning late is never worth blocking the
* exit on: the helper is already waiting, and a flush that never settles would
* strand the restart with no process left to relaunch it.
* @param ctx - host context carrying the session service.
* @param capMs - hard upper bound on the wait.
*/
async function flushSessionsBounded(ctx, capMs) {
	try {
		const live = typeof ctx.sessions?.list === "function" ? ctx.sessions.list() : [];
		if (live.length === 0) return;
		const flushing = Promise.allSettled(live.map((session) => ctx.sessions.flush(session)));
		await Promise.race([flushing, sleep(capMs)]);
	} catch {}
}
/** Directory holding per-restart handshake files. */
function restartDir() {
	return path.join(RUNTIME_DIR, "power-restart");
}
function statusPathFor(restartId) {
	return path.join(restartDir(), `${restartId}.status.json`);
}
function commitPathFor(restartId) {
	return path.join(restartDir(), `${restartId}.commit.json`);
}
/** Rolling record of the most recent restart's outcome. Keyed by port. */
function lastRestartPath(port) {
	return path.join(RUNTIME_DIR, `dsh-power-restart-last-${port}.json`);
}
function readJsonFile(file) {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
/** Write JSON through a temp file + rename so a reader never observes a partial record. */
function writeJsonAtomic(file, value) {
	fs.mkdirSync(path.dirname(file), {
		recursive: true,
		mode: 448
	});
	const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value), {
		encoding: "utf8",
		mode: 384
	});
	try {
		fs.renameSync(tmp, file);
	} catch (error) {
		try {
			fs.unlinkSync(tmp);
		} catch {}
		throw error;
	}
}
/**
* Wait for the helper process to exist. Node reports several launch failures
* asynchronously on `error` instead of throwing from `spawn()`, so `spawn` is
* the only positive confirmation that a process was created.
*/
async function waitForHelperSpawn(helper) {
	await new Promise((resolve, reject) => {
		helper.once("spawn", () => {
			resolve();
		});
		helper.once("error", (error) => {
			reject(error);
		});
	});
}
/**
* Poll the helper's status record until `predicate` holds. Matching on both
* restartId and helper pid keeps a stale record from an earlier attempt from
* satisfying a later handshake, and a helper that died can never advance its
* own record, so its exit aborts the wait immediately.
*/
async function waitForHelperStatus(helper, restartId, predicate, timeoutMs) {
	const file = statusPathFor(restartId);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const status = readJsonFile(file);
		if (status !== null && status.restartId === restartId && status.helperPid === helper.pid && predicate(status)) return status;
		if (helper.exitCode !== null || helper.signalCode !== null) throw new Error(`restart helper exited before completing the handshake (code=${String(helper.exitCode)})`);
		if (Date.now() >= deadline) throw new Error(`restart helper did not complete the handshake within ${String(timeoutMs)}ms`);
		await sleep(50);
	}
}
/**
* Generate the detached restart helper. A pure function of the payload: the
* runtime acceptance tests execute its output directly, so what the E2E
* drives is byte-for-byte what a real restart runs.
*/
function buildRestartHelper(p) {
	return `
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const nodePath = require('node:path');
const relaunch = ${JSON.stringify(p.relaunch)};
const cwd = ${JSON.stringify(p.cwd)};
const PORT = ${p.port};
const OLD_PID = ${p.oldPid};
const OLD_INSTANCE = ${JSON.stringify(p.oldInstanceId)};
const RESTART_ID = ${JSON.stringify(p.restartId)};
const MARKER = ${JSON.stringify(p.markerFile)};
const STATUS = ${JSON.stringify(p.statusFile)};
const LAST_STATUS = ${JSON.stringify(p.lastStatusFile)};
const COMMIT = ${JSON.stringify(p.commitFile)};
const LOG = ${JSON.stringify(p.logFile)};
const SERVER_LOG = ${JSON.stringify(p.serverLog)};
const SESSIONS_ROOT = ${JSON.stringify(p.sessionsRoot)};
const COMMIT_WAIT_MS = ${p.commitWaitMs};
const READY_WAIT_MS = ${p.readyWaitMs};
const OLD_PID_WAIT_MS = ${p.oldPidWaitMs};
const RELAUNCH_RETRIES = 3;
const REQUESTED_AT = ${JSON.stringify(p.requestedAt)};
const ORIGIN = ${JSON.stringify(p.origin ?? null)};
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
// Durable-write quiescence check: the OLD process may still be draining its
// session write-behind buffer after its main loop exits (a message or a
// tool/result landing just before the exit). Relaunching before that drain
// finishes lets the NEW process read a file the old one is still appending
// to, and its first writes then interleave stale seq numbers onto the same
// log — the corruption that repeatedly broke sessions. So after the old pid
// is gone and the port is free, poll every session log's (size, mtimeMs)
// until two consecutive samples are identical: only then is the disk quiescent.
// Bounded (~15s): never block the restart forever on a stuck writer.
function sessionsQuiescent(maxWaitMs) {
  const walk = (dir, out) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = dir + nodePath.sep + e.name;
      if (e.isDirectory()) walk(p, out);
      else if (/session\.jsonl/.test(e.name)) {
        try {
          const s = fs.statSync(p);
          out.push(p + ':' + s.size + ':' + Math.floor(s.mtimeMs));
        } catch {}
      }
    }
  };
  const stamp = () => { const out = []; walk(SESSIONS_ROOT, out); return out.sort().join('|'); };
  const deadline = Date.now() + maxWaitMs;
  let prev = stamp();
  return new Promise((resolve) => {
    const tick = () => {
      setTimeout(() => {
        if (Date.now() >= deadline) return resolve(false);
        const cur = stamp();
        if (cur === prev) return resolve(true);
        prev = cur;
        tick();
      }, 400);
    };
    tick();
  });
}
(function () {
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function cleanup() { try { fs.unlinkSync(__filename); } catch {} }
  function writeJsonAtomic(file, value) {
    fs.mkdirSync(nodePath.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = file + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    try { fs.renameSync(tmp, file); }
    catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  }
  let status = {
    schemaVersion: ${RESTART_SCHEMA_VERSION},
    restartId: RESTART_ID,
    port: PORT,
    oldPid: OLD_PID,
    fromInstanceId: OLD_INSTANCE,
    origin: ORIGIN,
    requestedAt: REQUESTED_AT,
  };
  function patchStatus(patch) {
    status = Object.assign({}, status, patch, { updatedAt: new Date().toISOString() });
    // The status record is the ONLY channel the Host reads, so a failed write
    // must not be silent: without it the Host sees a helper that never armed.
    try { writeJsonAtomic(STATUS, status); } catch (e) { log('status write failed: ' + e); }
    try { writeJsonAtomic(LAST_STATUS, status); } catch {}
  }
  function fail(code, message) {
    patchStatus({ stage: 'failed', failure: { code: code, message: message } });
    log('failed: ' + code + ' - ' + message);
    cleanup();
  }
  // The Host writes COMMIT only after it has confirmed this helper is armed;
  // reading it is what authorises the relaunch. Without it the Host is still
  // alive and still owns the restart, so relaunching would race it for the port.
  async function waitForCommit() {
    const deadline = Date.now() + COMMIT_WAIT_MS;
    while (Date.now() < deadline) {
      let data = null;
      try { data = JSON.parse(fs.readFileSync(COMMIT, 'utf8')); } catch {}
      if (data && data.restartId === RESTART_ID) return true;
      await sleep(50);
    }
    return false;
  }
  function getHealth() {
    return new Promise((resolve) => {
      const req = http.get({
        host: '127.0.0.1', port: PORT, path: '/api/dsh-power-button/health', timeout: 2000,
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
  }
  // A successful spawn proves an OS process exists, not that DSH started: a
  // bad config crashes the new process long after 'spawn' fired. Require the
  // /health identity block this restart's launch token produces: the process
  // that answers must (a) run a DIFFERENT instanceId and (b) report THIS
  // restartId — so a port squatter, or an instance relaunched by some other
  // restart, can never pass as ours.
  async function waitForReady(child) {
    const deadline = Date.now() + READY_WAIT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) return null;
      const health = await getHealth();
      if (health && health.ok === true
        && typeof health.instanceId === 'string'
        && health.instanceId !== OLD_INSTANCE
        && health.restart && health.restart.restartId === RESTART_ID) return health;
      await sleep(250);
    }
    return null;
  }
  async function trySpawnOnce(attempt) {
    patchStatus({ stage: 'launching', attempt: attempt });
    const out = fs.openSync(SERVER_LOG, 'a');
    const child = spawn(relaunch[0], relaunch.slice(1), {
      cwd, detached: true, stdio: ['ignore', out, out], windowsHide: true,
      env: Object.assign({}, process.env, { DSH_POWER_RESTART_ID: RESTART_ID }),
    });
    const spawned = await new Promise((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', () => resolve(false));
    });
    if (!spawned) return null;
    child.unref();
    log('spawned pid ' + child.pid + ' (attempt ' + attempt + ')');
    patchStatus({ stage: 'spawned', newPid: child.pid, spawnedAt: new Date().toISOString() });
    return child;
  }
  (async () => {
    // ARM FIRST. Nothing else happens until the Host has been told this helper
    // is alive and running: the Host refuses to let the old process exit
    // without it, and that is the whole guarantee.
    patchStatus({ stage: 'armed', helperPid: process.pid, armedAt: new Date().toISOString() });
    log('helper up: old pid ' + OLD_PID + ', waiting for COMMIT');
    if (!(await waitForCommit())) {
      fail('commit-timeout', 'host never committed the restart handoff');
      return;
    }
    patchStatus({ stage: 'committed', committedAt: new Date().toISOString() });
    log('handoff committed by host, waiting for old pid to exit');
    patchStatus({ stage: 'waiting-old-exit' });
    let gone = false;
    // Bounded by the Host's own exit budget, not by a fixed count: giving up
    // while the old process is still shutting down would leave nobody to
    // relaunch it, which is the one failure the UI cannot recover from.
    const oldPidDeadline = Date.now() + OLD_PID_WAIT_MS;
    while (Date.now() < oldPidDeadline) {
      if (pidGone(OLD_PID)) { gone = true; break; }
      await sleep(500);
    }
    if (!gone) { fail('old-process-still-alive', 'old process did not exit within ' + OLD_PID_WAIT_MS + 'ms'); return; }
    patchStatus({ stage: 'waiting-port', oldExitedAt: new Date().toISOString() });
    log('old pid gone, waiting for port ' + PORT + ' to free');
    let freed = false;
    for (let i = 0; i < 60; i++) {
      if (await portFree(PORT)) { freed = true; break; }
      await sleep(500);
    }
    if (!freed) { fail('port-never-freed', 'port ' + PORT + ' stayed busy'); return; }
    await sleep(500); // settle: let the socket fully release
    // Wait for the old process's session write-behind to drain completely
    // (durable files stable) before the new process touches them. This closes
    // the restart-time corruption window: the new instance must never read a
    // session file the old one is still appending to.
    patchStatus({ stage: 'quiescing', portFreedAt: new Date().toISOString() });
    const quiescent = await sessionsQuiescent(15000);
    patchStatus({ sessionQuiescent: quiescent });
    log(quiescent ? 'session logs quiescent' : 'session logs still moving after 15s - proceeding anyway');
    // Relaunch breadcrumb with an ALLOWLIST only: the full argv is never logged
    // (plugin CLI args can carry credentials, and even a good redactor is one
    // regex away from leaking a value — same rule as the host boot breadcrumb).
    const relaunchExec = relaunch[0] ?? '';
    const relaunchScript = relaunch.find((a) => /(^|[\\/])bin\.(ts|js)$/.test(a)) ?? '';
    log('relaunching: exec=' + relaunchExec + ' script=' + relaunchScript + ' argc=' + relaunch.length);
    // Bind the relaunch to THIS restart BEFORE any child can exist: the marker
    // carries the restartId and the child inherits it as a launch env token,
    // so the new process can claim the restart no matter how early it boots.
    // (The previous protocol confirmed the relaunch in the marker only AFTER
    // the child spawned — a fast boot could read "no marker yet" and miss it.)
    try {
      fs.writeFileSync(MARKER, JSON.stringify({
        schemaVersion: 2,
        restartId: RESTART_ID,
        fromInstanceId: OLD_INSTANCE,
        origin: ORIGIN,
        requestedAt: REQUESTED_AT,
      }), 'utf8');
    } catch {}
    // Retry only when NO process was created. Once a process exists, starting
    // another one would race the first for the port.
    let child = null;
    for (let attempt = 1; attempt <= RELAUNCH_RETRIES; attempt++) {
      child = await trySpawnOnce(attempt);
      if (child !== null) break;
      log('spawn error on attempt ' + attempt);
      if (attempt < RELAUNCH_RETRIES) await sleep(attempt * 800);
    }
    if (child === null) {
      fail('relaunch-failed', 'no new process after ' + RELAUNCH_RETRIES + ' spawn attempts');
      return;
    }
    const health = await waitForReady(child);
    if (health === null) {
      fail('health-timeout', 'new process did not answer /health within ' + READY_WAIT_MS + 'ms');
      return;
    }
    patchStatus({ stage: 'ready', toInstanceId: health.instanceId, readyAt: new Date().toISOString() });
    log('new process ready: instance ' + health.instanceId);
    cleanup();
  })().catch((e) => { fail('helper-crashed', e && e.message ? e.message : String(e)); });
})();
`;
}
/**
* Relaunch DSH through a detached helper.
*
* Resolves only after the helper has taken ownership, at which point this
* process schedules its own exit. Every failure before that point resolves
* `ok: false` and leaves this process running: the caller must be able to
* report a failed restart instead of ending up with no process at all.
*/
async function restartDsh(ctx, delayMs = 1500, origin) {
	const restartId = randomUUID();
	let helper;
	try {
		const port = resolvePort(ctx);
		writeMarker({
			fromInstanceId: INSTANCE_ID,
			requestedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
		const relaunchArgs = [
			process.execPath,
			...process.execArgv,
			...pinRelaunchPort(process.argv.slice(1), port)
		];
		const cwd = process.cwd();
		const serverLog = path.join(RUNTIME_DIR, "dsh-web.log");
		const helperScript = buildRestartHelper({
			relaunch: relaunchArgs,
			cwd,
			port,
			oldPid: process.pid,
			oldInstanceId: INSTANCE_ID,
			restartId,
			markerFile: markerPath(),
			statusFile: statusPathFor(restartId),
			lastStatusFile: lastRestartPath(port),
			commitFile: commitPathFor(restartId),
			logFile: LOG_FILE,
			serverLog,
			sessionsRoot: path.join(RUNTIME_DIR, "sessions"),
			commitWaitMs: HELPER_COMMIT_WAIT_MS,
			readyWaitMs: HELPER_READY_WAIT_MS,
			oldPidWaitMs: helperOldPidWaitMs(delayMs),
			requestedAt: (/* @__PURE__ */ new Date()).toISOString(),
			...origin !== void 0 ? { origin } : {}
		});
		fs.mkdirSync(RUNTIME_DIR, {
			recursive: true,
			mode: 448
		});
		fs.writeFileSync(HELPER_FILE, helperScript, {
			encoding: "utf8",
			mode: 384
		});
		helper = spawn(process.execPath, [HELPER_FILE], {
			detached: true,
			stdio: "ignore",
			windowsHide: true
		});
		helper.on("error", (error) => {
			try {
				appendLog(LOG_FILE, `${(/* @__PURE__ */ new Date()).toISOString()} restart helper error: ${String(error)}\n`);
			} catch {}
		});
		await waitForHelperSpawn(helper);
		await waitForHelperStatus(helper, restartId, (s) => typeof s.armedAt === "string", HELPER_ARM_TIMEOUT_MS);
		writeJsonAtomic(commitPathFor(restartId), {
			schemaVersion: RESTART_SCHEMA_VERSION,
			restartId,
			committedAt: (/* @__PURE__ */ new Date()).toISOString()
		});
		await waitForHelperStatus(helper, restartId, (s) => typeof s.committedAt === "string", HELPER_COMMIT_TIMEOUT_MS);
		helper.unref();
		const scheduleExit = () => {
			setTimeout(() => {
				requestAppExit(ctx);
			}, delayMs);
		};
		flushSessionsBounded(ctx, PRE_EXIT_FLUSH_CAP_MS).then(scheduleExit);
		return {
			ok: true,
			action: "restart",
			restartId,
			note: isEnglishLocale(ctx) ? "DeepSeek Harness is restarting" : "DeepSeek Harness 正在重启"
		};
	} catch (e) {
		if (helper !== void 0) try {
			helper.kill();
		} catch {}
		try {
			fs.unlinkSync(HELPER_FILE);
		} catch {}
		return {
			ok: false,
			action: "restart",
			restartId,
			error: e instanceof Error ? e.message : String(e)
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
			requestAppExit(ctx);
		};
		let exitArmed = false;
		const exitSoon = () => {
			if (exitArmed) return;
			exitArmed = true;
			flushSessionsBounded(ctx, PRE_EXIT_FLUSH_CAP_MS).then(exitNow);
		};
		if (res !== void 0 && typeof res.once === "function") {
			const fallback = setTimeout(exitSoon, 500);
			fallback.unref();
			res.once("finish", () => {
				clearTimeout(fallback);
				exitSoon();
			});
		} else setTimeout(exitSoon, 300).unref();
		return {
			ok: true,
			action: "shutdown",
			note: isEnglishLocale(ctx) ? "DeepSeek Harness is shutting down (start it again manually)" : "DeepSeek Harness 正在关机（进程停止后需手动重新启动）"
		};
	} catch (e) {
		return {
			ok: false,
			action: "shutdown",
			error: e instanceof Error ? e.message : String(e)
		};
	}
}
/** The loopback hostnames this fence accepts, matching upstream. */
const LOOPBACK_HOSTNAMES = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"::1",
	"[::1]",
	"localhost"
]);
/**
* Decide trust and say which rule decided it.
*
* Trust fence for the destructive POST endpoints. These actions kill the DSH
* process, so a malicious webpage must not trigger them cross-origin (a
* `fetch(..., { mode: 'no-cors' })` still sends the request even though the
* response is unreadable).
*
* Defense in depth — applies the official DSH browser-trust rules
* (`isTrustedApiRequest` in dsh-client-connection) without importing the client
* package:
*   1. Loopback socket check — the request must arrive on 127.0.0.1/::1.
*   2. Host-header fence (DNS-rebinding defense): Host must be loopback or a
*      bare 127.0.0.1 authority — a rebound page carries the attacker's
*      domain in Host even though the socket lands here.
*   3. Cross-site fence: an explicit `sec-fetch-site: cross-site` is refused.
*   4. Origin fence: when a browser attaches Origin it must equal Host
*      (normalized); absent Origin is fine (curl/non-browser — Host already
*      bound the request).
*
* Two deliberate differences from the official helper, both narrower, so
* neither can admit a request the official fence would refuse:
*   - Which hostnames count as loopback. The official `isLoopbackHostname`
*     accepts the whole of 127/8 (`127.0.0.2` included); this accepts only
*     127.0.0.1, ::1, ::ffff:127.0.0.1 and localhost.
*   - The loopback-socket rule is applied only while the server is bound to
*     every interface, where an off-box peer is possible and a forged loopback
*     `Host` would otherwise get through. The official fence never looks at the
*     socket at all.
* The authorities the operator declares with `--trusted-host` are honoured, read
* from the host's own `webStartup` values: an authority DSH serves must not be
* refused here for not being loopback. The loopback-socket rule is skipped for
* those, because a declared off-box authority is reached from off-box by
* definition. An upstream change to either rule does not reach this fence by
* itself: the security regression suite pins the current behaviour, so aligning
* is a deliberate edit rather than something that happens by drift.
*
* NOTE: our `/api/dsh-power-button/*` prefix is LONGER than the official
* `/api` route, so webServer's longest-prefix-wins matching means these
* requests never pass through the official fence automatically — this guard
* is the only line of defense for them.
*
* Exported for the security regression suite: this fence is self-maintained, so
* a matrix test is what keeps it from silently drifting.
*
* The reason exists because a bare "forbidden" is not actionable: the first
* reported failure of this fence arrived as an issue with an empty body, since
* the caller could see nothing but the refusal. The rule name is what makes a
* report usable.
* @param req - the incoming request's socket address and headers.
* @returns `{ trusted: true }`, or `{ trusted: false, reason }` naming the rule.
*/
function explainPowerRequestTrust(req, trustedHosts = [], boundHost = "0.0.0.0") {
	const { host, origin, "sec-fetch-site": secFetchSite } = req.headers;
	if (typeof host !== "string") return {
		trusted: false,
		reason: "host-missing"
	};
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return {
			trusted: false,
			reason: "host-unparseable"
		};
	}
	const loopbackHost = LOOPBACK_HOSTNAMES.has(hostUrl.hostname);
	if (!loopbackHost && !matchesTrustedAuthority(hostUrl, trustedHosts)) return {
		trusted: false,
		reason: "host-untrusted"
	};
	if (loopbackHost && boundHost === "0.0.0.0") {
		const address = req.socket?.remoteAddress;
		if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return {
			trusted: false,
			reason: "socket-not-loopback"
		};
	}
	if (typeof secFetchSite === "string" && secFetchSite === "cross-site") return {
		trusted: false,
		reason: "cross-site"
	};
	if (origin === void 0) return { trusted: true };
	if (typeof origin !== "string" || origin === "null") return {
		trusted: false,
		reason: "origin-null"
	};
	try {
		return new URL(origin).host === hostUrl.host ? { trusted: true } : {
			trusted: false,
			reason: "origin-mismatch"
		};
	} catch {
		return {
			trusted: false,
			reason: "origin-mismatch"
		};
	}
}
/**
* Whether a Host authority is one the host declared it serves.
*
* The authorities come from the host's own `ctx.webStartup.trustedHosts` — the
* `--trusted-host` flag — so this consumes the host's decision instead of
* defining a second policy beside it. The matching rule is the official one: an
* entry with a port matches that exact authority, a port-less entry matches the
* hostname on any port.
* @param hostUrl - the parsed Host authority.
* @param trustedHosts - the host's declared authorities.
* @returns true when one entry matches.
*/
function matchesTrustedAuthority(hostUrl, trustedHosts) {
	for (const entry of trustedHosts) {
		let entryUrl;
		try {
			entryUrl = new URL(`http://${entry}`);
		} catch {
			continue;
		}
		if ((entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port) === "" ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host) return true;
	}
	return false;
}
/** Authorities the host declared it serves, read from its own startup values.
* Read through `ctx.get` because `webStartup` is provided by the web bundle: a
* profile without it must not block this plugin from loading. */
function declaredTrustedHosts(ctx) {
	const list = (ctx?.get?.("webStartup"))?.trustedHosts;
	return Array.isArray(list) ? list.filter((entry) => typeof entry === "string") : [];
}
/**
* Whether a destructive POST may proceed. The boolean the rest of the plugin
* branches on; {@link explainPowerRequestTrust} carries the diagnosis.
* @param req - the incoming request's socket address and headers.
* @param trustedHosts - the host's declared authorities, from
* {@link declaredTrustedHosts}.
* @param boundHost - the address the server listens on, from
* {@link boundHostOf}; defaults to the exposed value so a caller that omits it
* keeps the strict check.
* @returns true when every trust rule passes.
*/
function isTrustedPowerRequest(req, trustedHosts = [], boundHost = "0.0.0.0") {
	return explainPowerRequestTrust(req, trustedHosts, boundHost).trusted;
}
/** The address this server listens on, from the host's own web server service.
* Defaults to the exposed value when it cannot be read, so an unreadable host
* keeps the strict socket rule rather than silently relaxing it. */
function boundHostOf(ctx) {
	return ctx?.webServer?.host === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0";
}
/**
* One-line explanation per refusal, returned with the 403. These describe this
* plugin's own policy, never the caller's data, so a refused cross-origin page
* learns nothing it could not read in this MIT-licensed source.
*/
const TRUST_REJECT_HINTS = {
	"socket-not-loopback": "The request asked for a loopback authority but did not arrive over the loopback interface, so it is not a request from this machine.",
	"host-missing": "The request carried no Host header.",
	"host-unparseable": "The Host header is not a valid authority.",
	"host-untrusted": "The Host names an authority this plugin does not serve. It accepts 127.0.0.1, ::1 and localhost, plus any authority the host declared with --trusted-host.",
	"cross-site": "The browser marked the request sec-fetch-site: cross-site.",
	"origin-null": "The Origin header is null or unparseable (sandboxed iframe, file: page).",
	"origin-mismatch": "The Origin does not equal the Host authority. If the Host carries a port and the Origin does not, that is a reported browser behaviour; this fence follows DSH's own rule and refuses it."
};
/**
* Render a caller-supplied header value for a line-oriented log.
*
* Header values reach this plugin from whoever sent the request, so control
* characters are stripped — otherwise a crafted Host could forge extra log
* lines — and the result is capped.
* @param value - the raw header value, or anything else.
* @returns a single safe token, or `<absent>`.
*/
function logSafe(value) {
	if (typeof value !== "string") return "<absent>";
	return value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 120);
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
/** Whether the UI language is English (DSH settings `locale.preference`). */
function isEnglishLocale(ctx) {
	try {
		const locale = ctx.settings?.get?.("locale");
		return (typeof locale?.preference === "string" ? locale.preference.toLowerCase() : "").startsWith("en");
	} catch {}
	return false;
}
function apply(ctx, config) {
	pruneOldRestartLogs();
	CURRENT_PORT = resolvePort(ctx);
	bootRestart = consumeRestartConfirmation();
	restartNoticePending = bootRestart !== null;
	if (bootRestart !== null) {
		try {
			appendLog(LOG_FILE, `${(/* @__PURE__ */ new Date()).toISOString()} restart confirmed: fromInstanceId=${bootRestart.fromInstanceId}` + (bootRestart.restartId !== void 0 ? ` restartId=${bootRestart.restartId}` : "") + ` thisInstanceId=${INSTANCE_ID}\n`);
		} catch {}
		queueRestartNotice(bootRestart, config.restartWakeMode);
	}
	deliverPendingNotices(ctx);
	ctx.effect(() => {
		const off = ctx.on?.("agent/created", () => {
			deliverPendingNotices(ctx);
		});
		return () => {
			if (typeof off === "function") off();
		};
	}, "dsh-power-button: restart notice delivery");
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: BASE,
		handler: async (req, res) => {
			const sub = new URL(req.url ?? "/", "http://x").pathname.slice(21).replace(/\/+$/, "") || "/";
			if ((sub === "/restart" || sub === "/shutdown" || sub === "/notice-shown") && req.method === "POST") {
				const verdict = explainPowerRequestTrust(req, declaredTrustedHosts(ctx), boundHostOf(ctx));
				if (!verdict.trusted) {
					try {
						appendLog(LOG_FILE, `${(/* @__PURE__ */ new Date()).toISOString()} refused ${req.method} ${sub}: ${verdict.reason} host=${logSafe(req.headers.host)} origin=${logSafe(req.headers.origin)} sec-fetch-site=${logSafe(req.headers["sec-fetch-site"])} remote=${logSafe(req.socket?.remoteAddress)}\n`);
					} catch {}
					return json(res, 403, {
						ok: false,
						error: "forbidden: cross-origin power request",
						reason: verdict.reason,
						hint: TRUST_REJECT_HINTS[verdict.reason]
					});
				}
			}
			try {
				if (sub === "/restart" && req.method === "POST") {
					if (!claimPowerTransition("restart")) return json(res, 409, {
						ok: false,
						error: `power transition already in progress: ${powerTransition}`
					});
					const result = await restartDsh(ctx, void 0, { kind: "http" });
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
						instanceId: INSTANCE_ID,
						pluginVersion: PLUGIN_VERSION,
						lifecycle: powerTransition ?? "ready",
						appExit: typeof ctx.get?.("appExit") === "function" ? "available" : "missing"
					};
					if (bootRestart !== null) body.restart = {
						restartId: bootRestart.restartId,
						fromInstanceId: bootRestart.fromInstanceId
					};
					if (restartNoticePending && bootRestart !== null) {
						body.restarted = true;
						body.fromInstanceId = bootRestart.fromInstanceId;
					}
					return json(res, 200, body);
				}
				if (sub === "/notice-shown" && req.method === "POST") {
					restartNoticePending = false;
					return json(res, 200, {
						ok: true,
						action: "notice-shown"
					});
				}
				json(res, 404, {
					ok: false,
					error: `no dsh-power-button endpoint ${sub}`
				});
			} catch (e) {
				releasePowerTransition();
				json(res, 500, {
					ok: false,
					error: e instanceof Error ? e.message : String(e)
				});
			}
		}
	}), "dsh-power-button: http routes");
	const cfg = config;
	if (cfg.enableModelTool) try {
		ctx.tools.register({
			name: "restart_harness",
			description: isEnglishLocale(ctx) ? "Restart the whole DeepSeek Harness process to reload plugins and config (profile cordis layers, settings, etc). Provided by dsh-power-button (standalone): spawns a detached helper that takes ownership of the relaunch, then this process exits; once the old process is gone and its port is free, the helper relaunches DSH with the same command line and cwd. The current session connection drops briefly and the page auto-reconnects. Returns ok and a note." : "重启整个 DeepSeek Harness 进程，用于重新加载插件与配置（profile 的 cordis 组合、settings 等）。由 dsh-power-button 提供（独立实现）：派生一个 detach 的 helper 接管拉起职责，随后本进程退出；待旧进程消失且端口释放后，helper 以原命令行在原目录重新拉起 DSH。触发后当前会话连接会短暂中断，网页随后自动重连到新进程。返回 ok 与说明文本。",
			parameters: {
				type: "object",
				properties: { delayMs: {
					type: "number",
					description: isEnglishLocale(ctx) ? `ms to wait before the old process exits (gives the current result time to flush), default 2000, max ${cfg.maxDelayMs}.` : `旧进程退出前等待的毫秒数（给当前结果留出回传时间），默认 2000，上限 ${cfg.maxDelayMs}。`
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
			async execute(args, exec) {
				const clamped = clampModelDelayMs(Number((args ?? {}).delayMs), cfg.maxDelayMs);
				if (!claimPowerTransition("restart")) return {
					ok: false,
					error: `power transition already in progress: ${powerTransition}`
				};
				const sessionId = exec?.agent?.session?.id;
				const result = await restartDsh(ctx, clamped, typeof sessionId === "string" && sessionId.length > 0 ? {
					kind: "model-tool",
					sessionId
				} : { kind: "model-tool" });
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
	ctx.effect(() => ctx.tools.register({
		name: "restart_status",
		description: isEnglishLocale(ctx) ? "Report the most recent DeepSeek Harness restart: whether one happened, its id, stage, the instance it replaced and the one it produced, timings, who asked for it, and whether THIS process is the instance that restart produced. Read-only; never restarts anything." : "报告最近一次 DeepSeek Harness 重启：是否发生过、restartId、阶段、被替换的实例与新实例、各阶段时间、发起者，以及当前进程是否就是这次重启产生的实例。只读，不会触发任何重启。",
		parameters: {
			type: "object",
			properties: {}
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
		async execute() {
			return restartStatus(ctx);
		}
	}), "dsh-power-button: restart_status tool");
	ctx.effect(() => {
		const en = isEnglishLocale(ctx);
		try {
			ctx.commands.register({
				name: "restart",
				description: en ? "Restart DeepSeek Harness (reload plugins & config)" : "重启 DeepSeek Harness（重载插件与配置）",
				recordInput: false,
				async handler(invocation) {
					if (!claimPowerTransition("restart")) return {
						kind: "error",
						text: `power transition already in progress: ${powerTransition}`
					};
					const sessionId = invocation?.agent?.session?.id;
					const result = await restartDsh(ctx, void 0, typeof sessionId === "string" && sessionId.length > 0 ? {
						kind: "command",
						sessionId
					} : { kind: "command" });
					if (!result.ok) releasePowerTransition();
					return result.ok ? {
						kind: "success",
						text: result.note
					} : {
						kind: "error",
						text: result.error ?? (en ? "restart failed" : "重启失败")
					};
				}
			});
		} catch (error) {
			if (String(error).includes("already registered")) try {
				appendLog(LOG_FILE, `${(/* @__PURE__ */ new Date()).toISOString()} command "restart" already registered by another plugin; skipping ours\n`);
			} catch {}
			else throw error;
		}
		ctx.commands.register({
			name: "shutdown",
			description: en ? "Shut down DeepSeek Harness (stop process; restart manually). Opens a GUI confirm dialog." : "关机 DeepSeek Harness（停止进程，需手动重新启动）。会弹出确认对话框。",
			input: { hint: en ? "opens the shutdown confirm dialog" : "打开关机确认对话框" },
			recordInput: false,
			async handler() {
				return {
					kind: "error",
					text: SHUTDOWN_CONFIRM_REQUEST
				};
			}
		});
	}, "dsh-power-button: commands");
}
//#endregion
export { APP_EXIT_WATCHDOG_MS, Config, PRE_EXIT_FLUSH_CAP_MS, apply, boundHostOf, buildRestartHelper, clampModelDelayMs, consumeRestartConfirmation, declaredTrustedHosts, deliverPendingNotices, explainPowerRequestTrust, flushSessionsBounded, helperOldPidWaitMs, inject, isTrustedPowerRequest, markerPath, name, pinRelaunchPort, preExitBudgetMs, pruneOldRestartLogs, queueRestartNotice, redactCommandLine, requestAppExit, restartNoticeSummary, restartNoticeText, restartStatus, shutdownDsh, writeMarker };
