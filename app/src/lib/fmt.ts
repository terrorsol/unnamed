export const F = (n: number) =>
  n == null || isNaN(n) ? '—' : n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + n.toFixed(n < 1 ? 4 : 0)
export const S = (n: number, d?: number) => (n == null || isNaN(n) ? '—' : (+n).toFixed(d !== undefined ? d : Math.abs(n) < 10 ? 3 : Math.abs(n) < 100 ? 2 : 1))
export const pct = (n: number) => (n == null || isNaN(n) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%')
export const short = (a: string, n = 4) => (a ? a.slice(0, n) + '…' + a.slice(-n) : '')
export const ago = (ms: number) => {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return Math.floor(s) + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  return Math.floor(s / 86400) + 'd'
}
export const LAMPORTS = 1e9
export const SOL_MINT = 'So11111111111111111111111111111111111111112'

/** a dollar price people can read: $0.0016, $0.00000080 — never 8.0e-7 */
export const px = (n: number) => { if (!n || !isFinite(n)) return '—'; if (n >= 1) return '$' + n.toFixed(2); const z = Math.max(0, -Math.floor(Math.log10(n)) - 1); return '$' + n.toFixed(Math.min(12, z + 2)) }

/** dollars with thousands separators: money(1600) → "1,600.00"; d = decimals */
export const money = (n: number, d = 2) => (n == null || !isFinite(n) ? '—' : (+n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }))
