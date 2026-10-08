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

  // 7. Tool-call round-trip (issue #20's seam). The free tier's gate makes the
  // plugin declare the bash/glob/grep/read quartet even when the caller has no
  // such tools, so the wire owes the caller two things: tool_calls renumbered
  // from 0 (upstream indices are shared with reasoning/text blocks), and the
  // caller's own tool spelling back (a `pwsh` slot filled as `bash` upstream
  // must come back as `pwsh`). Asserted as invariants on whatever the model
  // returns — a model that answers in prose instead of calling is a pass here,
  // since that is model behaviour, not the forwarder's contract.
  const declared = ['pwsh', 'get_time']
  const toolRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mimo-v2.6-flash-free',
      messages: [{ role: 'user', content: '立刻调用 pwsh 工具的 run_command 命令执行 echo hi。不要直接回答，必须先调用工具。' }],
      max_tokens: 4096,
      stream: true,
      tools: declared.map(name => ({
        type: 'function',
        function: {
          name,
          description: name === 'pwsh' ? 'Run a shell command.' : 'Get the current time.',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      })),
    }),
  })
  check('tool-call stream HTTP 200', toolRes.status === 200, `HTTP ${toolRes.status}`)
  const toolEvents = (await toolRes.text())
    .split('\n\n')
    .filter(block => block.includes('data:'))
    .map(block => block.split('data: ').pop())
    .filter(payload => payload && payload !== '[DONE]')
    .map(payload => { try { return JSON.parse(payload) } catch { return null } })
    .filter(Boolean)
  const calls = new Map()
  let sawSparseIndex = false
  for (const event of toolEvents) {
    for (const delta of event.choices?.[0]?.delta?.tool_calls ?? []) {
      if (typeof delta.index === 'number' && delta.index > calls.size) sawSparseIndex = true
      const key = delta.id ?? delta.index ?? calls.size
      if (!calls.has(key)) calls.set(key, { index: delta.index, name: '', args: '' })
      const call = calls.get(key)
      if (delta.function?.name) call.name = delta.function.name
      if (delta.function?.arguments) call.args += delta.function.arguments
    }
  }
  const assembled = [...calls.values()].filter(call => call.name !== '')
  check('tool_calls reindexed from 0', !sawSparseIndex, assembled.map(call => `${call.name}(${call.args.slice(0, 40)})`).join(' ') || 'model answered in prose')
  const leakedDecoy = assembled.filter(call => !declared.includes(call.name))
  check('no undeclared/decoy tool leaked', leakedDecoy.length === 0, leakedDecoy.map(call => call.name).join(','))
  const badArgs = assembled.filter(call => {
    if (call.args === '') return false
    try { JSON.parse(call.args); return false } catch { return true }
  })
  check('tool arguments valid JSON', badArgs.length === 0, badArgs.map(call => `${call.name}:${call.args.slice(0, 40)}`).join(' '))

  // 8. Client abort mid-stream must not leak the upstream connection or hang
  // the listener: cancel the body, then prove the same listener still serves.
  const abortController = new AbortController()
  const abortRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mimo-v2.6-flash-free',
      messages: [{ role: 'user', content: '写一篇 2000 字的说明文，主题：自由软件的历史。' }],
      max_tokens: 4096,
      stream: true,
    }),
    signal: abortController.signal,
  }).catch(() => null)
  if (abortRes?.ok) {
    const reader = abortRes.body.getReader()
    await reader.read()
    await reader.cancel().catch(() => {})
  }
  abortController.abort()
  await new Promise(resolve => setTimeout(resolve, 1500))
  const afterAbort = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json()).catch(() => null)
  check('listener survives client abort', afterAbort?.ok === true, JSON.stringify(afterAbort))
} catch (error) {
  check('smoke run', false, `${error?.message ?? error}`)
  console.error(error?.stack ?? '')
} finally {
  await rt.stop().catch(() => {})
}

console.log(failed ? '[smoke] RESULT: FAILED' : '[smoke] RESULT: ALL PASS')
process.exit(failed ? 1 : 0)
