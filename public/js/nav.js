/** Shared top nav + optional service-worker registration for offline assets */
export function injectNav(active = '') {
  /* pages already include static nav — this only registers SW */
}

export async function enableOfflineCache() {
  if (!('serviceWorker' in navigator)) return false;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return Boolean(reg);
  } catch {
    return false;
  }
}
