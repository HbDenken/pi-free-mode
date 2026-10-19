/**
 * pi-free-mode runtime — the host-facing half of the plugin.
 *
 * Loads the free model lanes ported from dsh-our-free-model (MIT, see
 * LICENSE.upstream) and exposes them to PI-Desktop as one keyless
 * OpenAI-compatible provider row. The wiring mirrors OFM's own host entry,
 * minus everything host-specific:
 *
 *   boot catalog (Zen listing + Kilo pool)
 *     → FreeModelAdapter (lib/adapter.js, structural, zero DSH imports)
 *     → runForwarded()  (OpenAI request → lane turn → OpenAI chunks)
 *     → startForwardServer() on 127.0.0.1:19401
 *     → manifest provider row (authKind: "none") points at that port
 *
 * What this file deliberately does NOT port: EAC/desktop login channels, the
 * in-app updater, the announcement feed, the usage dashboard, region gating
 * and probing (membership starts as "everything routable"), and persistence
 * (settings live in memory for the process lifetime).
 */

import { FreeModelAdapter, ROUTE_MAIN, ROUTE_REGION } from './lib/adapter.js'
import { buildCatalog, buildKiloCatalog, parseListing } from './lib/catalog.js'
import { getJson } from './lib/http.js'
import { fetchKiloListing } from './lib/kilo.js'
import { startForwardServer, toOpenAiUsage } from './lib/forward.js'
import { mintRequestId, sessionForConversation } from './lib/upstream.js'
import { SETTINGS_INITIAL } from './lib/store.js'
import { STATE } from './lib/probe.js'

/** Sent along with lane requests as the caller attribution UA. */
const attributionUserAgent = 'pi-free-mode'

/** The manifest's `baseUrl` hard-codes this port — keep the two in sync. */
const FORWARD_HOST = '127.0.0.1'
const FORWARD_PORT = 19401

/**
 * Offline roster, used when the Zen listing cannot be fetched. Verified
 * against https://opencode.ai/zen/v1/models (2026-10-16): the free suffix ids
 * that answer without a key. Dead/deprecated ids (nemotron-3-ultra-free,
 * ling-3.0-flash-fin-free, ling-3.1-flash-free, exo-free, fledge-alpha-free)
 * are intentionally excluded so offline failures do not surface dead rows.
 */
const ZEN_FALLBACK_IDS = [
  'mimo-v2.6-flash-free',
  'muse-spark-1.3-contributor-free',
  'muse-spark-1.2-contributor-free',
  'nemotron-3.5-lightning-free',
  'space-bunny-free',
  'jev-1.13-free',
  'longcat-2.5-preview-free',
]

/**
 * Live free models deliberately kept out of the picker. The forward port still
 * serves them and they answer fine, but they are not conversational models, so
 * a picker row would only mislead: a safety classifier replies with a verdict
 * rather than a chat turn, and a router forwards to a target you never chose.
 *
 * Both scripts/sync-manifest.mjs and the startup drift check honour this set,
 * so excluding a model here is the only place needed — it will not come back
 * as undeclared drift on every boot.
 */
export const NON_CHAT_MODEL_IDS = new Set([
  'nvidia/nemotron-3.5-content-safety:free',
  'openrouter/free',
])

// ── state ────────────────────────────────────────────────────────────────────
// Immutable-snapshot model: every adapter call binds to what `state()` returns
// at that moment (catalog + membership + settings), exactly OFM's contract.

let zenCatalog = []
let kiloCatalog = []
let catalog = []
let forward = null

/** In-memory settings; OFM's JsonStore persisted to DSH's home, not available here. */
const settings = { ...SETTINGS_INITIAL }

/**
 * Port of OFM index.js computeMembership: with no probe results every entry
 * is routable on the main lane, and nothing lands on the region lane.
 */
function computeMembership(entries, availabilitySnapshot, pluginSettings) {
  const results = availabilitySnapshot?.results ?? {}
  const expose = pluginSettings?.exposeRegionModels !== false
  const verdictOf = entry => results[entry.id]?.state
  const refusedAll = entries.length > 0 && entries.every(entry => verdictOf(entry) === STATE.unavailable)
  let usable = entries.filter(entry => verdictOf(entry) !== STATE.unavailable)
  if (refusedAll) usable = entries
  const main = []
  const region = []
  for (const entry of usable) {
    const verdict = verdictOf(entry)
    if (verdict !== STATE.regionBlocked) main.push(entry.id)
    else if (expose) region.push(entry.id)
  }
  const membership = {}
  if (main.length > 0) membership[ROUTE_MAIN] = main
  if (region.length > 0) membership[ROUTE_REGION] = region
  return membership
}

