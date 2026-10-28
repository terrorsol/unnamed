// Metadata upload for launches. pump.fun/api/ipfs is dead; PumpPortal's examples now use Pinata. The browser never sees the JWT.
// Env: PINATA_JWT. Without it the server hosts the files itself under DATA_DIR/meta and serves them at PUBLIC_SERVER_URL/meta/<sha>.<ext>
// (a token URI is just an https URL; pinning can be backfilled later).
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
const UP = 'https://uploads.pinata.cloud/v3/files'
const GATEWAY = process.env.IPFS_GATEWAY || 'https://ipfs.io/ipfs/'
const META_DIR = () => (process.env.DATA_DIR || './data') + '/meta'
export const SELF_HOSTED = !process.env.PINATA_JWT
let publicBase = process.env.PUBLIC_SERVER_URL || ''
/** the base URL self-hosted files are served from: PUBLIC_SERVER_URL, else learned from the first request's Host header */
export function learnBase(req: { headers: Record<string, any> }) { if (publicBase) return; const h = req.headers['x-forwarded-host'] || req.headers.host; if (h && !/localhost|127\.0\.0\.1/.test(String(h))) publicBase = (req.headers['x-forwarded-proto'] || 'https') + '://' + h }
const MIME: Record<string, string> = { json: 'application/json', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }
/** GET /meta/<file> */
export function serveMeta(file: string): { body: Buffer; type: string } | null { if (!/^[0-9a-f]{40}\.(json|png|jpg|gif|webp|svg)$/.test(file)) return null; const f = META_DIR() + '/' + file; if (!existsSync(f)) return null; return { body: readFileSync(f), type: MIME[file.split('.')[1]] } }
async function pin(blob: Blob, name: string): Promise<string> {
  if (SELF_HOSTED) {
    if (!publicBase) throw Object.assign(new Error('metadata host unknown — set PUBLIC_SERVER_URL on the server'), { status: 503 })
    const bytes = Buffer.from(await blob.arrayBuffer()); const ext = (name.split('.').pop() || 'json').toLowerCase().replace('jpeg', 'jpg'); if (!MIME[ext]) throw new Error('unsupported file type ' + ext)
    const file = createHash('sha1').update(bytes).digest('hex') + '.' + ext; mkdirSync(META_DIR(), { recursive: true }); writeFileSync(META_DIR() + '/' + file, bytes)
    return publicBase + '/meta/' + file
  }
  const fd = new FormData(); fd.append('network', 'public'); fd.append('file', blob, name)
  const r = await fetch(UP, { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.PINATA_JWT }, body: fd })
  if (!r.ok) throw new Error('pinata ' + r.status + ' ' + (await r.text().catch(() => '')))
  const d: any = await r.json(); const cid = d?.data?.cid; if (!cid) throw new Error('pinata: no cid'); return cid
}
export async function uploadMetadata(b: { name: string; symbol: string; description?: string; twitter?: string; telegram?: string; website?: string; image?: string }) {
  if (!b.name || !b.symbol) throw new Error('name and symbol required')
  let image: string | undefined
  if (b.image) { // data URL from the browser, ≤ ~1.5MB after the body cap
    const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(b.image); if (!m) throw new Error('bad image')
    const bytes = Buffer.from(m[2], 'base64'); const ext = (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg')
    image = (SELF_HOSTED ? '' : GATEWAY) + (await pin(new Blob([bytes], { type: m[1] }), `${b.symbol}.${ext}`))
  }
  const meta: any = { name: b.name, symbol: b.symbol, description: b.description || '', showName: true, createdOn: 'https://banker.cash' }
  if (image) meta.image = image; if (b.twitter) meta.twitter = b.twitter; if (b.telegram) meta.telegram = b.telegram; if (b.website) meta.website = b.website
  const cid = await pin(new Blob([JSON.stringify(meta)], { type: 'application/json' }), 'metadata.json')
  return { uri: (SELF_HOSTED ? '' : GATEWAY) + cid, image, selfHosted: SELF_HOSTED }
}
