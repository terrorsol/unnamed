// Ring buffer of notable events (fills, launches, vault moves, failures, gate redeems) for GET /admin/events?key=ADMIN_KEY.
// Lets the operator watch a live beta without log access. Appended to DATA_DIR/events.jsonl so a restart doesn't erase the trail.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
export type Ev = { t: number; kind: string; msg: string; data?: any }
const DIR = () => process.env.DATA_DIR || './data'
const FILE = () => DIR() + '/events.jsonl'
const buf: Ev[] = []; let seq = 0
try { if (existsSync(FILE())) { const lines = readFileSync(FILE(), 'utf8').split('\n').filter(Boolean).slice(-600); for (const l of lines) { try { buf.push(JSON.parse(l)) } catch {} } } } catch {}
export function log(kind: string, msg: string, data?: any) {
  const e: Ev = { t: Date.now(), kind, msg: String(msg).slice(0, 300), data }; buf.push(e); if (buf.length > 1000) buf.splice(0, 200); seq++
  try { mkdirSync(DIR(), { recursive: true }); if (existsSync(FILE()) && statSync(FILE()).size > 5e6) return; appendFileSync(FILE(), JSON.stringify(e) + '\n') } catch {}
}
export const since = (t = 0) => buf.filter((e) => e.t > t)
export const stats = () => ({ n: buf.length, seq, kinds: buf.reduce((a, e) => { a[e.kind] = (a[e.kind] || 0) + 1; return a }, {} as Record<string, number>) })
