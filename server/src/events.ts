// Ring buffer of notable events (fills, launches, vault moves, failures, gate redeems) for GET /admin/events?key=ADMIN_KEY.
// Lets the operator watch a live beta without log access.
export type Ev = { t: number; kind: string; msg: string; data?: any }
const buf: Ev[] = []; let seq = 0
export function log(kind: string, msg: string, data?: any) { buf.push({ t: Date.now(), kind, msg: String(msg).slice(0, 300), data }); if (buf.length > 1000) buf.splice(0, 200); seq++ }
export const since = (t = 0) => buf.filter((e) => e.t > t)
export const stats = () => ({ n: buf.length, seq, kinds: buf.reduce((a, e) => { a[e.kind] = (a[e.kind] || 0) + 1; return a }, {} as Record<string, number>) })
