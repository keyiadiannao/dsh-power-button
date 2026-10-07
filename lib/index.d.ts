import z from "@deepseek-ai/schemastery";
import { ContextFormed } from "@deepseek-ai/dsh-llm";
//#region src/index.d.ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Restart lifecycle notices this plugin queues for the originating session. */
    'dsh-power-button': {
      kind: 'dsh-power-button';
    } & ContextFormed;
  }
}
declare const name = "dsh-power-button";
declare const inject: string[];
/** Plugin configuration (editable via the profile's cordis config / settings). */
interface Config {
  /** Register the `restart_harness` model tool. On by default: the owner uses
   * this plugin with the agent, and the restart is a graceful `ctx.appExit`
   * (tree dispose), not a hard kill. Set false to disable the model tool and
   * keep restart exclusively on the GUI power button. */
  enableModelTool: boolean;
  /** Upper bound (ms) for the model tool's delayMs argument. */
  maxDelayMs: number;
  /**
   * What the session that asked for a restart is told afterwards.
   *
   * `quiet` persists a notice and injects it the next time that session is
   * live, without waking anything. `notify` additionally wakes that session
   * once it is live, so the model reports the restart without the user sending
   * a message. Waking is the only difference; neither mode ever restarts again
   * on its own.
   */
  restartWakeMode: 'quiet' | 'notify';
}
/**
 * Message text for a restart notice, used by both wake modes.
 *
 * The closing constraint is not decoration: waking a session makes the model
 * act without a user turn, so the notice has to bound that action to reporting
 * the restart it is about.
 */
declare function restartNoticeText(restart: {
  fromInstanceId: string;
  restartId?: string;
}): string;
/** Schemastery schema; cordis validates and provides it as apply(ctx, config). */
declare const Config: z<Config>;
/** Per-port marker path. Exported for tests (isolated via DSH_HOME). */
declare function markerPath(): string;
/**
 * Who asked for a restart.
 *
 * `sessionId` is only ever recorded from a caller that actually has a causal
 * agent: the model tool's `exec.agent` or the command's `invocation.agent`. A
 * plain HTTP POST has none, and guessing one would attribute the restart — and
 * any notice derived from it — to an unrelated conversation.
 */
interface RestartOrigin {
  kind: 'model-tool' | 'command' | 'http';
  /** The session that asked, when the caller has one. Never guessed. */
  sessionId?: string;
}
/** Record restart intent. Exported for tests (isolated via DSH_HOME). */
declare function writeMarker(data: Record<string, unknown>): void;
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
declare function consumeRestartConfirmation(): {
  fromInstanceId: string;
  restartId?: string;
  origin?: RestartOrigin;
} | null;
/** The one-line account the `notice` context form carries. */
declare function restartNoticeSummary(restart: {
  fromInstanceId: string;
}): string;
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
declare function queueRestartNotice(restart: {
  fromInstanceId: string;
  restartId?: string;
  origin?: RestartOrigin;
}, mode?: 'quiet' | 'notify'): void;
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
declare function deliverPendingNotices(ctx: any): number;
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
declare function restartStatus(ctx: any): Record<string, unknown>;
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
declare function pinRelaunchPort(argv: readonly string[], actualPort: number): string[];
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
declare function redactCommandLine(parts: readonly string[]): string;
/** Floor/clamp the model-visible restart delay: the model must never be able
 * to kill the process before its own tool/result and turn boundary settle.
 * The floor applies whenever a numeric positive delay is given; the ceiling
 * (config.maxDelayMs, schema-validated >= 1000) caps every outcome INCLUDING
 * the non-numeric fallback, so clamp(anything, maxDelayMs) ∈ [1000, maxDelayMs]. */
declare function clampModelDelayMs(raw: number, maxDelayMs: number): number;
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
declare const APP_EXIT_WATCHDOG_MS = 15000;
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
declare function requestAppExit(ctx: any, fallbackExit?: () => void, watchdogMs?: number): void;
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
declare function pruneOldRestartLogs(maxAgeDays?: number): void;
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
declare const PRE_EXIT_FLUSH_CAP_MS = 5000;
/**
 * This process's worst-case time from the helper's COMMIT to actually exiting:
 * the capped flush, the delay before the exit is requested, and the graceful
 * `ctx.appExit` watchdog that falls back to a hard exit.
 * @param delayMs - the delay this restart was asked to observe before exiting.
 * @returns milliseconds; the helper's patience is derived from this.
 */