/** The immutable snapshot every adapter call binds to. */
const state = () => ({
  catalog,
  membership: computeMembership(catalog, undefined, settings),
  settings,
  attributionUserAgent,
})

/**
 * The one adapter instance. `resolveImage` reports "unresolvable" so image
 * parts are dropped with a warning (documented OFM behavior) rather than
 * crashing; usage/turn recording was the dashboard's, so no-ops.
 */
const adapter = new FreeModelAdapter({
  state,
  resolveImage: () => undefined,
  recordUsage: () => {},
  recordTurn: () => {},
  warn: message => console.warn(`[pi-free-mode] ${message}`),
  onRegionBlocked: () => {},
})

// ── boot ─────────────────────────────────────────────────────────────────────

/** Zen listing, straight through lib/http's getJson (egress-aware base URL). */
async function fetchListing() {
  return getJson('/zen/v1/models', {
    session: sessionForConversation('catalog:pi-free-mode'),
    requestId: mintRequestId(),
    attributionUserAgent,
  })
}

function mergeCatalogs() {
  const seen = new Set()
  const merged = []
  for (const entry of [...zenCatalog, ...kiloCatalog]) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    merged.push(entry)
  }
  catalog = merged
}

async function bootCatalog(log) {
  try {
    const ids = parseListing(await fetchListing())
    if (ids.length > 0) zenCatalog = buildCatalog(ids)
    else throw new Error('empty listing')
  } catch (error) {
    log(`Zen listing failed (${error?.code ?? error?.message ?? 'unknown'}); using offline roster`)
    zenCatalog = buildCatalog(ZEN_FALLBACK_IDS)
  }
  try {
    const payload = await fetchKiloListing()
    if (payload?.error || !Array.isArray(payload?.data)) throw new Error('invalid Kilo model listing')
    kiloCatalog = buildKiloCatalog(payload.data)
  } catch (error) {
    log(`Kilo listing failed (${error?.message ?? 'unknown'}); Kilo models stay unbound until restart`)
    kiloCatalog = []
  }
  mergeCatalogs()
  log(`catalog ready: ${zenCatalog.length} Zen + ${kiloCatalog.length} Kilo = ${catalog.length} models`)
  await logManifestDrift(log)
}

/**
 * Startup drift warning: the host composer renders ONLY the rows declared in
 * `contributes.providers[].models` (they become `config_json.models` at the
 * host-core reconcile), so a live model that is not declared there is invisible
 * in the picker however often the catalog refreshes. Fail-safe: any read/parse
 * problem returns silently and never breaks boot.
 */
async function logManifestDrift(log) {
  const drift = await manifestDrift()
  if (!drift) return
  const list = ids => {
    const head = ids.slice(0, 6).join(', ')
    return ids.length > 6 ? `${head} …(+${ids.length - 6} more)` : head
  }
  if (drift.dead.length > 0) {
    log(`manifest drift: ${drift.dead.length} declared row(s) missing from the live listing (region-gated on this egress, or delisted): ${list(drift.dead)}`)
  }
  if (drift.invisible.length > 0) {
    log(`manifest drift: ${drift.invisible.length} live model(s) not declared (hidden in the composer): ${list(drift.invisible)} — run scripts/sync-manifest.mjs --write, then restart PI-Desktop`)
  }
}

/** Compare the static manifest roster against the live catalog. Null = unreadable. */
async function manifestDrift() {
  let raw
  try {
    const { readFile } = await import('node:fs/promises')
    raw = await readFile(new URL('./manifest.json', import.meta.url), 'utf8')
  } catch {
    return null
  }
  try {
    const manifest = JSON.parse(raw)
    const declared = (manifest?.contributes?.providers ?? [])
      .flatMap(provider => provider?.models ?? [])
      .map(row => row?.id)
      .filter(Boolean)
    const declaredSet = new Set(declared)
    const liveSet = new Set(catalog.map(entry => entry.id))
    return {
      declared,
      dead: declared.filter(id => !liveSet.has(id)),
      invisible: catalog.map(entry => entry.id)
        .filter(id => !declaredSet.has(id))
        .filter(id => !NON_CHAT_MODEL_IDS.has(id)),
    }
  } catch {
    return null
  }
}

// ── request helpers (ported from OFM index.js) ───────────────────────────────

function httpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function fromOpenAiMessages(body, isResponses, modelId) {
  const out = []
  const rows = isResponses
    ? normaliseResponsesInput(body.input)
    : (Array.isArray(body.messages) ? body.messages : [])
  for (const row of rows) {
    const role = row.role ?? 'user'
    const content = []
    if (typeof row.content === 'string') {
      if (row.content !== '') content.push({ type: 'text', text: row.content })
    } else if (Array.isArray(row.content)) {
      for (const part of row.content) {
        if (typeof part === 'string') { if (part !== '') content.push({ type: 'text', text: part }); continue }
        const text = part?.text ?? part?.input_text ?? part?.output_text
        if (typeof text === 'string' && text !== '') content.push({ type: 'text', text })
        const image = part?.image_url?.url ?? part?.image_url
        if (typeof image === 'string' && image !== '') {
          content.push({ type: 'image', attachment: { attachmentId: `url:${image.slice(0, 64)}`, mediaType: 'image/png', bytes: 0, width: 0, height: 0, url: image } })
        }
      }
    }
    if (role === 'tool') {
      out.push({ role: 'tool', content: [{ type: 'text', text: typeof row.content === 'string' ? row.content : JSON.stringify(row.content ?? '') }], toolCallId: row.tool_call_id ?? '', source: { kind: 'tool', callId: row.tool_call_id ?? '' } })
      continue
    }
    if (role === 'assistant' && Array.isArray(row.tool_calls)) {
      for (const call of row.tool_calls) {
        content.push({ type: 'tool-call', id: call.id ?? '', name: call.function?.name ?? '', arguments: call.function?.arguments ?? '{}' })
      }
    }
    if (content.length === 0) continue
    out.push({
      role: role === 'developer' ? 'developer' : role === 'system' ? 'system' : role === 'assistant' ? 'assistant' : 'user',
      content,
      ...role === 'assistant' ? { source: { kind: 'model', provider: ROUTE_MAIN, model: String(modelId ?? '') } } : {},
    })
  }
  return out
}

function normaliseResponsesInput(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }]
  if (!Array.isArray(input)) return []
  return input.map(row => {
    if (typeof row === 'string') return { role: 'user', content: row }
    if (row.type === 'function_call') return { role: 'assistant', content: [], tool_calls: [{ id: row.call_id, function: { name: row.name, arguments: row.arguments } }] }
    if (row.type === 'function_call_output') return { role: 'tool', content: String(row.output ?? ''), tool_call_id: row.call_id }
    return row
  })
}

function normalizeTool(tool) {
  const name = tool?.name ?? tool?.function?.name
  if (typeof name !== 'string' || name.trim() === '') return null
  const parameters = tool?.parameters ?? tool?.function?.parameters ?? { type: 'object', properties: {} }
  return { name, description: String(tool?.description ?? tool?.function?.description ?? ''), parameters }
}

function foldForwardOutcome(outcome, chunk) {
  switch (chunk.type) {
    case 'text-delta': outcome.text += chunk.text; break
    case 'tool-call-delta': {
      let call = outcome.toolCalls.find(candidate => candidate.slot === chunk.index)
      if (call === undefined) { call = { slot: chunk.index, id: chunk.id ?? '', name: chunk.name ?? '', arguments: chunk.argumentsDelta ?? '' }; outcome.toolCalls.push(call) }
      else call.arguments += chunk.argumentsDelta ?? ''
      if (chunk.name) call.name = chunk.name
      if (chunk.id) call.id = chunk.id
      break
    }
    case 'block-end':
      if (chunk.block?.type === 'tool-call') {
        const existing = outcome.toolCalls.find(candidate => candidate.id === chunk.block.id)
        if (existing === undefined) outcome.toolCalls.push({ slot: chunk.index, id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments })
      }
      break
    case 'usage': outcome.usage = toOpenAiUsage(chunk.usage); break
    case 'finish':
      if (chunk.reason?.kind === 'max-tokens') outcome.truncated = true
      if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') outcome.error = chunk.reason.failure?.message
      break
    default: break
  }
  return outcome
}

// ── the forward seam ─────────────────────────────────────────────────────────

/** What the picker selects and the forward port may dial — one definition. */
function routableModelIds() {
  const membership = computeMembership(catalog, undefined, settings)
  return new Set(membership[ROUTE_MAIN] ?? [])
}

function publicModelRows() {
  const membership = routableModelIds()
  return catalog
    .filter(entry => membership.has(entry.id))
    .map(entry => ({
      id: entry.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'pi-free-mode',
      ...entry.contextWindow === undefined ? {} : { context_window: entry.contextWindow },
    }))
}

/**
 * Port of OFM index.js runForwarded: one OpenAI request in, lane chunks
 * folded into one OpenAI-shaped outcome out. `lib/forward.js` streams the
 * answer to the socket from `onChunk` and formats the endpoint envelope.
 */
