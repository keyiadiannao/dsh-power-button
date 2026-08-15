import z from "@deepseek-ai/schemastery";

//#region src/index.d.ts
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
/** Schemastery schema; cordis validates and provides it as apply(ctx, config). */
declare const Config: z<Config>;
declare function apply(ctx: any, config: Config): void;
//#endregion
export { Config, apply, inject, name };