declare function preExitBudgetMs(delayMs: number): number;
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
declare function helperOldPidWaitMs(delayMs: number): number;
/**
 * Flush every live session, bounded. Returning late is never worth blocking the
 * exit on: the helper is already waiting, and a flush that never settles would
 * strand the restart with no process left to relaunch it.
 * @param ctx - host context carrying the session service.
 * @param capMs - hard upper bound on the wait.
 */
declare function flushSessionsBounded(ctx: any, capMs: number): Promise<void>;
/** Everything the generated helper needs; every path must be absolute.
 * Exported so the runtime acceptance tests can drive the EXACT shipped helper
 * script against fake target processes instead of a real DSH instance. */
interface RestartHelperPayload {
  relaunch: readonly string[];
  cwd: string;
  port: number;
  oldPid: number;
  oldInstanceId: string;
  restartId: string;
  markerFile: string;
  statusFile: string;
  lastStatusFile: string;
  commitFile: string;
  logFile: string;
  serverLog: string;
  sessionsRoot: string;
  commitWaitMs: number;
  readyWaitMs: number;
  /**
   * How long the helper waits for this process to exit before it gives up.
   * Derived by the Host from its own worst-case exit budget
   * ({@link preExitBudgetMs}) rather than written as a second independent
   * constant: if the helper's patience is ever the shorter of the two, it
   * abandons a process that is still on its way out and nobody relaunches.
   */
  oldPidWaitMs: number;
  requestedAt: string;
  /** Who asked, recorded so the new process can attribute the restart without
   * guessing. Absent when the caller had no causal session. */
  origin?: RestartOrigin;
}
/**
 * Generate the detached restart helper. A pure function of the payload: the
 * runtime acceptance tests execute its output directly, so what the E2E
 * drives is byte-for-byte what a real restart runs.
 */
declare function buildRestartHelper(p: RestartHelperPayload): string;
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
declare function shutdownDsh(ctx: any, res: import('node:http').ServerResponse | undefined): {
  ok: boolean;
  action: string;
  note: string;
  error?: never;
} | {
  ok: boolean;
  action: string;
  error: string;
  note?: never;
};
/** Which rule refused a destructive request. Stable codes: they are reported
 * to the caller and logged, so a user can say what happened instead of
 * reporting an opaque 403. */
type PowerTrustRejectReason = 'socket-not-loopback' | 'host-missing' | 'host-unparseable' | 'host-untrusted' | 'cross-site' | 'origin-null' | 'origin-mismatch';
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
 *   - The rules are reimplemented rather than imported, because the client
 *     connection package is a client-side dependency this host plugin does not
 *     take. That also means this fence has no `trustedHosts` equivalent and
 *     requires a loopback socket, where the official fence checks neither — so
 *     a deployment DSH serves over a LAN authority works for its own `/api` and
 *     still gets 403 here.
 * An upstream change to either rule does not reach this fence by itself: the
 * security regression suite pins the current behaviour, so aligning is a
 * deliberate edit rather than something that happens by drift.
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
declare function explainPowerRequestTrust(req: {
  socket?: {
    remoteAddress?: string | undefined;
  } | undefined;
  headers: Record<string, unknown>;
}): {
  trusted: true;
} | {
  trusted: false;
  reason: PowerTrustRejectReason;
};
/**
 * Whether a destructive POST may proceed. The boolean the rest of the plugin
 * branches on; {@link explainPowerRequestTrust} carries the diagnosis.
 * @param req - the incoming request's socket address and headers.
 * @returns true when every trust rule passes.
 */
declare function isTrustedPowerRequest(req: {
  socket?: {
    remoteAddress?: string | undefined;
  } | undefined;
  headers: Record<string, unknown>;
}): boolean;
declare function apply(ctx: any, config: Config): void;
//#endregion
export { APP_EXIT_WATCHDOG_MS, Config, PRE_EXIT_FLUSH_CAP_MS, PowerTrustRejectReason, RestartHelperPayload, RestartOrigin, apply, buildRestartHelper, clampModelDelayMs, consumeRestartConfirmation, deliverPendingNotices, explainPowerRequestTrust, flushSessionsBounded, helperOldPidWaitMs, inject, isTrustedPowerRequest, markerPath, name, pinRelaunchPort, preExitBudgetMs, pruneOldRestartLogs, queueRestartNotice, redactCommandLine, requestAppExit, restartNoticeSummary, restartNoticeText, restartStatus, shutdownDsh, writeMarker };