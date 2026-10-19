/**
 * pi-free-mode plugin entry.
 *
 * CommonJS on purpose: a host may `require()` or `import()` this file, and a
 * CJS `module.exports = { onLoad, onUnload }` satisfies both loaders. The
 * runtime itself is ESM (`runtime.mjs`) and is loaded through a dynamic
 * `import()`, which works from CJS on any Node >= 12.17.
 *
 * The forward server is declared in `manifest.json` under
 * `contributes.services` and registered here. `runtime.start()` is
 * idempotent, so the direct call below and a host-driven `start` callback
 * can never double-bind the port.
 */

let runtime = undefined

/** Host command id, declared in manifest.json `contributes.commands`. */
const REFRESH_COMMAND_ID = 'pi-free-mode.refresh-catalog'

async function ensureRuntime() {
  if (runtime === undefined) runtime = await import('./runtime.mjs')
  return runtime
}

async function onLoad() {
  const rt = await ensureRuntime()
  const log = message => console.log(`[pi-free-mode] ${message}`)
  // Long-running HTTP listener: hand it to the host's service supervisor so it
  // survives plugin-process restarts with backoff (contributes.services row).
  if (typeof pi !== 'undefined' && pi?.services?.register) {
    pi.services.register({
      id: 'pifree-forward',
      start: async ({ log: serviceLog } = {}) => {
        await rt.start(typeof serviceLog === 'function' ? serviceLog : log)
      },
      stop: async () => {
        await rt.stop()
      },
    })
  }
  // Manual catalog refresh. The runtime deliberately fetches the Zen/Kilo
  // listings once per process (no timer, no TTL), so upstream additions are
  // otherwise invisible until the plugin is reloaded. This command re-pulls
  // both listings in place, leaving the forward port and provider row alone.
  if (typeof pi !== 'undefined' && pi?.commands?.register) {
    await pi.commands.register({
      id: REFRESH_COMMAND_ID,
      title: 'pi-free-mode: Refresh model catalog',
      keywords: ['pi-free-mode', 'refresh', 'models', 'catalog'],
      run: async () => {
        const before = rt.status()
        const after = await rt.refreshCatalog(log)
        const message = `pi-free-mode: ${before.models} → ${after.models} models (${after.zen} Zen + ${after.kilo} Kilo)`
        log(message)
        if (typeof pi?.ui?.showToast === 'function') pi.ui.showToast(message)
        return after
      },
    })
  }
  // Belt and suspenders: start now as well. Idempotent — if the host already
  // invoked the registered service, this is a no-op; if the host never calls
  // it, the forward port still comes up on activation.
  await rt.start(log)
}

async function onUnload() {
  if (runtime === undefined) return
  try {
    if (typeof pi !== 'undefined' && pi?.commands?.unregister) {
      await pi.commands.unregister(REFRESH_COMMAND_ID)
    }
    await runtime.stop()
  } finally {
    runtime = undefined
  }
}

module.exports = { onLoad, onUnload }
