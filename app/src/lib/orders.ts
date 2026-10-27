// Client-side TP / SL orders. Checked against live price while a tab is open; executes a real sell through the normal route.
export type Order = { id: string; mint: string; symbol: string; type: 'tp' | 'sl'; trigUsd: number; frac: number; t: number; owner: string }
const K = (o: string) => 'unnamed_orders_' + o
export function loadOrders(owner: string): Order[] { try { return JSON.parse(localStorage.getItem(K(owner)) || '[]') } catch { return [] } }
export function saveOrders(owner: string, o: Order[]) { try { localStorage.setItem(K(owner), JSON.stringify(o)) } catch {} }
export function addOrder(owner: string, o: Omit<Order, 'id' | 't' | 'owner'>) { const l = loadOrders(owner); l.push({ ...o, id: Math.random().toString(36).slice(2, 9), t: Date.now(), owner }); saveOrders(owner, l) }
export function removeOrder(owner: string, id: string) { saveOrders(owner, loadOrders(owner).filter((o) => o.id !== id)) }
/** returns orders that should fire at this price */
export function due(owner: string, mint: string, priceUsd: number): Order[] { return loadOrders(owner).filter((o) => o.mint === mint && priceUsd > 0 && ((o.type === 'tp' && priceUsd >= o.trigUsd) || (o.type === 'sl' && priceUsd <= o.trigUsd))) }
