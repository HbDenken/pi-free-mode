/**
 * Plugin settings shape for pi-free-mode.
 *
 * Settings live in memory for the plugin process lifetime — this port has no
 * durable storage seam (OFM persisted its own JSON file under the harness home;
 * PI-Desktop projects its own plugin config). Only the four live keys below
 * are read by runtime.mjs / adapter.js. The rest of OFM's settings — announcement
 * feed, auto-update, egress outlet, remote gateway, usage stats — are not part
 * of what PI-Desktop uses and are deliberately not carried over.
 *
 * @module src/store.js
 */

export const SETTINGS_INITIAL = {
  /** Shape version. */
  version: 1,
  /** Master switch: when off the routes stay registered but serve nothing. */
  enabled: true,
  /** Show region-limited models in the picker as soon as they answer. */
  exposeRegionModels: true,
  /** Cap a turn's output so a slow lane cannot run away. */
  defaultMaxTokens: 32768,
  /** 允许一次纯推理检查点续写，false 可关闭。 */
  streamRecovery: true,
}
