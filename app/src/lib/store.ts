// Tiny persisted settings + event bus. No framework state lib needed.
export type Settings = { rpc: string; slippageBps: number; priorityFeeSol: number; quickBuy: number; watch: string[] }
const KEY = 'unnamed_settings_v1'
const DEF: Settings = { rpc: 'https://api.mainnet-beta.solana.com', slippageBps: 1000, priorityFeeSol: 0.0005, quickBuy: 0.1, watch: [] }
export function loadSettings(): Settings { try { return { ...DEF, ...(JSON.parse(localStorage.getItem(KEY) || '{}')) } } catch { return { ...DEF } } }
export function saveSettings(s: Settings) { try { localStorage.setItem(KEY, JSON.stringify(s)) } catch {} }

type Listener = (t: Toast) => void
export type Toast = { kind: 'ok' | 'err' | 'info' | 'tx'; title: string; rows?: [string, string][]; href?: string; id?: number }
const listeners = new Set<Listener>()
export function onToast(fn: Listener) { listeners.add(fn); return () => { listeners.delete(fn) } }
export function toast(t: Toast) { listeners.forEach((fn) => fn({ ...t, id: Math.random() })) }
