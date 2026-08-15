//#region src/index.d.ts
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
declare const name = "dsh-restart-button";
declare const inject: string[];
/** Plugin configuration (editable via the profile's cordis config / settings). */
interface Config {
  /** Register the `restart_harness` model tool. Off by default: allowing the
   * model to restart the whole harness is a higher-privilege action than the
   * GUI power button, so it is opt-in. */
  enableModelTool: boolean;
  /** Upper bound (ms) for the model tool's delayMs argument. */
  maxDelayMs: number;
}
declare function apply(ctx: any): void;
//#endregion
export { Config, apply, inject, name };