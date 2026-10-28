// Metadata upload for launches. pump.fun/api/ipfs is dead; PumpPortal's examples now use Pinata. The browser never sees the JWT.
// Env: PINATA_JWT. Without it, /ipfs returns 503 and the launch button says what to set.
const UP = 'https://uploads.pinata.cloud/v3/files'
const GATEWAY = process.env.IPFS_GATEWAY || 'https://ipfs.io/ipfs/'
async function pin(blob: Blob, name: string): Promise<string> {
  const fd = new FormData(); fd.append('network', 'public'); fd.append('file', blob, name)
  const r = await fetch(UP, { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.PINATA_JWT }, body: fd })
  if (!r.ok) throw new Error('pinata ' + r.status + ' ' + (await r.text().catch(() => '')))
  const d: any = await r.json(); const cid = d?.data?.cid; if (!cid) throw new Error('pinata: no cid'); return cid
}
export async function uploadMetadata(b: { name: string; symbol: string; description?: string; twitter?: string; telegram?: string; website?: string; image?: string }) {
  if (!process.env.PINATA_JWT) throw Object.assign(new Error('metadata upload not configured — set PINATA_JWT on the server'), { status: 503 })
  if (!b.name || !b.symbol) throw new Error('name and symbol required')
  let image: string | undefined
  if (b.image) { // data URL from the browser, ≤ ~1.5MB after the body cap
    const m = /^data:([\w/+.-]+);base64,(.+)$/.exec(b.image); if (!m) throw new Error('bad image')
    const bytes = Buffer.from(m[2], 'base64'); const ext = (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg')
    image = GATEWAY + (await pin(new Blob([bytes], { type: m[1] }), `${b.symbol}.${ext}`))
  }
  const meta: any = { name: b.name, symbol: b.symbol, description: b.description || '', showName: true, createdOn: 'https://unnamed.app' }
  if (image) meta.image = image; if (b.twitter) meta.twitter = b.twitter; if (b.telegram) meta.telegram = b.telegram; if (b.website) meta.website = b.website
  const cid = await pin(new Blob([JSON.stringify(meta)], { type: 'application/json' }), 'metadata.json')
  return { uri: GATEWAY + cid, image }
}
