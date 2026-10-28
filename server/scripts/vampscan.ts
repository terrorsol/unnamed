// Run the vamp detector against the live board and print every verdict with its evidence — the review sheet for tuning false positives.
import { refresh, list } from '../src/vamp.ts'
import { writeFileSync, mkdirSync } from 'node:fs'
const r = await refresh(); const { vamps, families } = list()
const lines = [`# Vamp scan · ${new Date().toISOString()} · ${r.coins} coins on the board · ${families.length} name families · ${vamps.length} vamps flagged`, '']
lines.push('## Flagged', '', '| vamp | original | score | age | mcap | evidence |', '|---|---|---|---|---|---|')
for (const v of vamps) lines.push(`| ${v.symbol} \`${v.mint.slice(0, 6)}…\` | ${v.originalSymbol} \`${v.original.slice(0, 6)}…\` | ${v.score} | ${v.ageMin < 120 ? v.ageMin + ' min' : (v.ageMin / 60).toFixed(1) + ' h'} | $${Math.round(v.mcapUsd / 1000)}K | ${v.reasons.join(' · ')} |`)
lines.push('', '## Families (clusters with 2+ coins; leader = where the flow is)', '')
for (const f of families) { lines.push(`- **${f.key}** → ` + f.members.map((m) => `${m.leader ? '👑 ' : ''}${m.symbol} ($${Math.round(m.mcapUsd / 1000)}K, score ${m.score}${m.vampOf ? ', vamp' : ''})`).join(' · ')) }
lines.push('', 'A flag needs: younger AND smaller than the original, a copied ticker/name, and (unless both are exact copies) one more signal — launched inside 48h, same deployer, or same image. Review: every row above should read as an obvious copy to a human; anything that does not is a false positive to fix in `server/src/vamp.ts`.')
mkdirSync('reports', { recursive: true }); writeFileSync('reports/vamps.md', lines.join('\n') + '\n'); writeFileSync('reports/vamps.json', JSON.stringify({ at: Date.now(), vamps, families }, null, 1))
console.log(lines.slice(0, 40).join('\n')); process.exit(0)
