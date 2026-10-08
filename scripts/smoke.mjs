/**
 * pi-free-mode end-to-end smoke test — no PI-Desktop required.
 *
 * Boots the runtime exactly as the plugin entry does, then exercises every
 * seam: the forward listener, the model roster, and one real turn through
 * the OpenCode Zen anonymous lane. Exit code 0 means the whole port works.
 *
 *   node scripts/smoke.mjs
 */

const log = message => console.log(`[smoke] ${message}`)
let failed = false
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

const rt = await import('../runtime.mjs')

try {
  // 1. Boot: catalog (live listings) + forward listener.
  const port = await rt.start(log)
  check('forward started', Number.isFinite(port), `port ${port}`)
  const status = rt.status()
  check('catalog populated', status.models > 0, `${status.zen} Zen + ${status.kilo} Kilo = ${status.models}`)

  // 2. Liveness, keyless (authKind "none" rows send no bearer).
  const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json())
  check('health endpoint', health?.ok === true, JSON.stringify(health))

  // 3. Roster endpoint.
  const models = await fetch(`http://127.0.0.1:${port}/v1/models`).then(r => r.json())
  const ids = (models?.data ?? []).map(row => row.id)
  check('model roster', ids.length > 0, `${ids.length} models`)
  check('zen model present', ids.includes('mimo-v2.6-flash-free'))
  check('kilo model present', ids.some(id => id.includes('/')), ids.find(id => id.includes('/')))

  // 4. Unknown model is an OpenAI-style 404, not a crash.
  const bogus = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] }),
  })
  check('unknown model 404', bogus.status === 404, `HTTP ${bogus.status}`)

  // 5. One real non-streaming turn through the Zen anonymous lane.
  const zenRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mimo-v2.6-flash-free',
      messages: [{ role: 'user', content: '只回复两个字：收到' }],
      max_tokens: 4096,
      stream: false,
    }),
  })
  const zenBody = await zenRes.json().catch(() => null)
  const zenText = zenBody?.choices?.[0]?.message?.content ?? ''
  check('zen turn HTTP 200', zenRes.status === 200, `HTTP ${zenRes.status}`)
  check('zen turn answered', typeof zenText === 'string' && zenText.length > 0, JSON.stringify(zenText.slice(0, 80)))

  // 6. One real streaming turn through the Kilo free pool (SSE re-framed).
  const kiloId = ids.find(id => id.startsWith('kilo-auto/') || id.includes(':free'))
  if (kiloId) {
    const streamRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: kiloId,
        messages: [{ role: 'user', content: '只回复两个字：收到' }],
        max_tokens: 4096,
        stream: true,
      }),
    })
    const text = await streamRes.text()
    const chunks = text.split('\n\n').filter(block => block.includes('data:'))
    const deltas = chunks
      .map(block => block.split('data: ').pop())
      .filter(payload => payload && payload !== '[DONE]')
      .map(payload => { try { return JSON.parse(payload) } catch { return null } })
      .filter(Boolean)
    const streamedText = deltas.map(delta => delta.choices?.[0]?.delta?.content ?? '').join('')
    check('kilo stream HTTP 200', streamRes.status === 200, `HTTP ${streamRes.status}`)
    check('kilo stream deltas', deltas.length > 0, `${deltas.length} SSE events`)
    check('kilo stream answered', streamedText.length > 0, JSON.stringify(streamedText.slice(0, 80)))
  } else {
    check('kilo stream skipped (pool empty at boot)', false)
  }
} catch (error) {
  check('smoke run', false, `${error?.message ?? error}`)
  console.error(error?.stack ?? '')
} finally {
  await rt.stop().catch(() => {})
}

console.log(failed ? '[smoke] RESULT: FAILED' : '[smoke] RESULT: ALL PASS')
process.exit(failed ? 1 : 0)
