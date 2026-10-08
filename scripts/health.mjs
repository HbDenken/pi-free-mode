/**
 * Lane health report — which free models answer *from this egress*, right now.
 *
 * Reuses lib/probe.js (the same verdicts the upstream plugin used to feed its
 * picker) instead of adding a runtime probe loop to the plugin. Free lanes go
 * up and down, and some need a non-CN exit; this tells you which is which.
 *
 *   node scripts/health.mjs            # every Zen lane; Kilo rows are listed only
 */

import { probeCatalog, STATE } from '../lib/probe.js'

const rt = await import('../runtime.mjs')
const port = await rt.start(() => {})
const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json()).catch(() => null)
if (!health?.ok) {
  console.error('forward not running')
  process.exit(1)
}
const models = (await fetch(`http://127.0.0.1:${port}/v1/models`).then(r => r.json())).data.map(row => row.id)
await rt.stop()

// Zen ids never carry a namespace slash; every Kilo id does (`kilo-auto/free`).
const zen = models.filter(id => !id.includes('/'))
const kilo = models.filter(id => id.includes('/'))

console.log(`egress probe of ${zen.length} Zen lanes (${kilo.length} Kilo lanes not probed)\n`)
const results = await probeCatalog(zen.map(id => ({ id })), { attributionUserAgent: 'pi-free-mode' }, (id, result) => {
  const mark = result.state === STATE.available ? 'OK  ' : result.state === STATE.regionBlocked ? 'REG ' : result.state === STATE.unavailable ? 'GONE' : '??  '
  console.log(`${mark} ${id.padEnd(34)} ${result.state.padEnd(14)} ${(result.detail ?? `${result.latencyMs}ms`).slice(0, 90)}`)
}, 3)

const bad = Object.entries(results).filter(([, r]) => r.state !== STATE.available)
console.log(`\n${zen.length - bad.length}/${zen.length} Zen lanes answer. ${bad.length ? 'Unusable now: ' + bad.map(([id, r]) => `${id} (${r.state})`).join(', ') : 'all healthy.'}`)
console.log('Pick an OK lane in PI-Desktop. A REG lane needs a non-CN exit; a GONE lane is upstream trouble, retry later.')
