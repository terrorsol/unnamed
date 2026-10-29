// Juice for simple mode: coin bursts, coin rain, shine. Pure DOM + CSS, no libraries; everything removes itself.
const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } }

/** gold coins pop out of a point (a tap, a button) and fall with a little spin */
export function coinBurst(x: number, y: number, n = 14) {
  if (reduced()) return
  const box = document.createElement('div'); box.className = 'fx-layer'; document.body.appendChild(box)
  for (let i = 0; i < n; i++) {
    const c = document.createElement('i'); c.className = 'fx-coin'
    const a = (-Math.PI / 2) + (Math.random() - 0.5) * Math.PI * 1.1, v = 90 + Math.random() * 120
    c.style.left = x + 'px'; c.style.top = y + 'px'
    c.style.setProperty('--dx', Math.cos(a) * v + 'px'); c.style.setProperty('--dy', Math.sin(a) * v + 'px'); c.style.setProperty('--fall', 140 + Math.random() * 160 + 'px')
    c.style.setProperty('--r', (Math.random() * 720 - 360) + 'deg'); c.style.animationDelay = Math.random() * 60 + 'ms'; c.style.setProperty('--s', 0.7 + Math.random() * 0.6 + '')
    box.appendChild(c)
  }
  setTimeout(() => box.remove(), 1400)
}
/** burst from the middle of an element */
export function burstFrom(el: Element | null, n?: number) { if (!el) return; const r = el.getBoundingClientRect(); coinBurst(r.left + r.width / 2, r.top + r.height / 2, n) }
/** coins rain down the whole screen: the "it landed" moment */
export function coinRain(n = 36) {
  if (reduced()) return
  const box = document.createElement('div'); box.className = 'fx-layer'; document.body.appendChild(box)
  const W = innerWidth
  for (let i = 0; i < n; i++) {
    const c = document.createElement('i'); c.className = 'fx-rain'
    c.style.left = Math.random() * W + 'px'; c.style.animationDuration = 1.1 + Math.random() * 0.9 + 's'; c.style.animationDelay = Math.random() * 500 + 'ms'
    c.style.setProperty('--r', (Math.random() * 900 - 450) + 'deg'); c.style.setProperty('--s', 0.6 + Math.random() * 0.7 + ''); c.style.setProperty('--x', (Math.random() - 0.5) * 80 + 'px')
    box.appendChild(c)
  }
  setTimeout(() => box.remove(), 2800)
}
