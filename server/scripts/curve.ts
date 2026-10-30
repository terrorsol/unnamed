// read-only: the live server's swap tapes of today's three BANKER coins (for replaying policy changes)
const S = 'https://unnamed-server.onrender.com'
for (const m of ['nUCiRZJQz1xGbGpM5FthfiF8ZUiDqsy9QcnwxvFBANK', 'oLMoTt1bJbtPtY2QXmhWLneYYGXdZcLEeCwjuDRBANK', '6XnV32nSmeYBZBmH5kczp8fLr6ttu2VSfZoK5HbBANK']) {
  const r = await fetch(S + '/tape/' + m, { signal: AbortSignal.timeout(30000) }); const t = await r.text(); console.log('=== TAPE', m, r.status, t.length); console.log(t.trim()) }
process.exit(0)