async function runForwarded(request, onChunk) {
  const entry = catalog.find(candidate => candidate.id === request.model)
  // OpenAI semantics: an unknown model is the caller's mistake (404), and a
  // model the roster hides must not become dialable by naming it.
  if (entry === undefined || !routableModelIds().has(entry.id)) throw httpError(404, `model "${request.model}" not found`)
  const openAi = request.openAi ?? {}
  const messages = fromOpenAiMessages(openAi, request.responses === true, entry.id)
  const tools = (openAi.tools ?? []).map(normalizeTool).filter(Boolean)
  const handler = typeof onChunk === 'function' ? onChunk : () => {}
  const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }

  const options = {
    provider: ROUTE_MAIN,
    model: entry.id,
    messages,
    tools: tools.length > 0 ? tools : undefined,
    ...typeof openAi.temperature === 'number' ? { temperature: openAi.temperature } : {},
    ...typeof openAi.max_tokens === 'number' ? { maxTokens: openAi.max_tokens } : {},
    ...typeof openAi.reasoning_effort === 'string' ? { reasoningEffort: openAi.reasoning_effort } : {},
    sessionId: `forward:${String(openAi.user ?? openAi.conversation ?? 'shared')}`,
    signal: request.signal,
  }

  for await (const chunk of adapter.stream(options, entry, state())) {
    handler(chunk)
    foldForwardOutcome(outcome, chunk)
  }
  // A max-tokens finish means a tool call was cut mid-JSON; do not report the
  // broken call alongside finish_reason "length".
  if (outcome.truncated === true) {
    outcome.toolCalls = outcome.toolCalls.filter(call => {
      try { JSON.parse(call.arguments === '' ? '{}' : call.arguments); return true } catch { return false }
    })
  }
  return outcome
}

// ── lifecycle ────────────────────────────────────────────────────────────────

/**
 * Idempotent: the plugin entry both registers a host service for this server
 * and starts it directly, so a second call must be a no-op.
 * @returns {Promise<number|null>} the bound port, or null when not running.
 */
export async function start(log = message => console.log(`[pi-free-mode] ${message}`)) {
  if (forward !== null) return forward.port
  await bootCatalog(log)
  forward = await startForwardServer({
    config: () => ({ enabled: true, host: FORWARD_HOST, port: FORWARD_PORT, key: '' }),
    complete: (request, onChunk) => runForwarded(request, onChunk),
    modelRows: () => publicModelRows(),
    log: message => log(message),
  })
  if (forward.fellBack) {
    log(`WARNING: port ${FORWARD_PORT} was taken; bound ${forward.port} instead. The provider row points at ${FORWARD_PORT} — free it and restart, or edit the manifest baseUrl.`)
  }
  log(`forward listening on http://${forward.host}:${forward.port}/v1`)
  return forward.port
}

export async function stop() {
  const bound = forward
  forward = null
  if (bound !== null) {
    await bound.close()
    console.log('[pi-free-mode] forward server stopped')
  }
}

/**
 * Re-fetch the Zen and Kilo listings without restarting the process.
 * Safe to call from a host command, UI action, or after an upstream change.
 * Re-merges into the live `catalog` reference so the running forward server
 * and adapter instantly route the new model set.
 */
export async function refreshCatalog(log = message => console.log(`[pi-free-mode] ${message}`)) {
  await bootCatalog(log)
  return status()
}

/** Small status surface for smoke tests and the README's troubleshooting. */
export function status() {
  return {
    running: forward !== null,
    port: forward?.port ?? null,
    requestedPort: FORWARD_PORT,
    fellBack: forward?.fellBack ?? false,
    models: catalog.length,
    zen: zenCatalog.length,
    kilo: kiloCatalog.length,
  }
}

/**
 * Live catalog as manifest-shaped rows (id + name + contextWindow) — the
 * picker roster, i.e. the live catalog minus NON_CHAT_MODEL_IDS. Read by
 * scripts/sync-manifest.mjs, whose diff against the manifest is exactly the set
 * of conversational models that exist upstream but stay invisible until synced.
 */
export function catalogRows() {
  return catalog
    .filter(entry => !NON_CHAT_MODEL_IDS.has(entry.id))
    .map(entry => ({
      id: entry.id,
      name: entry.name,
      contextWindow: entry.contextWindow ?? null,
      maxTokens: entry.maxOutput ?? null,
      supportsImages: entry.vision === true,
      channel: entry.channel ?? 'zen',
    }))
}
