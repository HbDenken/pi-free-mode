/**
 * Align `manifest.json`'s static model roster with the live free-lane catalog.
 *
 * Why this exists: the host composer (and `config_json.models` in `pi.sqlite`)
 * renders ONLY the rows declared in `contributes.providers[].models`. The live
 * catalog is separate, so an upstream addition is served on 127.0.0.1:19401 but
 * invisible in the picker until the manifest declares it AND host-core restarts
 * (the reconcile that writes the provider row runs once per host-core process).
 *
 *   node scripts/sync-manifest.mjs            # dry-run: show the diff
 *   node scripts/sync-manifest.mjs --write    # rewrite manifest.json (backs up)
 *   node scripts/sync-manifest.mjs --write --prune   # also drop rows no longer upstream
 *
 * By default --write only ADDS and refreshes; it never deletes a declared row
 * (it may be region-gated out of this egress's listing, and it carries curated
 * thinking levels the live catalog can't regenerate). Pass --prune to delete.
 * Existing rows pass through byte-identical — this script decides which models
 * are listed, never what a hand-tuned row says.
 *
 * Non-conversational models (a safety classifier, a router) are excluded from
 * the roster via NON_CHAT_MODEL_IDS in runtime.mjs, which the startup drift
 * check reads too. Add ids there, not here.
 *
 * Rows are emitted in live catalog order: Zen first, then Kilo.
 */

import { readFile, writeFile, copyFile } from 'node:fs/promises'

const WRITE = process.argv.includes('--write')

const rt = await import(new URL('../runtime.mjs', import.meta.url).href)
await rt.start(() => {})
const rows = rt.catalogRows()
await rt.stop()

if (rows.length === 0) {
  console.error('live catalog is empty — refusing to rewrite the manifest from nothing')
  process.exit(1)
}

const manifestUrl = new URL('../manifest.json', import.meta.url)
const raw = await readFile(manifestUrl, 'utf8')
const manifest = JSON.parse(raw)
const providers = manifest?.contributes?.providers
if (!Array.isArray(providers) || providers.length === 0) {
  console.error('manifest.json has no contributes.providers[] to sync')
  process.exit(1)
}

// Preserve fields the live catalog does not know about (thinking levels etc.)
// by seeding each synced row from any existing row with the same id.
const existing = new Map()
for (const provider of providers) {
  for (const row of provider?.models ?? []) existing.set(row.id, row)
}
const provider = providers[0]
const prevCount = provider?.models?.length ?? 0

// An existing row passes through byte-identical: sync decides which models are
// listed, never what a hand-tuned row says. The catalog derives names
// mechanically ("Longcat 2 5 Preview Free") where the manifest carries curated
// ones ("LongCat 2.5 Preview (free)"), and the same applies to capacities, so
// regenerating an existing row would only lose information. Metadata comes from
// the live catalog for rows this run is introducing.
const synced = rows.map(row => {
  const prior = existing.get(row.id)
  if (prior) return prior
  return {
    id: row.id,
    name: typeof row.name === 'string' && row.name.trim() ? row.name : row.id,
    contextWindow: row.contextWindow,
    maxTokens: row.maxTokens,
    supportsImages: row.supportsImages,
  }
})

const declared = provider?.models ?? []

// A declared row is never auto-deleted: it may merely be region-gated out of
// this egress's listing, and it carries curated thinkingLevels that the live
// catalog cannot regenerate. Such rows are reported and kept unless --prune.
const live = new Set(synced.map(row => row.id))
const notLive = declared.filter(row => !live.has(row.id))
const added = synced.filter(s => !declared.some(d => d.id === s.id))
const refreshed = synced.filter(s => declared.some(d => d.id === s.id))
const PRUNE = WRITE && process.argv.includes('--prune')

// Live rows first (catalog order, curated fields merged in), then any kept but
// currently-unlisted rows, so a bad egress can never delete roster entries.
const kept = PRUNE ? synced : [...synced, ...notLive]

console.log(`live catalog : ${rows.length} models`)
console.log(`manifest now : ${declared.length} declared rows`)
console.log(`refreshed    : ${refreshed.length} rows`)
console.log(`adding       : ${added.length}  ${added.map(r => r.id).join(', ') || '(none)'}`)
if (notLive.length > 0) {
  console.log(`not live     : ${notLive.length}  ${notLive.map(r => r.id).join(', ')}`)
  console.log(`               kept as-is (region-gated or delisted upstream); --write --prune to delete)`)
}

if (!WRITE) {
  console.log('\nDRY-RUN — pass --write to rewrite manifest.json (a .bak is left beside it).')
  process.exit(0)
}

if (kept.length === 0) {
  console.error('refusing to write an empty model roster')
  process.exit(1)
}

await copyFile(manifestUrl, new URL('../manifest.json.bak', import.meta.url))
provider.models = kept

// Emit with manifest.json's conventional layout: one line per model row.
// Placeholder round-trip — no structural regex over the pretty JSON.
function formatManifest(obj) {
  const rows = new Map()
  let n = 0
  const stubbed = structuredClone(obj)
  for (const p of stubbed.contributes?.providers ?? []) {
    if (!Array.isArray(p.models)) continue
    p.models = p.models.map(row => {
      const key = `@@ROW_${n++}@@`
      rows.set(key, row)
      return key
    })
  }
  const compactRow = row => {
    const parts = Object.entries(row).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    return `{ ${parts.join(', ')} }`
  }
  let json = JSON.stringify(stubbed, null, 2)
  for (const [key, row] of rows) {
    json = json.replace(`"${key}"`, () => compactRow(row))
  }
  return json + '\n'
}

await writeFile(manifestUrl, formatManifest(manifest))
console.log(`\nwrote ${kept.length} rows to manifest.json (backup: manifest.json.bak)`)
console.log('then fully quit + relaunch PI-Desktop so host-core re-reads the roster.')