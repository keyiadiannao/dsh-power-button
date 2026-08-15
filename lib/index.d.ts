import z from "@deepseek-ai/schemastery";
//#region src/index.d.ts
declare const name = "dsh-restart-button";
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
/** Whether THIS process is the freshly-restarted instance. Exported for tests. */
declare function consumeRestartConfirmation(): {
  fromInstanceId: string;
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
 * to kill the process before its own tool/result and turn boundary settle. */
declare function clampModelDelayMs(raw: number, maxDelayMs: number): number;
/** Startup housekeeping: prune old restart-helper logs so ~/.dsh does not
 * accumulate one file per restart forever. Best-effort, never throws. */
declare function pruneOldRestartLogs(maxAgeDays?: number): void;
declare function apply(ctx: any, config: Config): void;
//#endregion
export { Config, apply, clampModelDelayMs, consumeRestartConfirmation, inject, markerPath, name, pruneOldRestartLogs, redactCommandLine, writeMarker };