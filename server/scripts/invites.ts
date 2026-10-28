// npm run invites -- 10 "wave 1"   → prints ten fresh keys (shown once; only hashes are stored in DATA_DIR/invites.json)
import { mint, stats, hashOf } from '../src/invite.ts'
const n = Math.max(1, Math.min(200, +(process.argv[2] || 10))); const label = process.argv[3] || ''
const codes = mint(n, label); for (const c of codes) console.log(c)
console.error('INVITE_HASHES=' + codes.map((c) => hashOf(c)).join(','))
console.error(JSON.stringify(stats()))
