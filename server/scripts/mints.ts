// Feed the branded-mint pool. Run anywhere with solana-keygen on PATH (https://docs.anza.xyz/cli/install):
//   npm run mints -- grind 50                       → grinds 50 keys ending in BANK into ./mints/ (multi-threaded)
//   npm run mints -- push https://<server> <ADMIN_KEY> → uploads every key in ./mints/ to the server pool and deletes the local file once accepted
//   npm run mints -- grind 50 push https://<server> <ADMIN_KEY>   → both, repeat with `loop` as the last word to keep topping up forever
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'

const SUFFIX = process.env.MINT_SUFFIX || 'BANK'
const args = process.argv.slice(2); const DIR = './mints'; mkdirSync(DIR, { recursive: true })
const threads = String(Math.max(1, (await import('node:os')).cpus().length - 1))
const grind = (n: number) => { console.log(`grinding ${n} keys ending in ${SUFFIX} with ${threads} threads…`); const r = spawnSync('solana-keygen', ['grind', '--ends-with', `${SUFFIX}:${n}`, '--num-threads', threads], { cwd: DIR, stdio: 'inherit' }); if (r.status !== 0) throw new Error('solana-keygen failed — is it installed? https://docs.anza.xyz/cli/install') }
const push = async (server: string, key: string) => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(SUFFIX + '.json')); if (!files.length) { console.log('nothing to push'); return }
  const keys = files.map((f) => bs58.encode(Uint8Array.from(JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')))))
  const r = await fetch(`${server.replace(/\/$/, '')}/admin/mints?key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys }) })
  const j: any = await r.json(); if (!r.ok) throw new Error(j.error || r.status)
  for (const f of files) { const pub = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')))).publicKey.toBase58(); if (j.added.includes(pub) || j.rejected.some((x: string) => x.includes(pub))) unlinkSync(`${DIR}/${f}`) }
  console.log(`pushed ${j.added.length}, rejected ${j.rejected.length} · pool now ${j.pool.available} available, ${j.pool.used} used`)
}
const loop = args.at(-1) === 'loop'
do {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'grind') grind(+args[++i] || 10)
    else if (args[i] === 'push') { await push(args[++i], args[++i]); }
  }
} while (loop)
