import z from "@deepseek-ai/schemastery";
//#region src/index.d.ts
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
}
/** Schemastery schema; cordis validates and provides it as apply(ctx, config). */
declare const Config: z<Config>;
/** Per-port marker path. Exported for tests (isolated via DSH_HOME). */
declare function markerPath(): string;
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
} | null;
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
 * child, plugin-owned listener) then keeps the loop alive. The restart helper
 * waits 30s for the old pid and gives up WITHOUT relaunching, so an unbounded
 * graceful exit can leave the user with no server at all. 15s clears DSH's own
 * 5s grace and still lands well inside the helper's patience.
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
/** Startup housekeeping: prune old restart-helper logs so ~/.dsh does not
 * accumulate one file per restart forever. Best-effort, never throws. */
declare function pruneOldRestartLogs(maxAgeDays?: number): void;
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
  requestedAt: string;
}
/**
 * Generate the detached restart helper. A pure function of the payload: the
 * runtime acceptance tests execute its output directly, so what the E2E
 * drives is byte-for-byte what a real restart runs.
 */
declare function buildRestartHelper(p: RestartHelperPayload): string;
declare function apply(ctx: any, config: Config): void;
//#endregion
export { APP_EXIT_WATCHDOG_MS, Config, RestartHelperPayload, apply, buildRestartHelper, clampModelDelayMs, consumeRestartConfirmation, inject, markerPath, name, pruneOldRestartLogs, redactCommandLine, requestAppExit, writeMarker };