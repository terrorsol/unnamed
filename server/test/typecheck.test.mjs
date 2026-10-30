// The server runs TypeScript with types stripped, never compiled: a name that doesn't exist (a variable swallowed by a `//` comment, a typo)
// only shows up at run time, inside a try/catch that hides it. Oct 30: `priceSol` ended up inside a comment on the sniper-tax handler and
// every fast-path capture threw a swallowed ReferenceError. This runs the compiler over the whole server and fails on that class of error
// only (unknown names, use before declaration, wrong argument count) — not on the loose typing the code otherwise relies on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const tsc = new URL('../node_modules/typescript/bin/tsc', import.meta.url).pathname
test('typecheck: no unknown names, no use before declaration, no wrong argument counts in src/', { skip: !existsSync(tsc) && 'typescript not installed' }, () => {
  const r = spawnSync(process.execPath, [tsc, '--noEmit', '--allowImportingTsExtensions', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', '--skipLibCheck', '--strict', 'false', 'src/index.ts', 'src/pumpfast.ts', 'src/txguard.ts'],
    { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', timeout: 240_000 })
  const bad = (r.stdout + r.stderr).split('\n').filter((l) => /error TS(2304|2552|2448|2454|18004|2554|2555|2349|2351)\b/.test(l))
  assert.deepEqual(bad, [])
})
