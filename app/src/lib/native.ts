// The iOS / Android app shell (Capacitor). Everything here is a no-op on the web, so the same build runs in both.
import { Capacitor } from '@capacitor/core'
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics'
import { StatusBar, Style } from '@capacitor/status-bar'
import { SplashScreen } from '@capacitor/splash-screen'
import { App } from '@capacitor/app'
import { AppLauncher } from '@capacitor/app-launcher'
import { Browser } from '@capacitor/browser'

/** build flag for a cautious first App Store review: VITE_STORE_SAFE=1 hides coin launching in the app (it stays on the web) */
export const STORE_SAFE = (import.meta as any).env?.VITE_STORE_SAFE === '1'
export const isNative = (): boolean => { try { return Capacitor.isNativePlatform() } catch { return false } }
export const platform = (): 'ios' | 'android' | 'web' => { try { return Capacitor.getPlatform() as any } catch { return 'web' } }

/** Real haptics: iOS ignores navigator.vibrate, so in the app we use the Taptic Engine. A number is a tap (bigger = heavier); an array is a result buzz. */
export function nativeHaptic(ms: number | number[]): boolean {
  if (!isNative()) return false
  try {
    if (Array.isArray(ms)) Haptics.notification({ type: ms[0] >= 50 ? NotificationType.Error : NotificationType.Success })
    else Haptics.impact({ style: ms <= 8 ? ImpactStyle.Light : ms <= 16 ? ImpactStyle.Medium : ImpactStyle.Heavy })
    return true
  } catch { return false }
}

/** Open a link outside the app (wallet apps, explorers). Universal links like phantom.app/ul/… open the wallet app directly. */
export async function openExternal(url: string) {
  if (isNative()) {
    try { const r = await AppLauncher.openUrl({ url }); if (r.completed) return } catch {}
    try { await Browser.open({ url }); return } catch {}
  }
  window.location.href = url
}

/** Called once at startup: light status-bar text over our black header, splash hidden when ready, Android back = back. */
export async function nativeBoot() {
  if (!isNative()) return
  document.documentElement.classList.add('native', 'native-' + platform())
  try { await StatusBar.setStyle({ style: Style.Dark }) } catch {}
  try { await StatusBar.setOverlaysWebView({ overlay: true }) } catch {}
  try { App.addListener('backButton', () => { if (history.length > 1) history.back() }) } catch {}
  setTimeout(() => { SplashScreen.hide().catch(() => {}) }, 300)
}

/** Listen for the app being reopened through banker://… (a wallet sending its answer back). */
export function onAppUrl(fn: (url: string) => void): () => void {
  if (!isNative()) return () => {}
  let h: { remove: () => void } | null = null; let dead = false
  App.addListener('appUrlOpen', (e) => fn(e.url)).then((x) => { if (dead) x.remove(); else h = x })
  return () => { dead = true; try { h?.remove() } catch {} }
}
