export function registerOfflineShell(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then(() => navigator.serviceWorker.ready)
      .then(() => window.dispatchEvent(new Event('notes:offline-ready')))
      .catch(() => window.dispatchEvent(new Event('notes:offline-unavailable')));
  });
}
