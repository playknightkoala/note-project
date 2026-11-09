import { APP_VERSION } from '../updates/version.ts';

export const UPDATE_CHECK_EVENT = 'notes:check-update';
export function reportAppVersion(): void {
  if ('serviceWorker' in navigator) navigator.serviceWorker.controller?.postMessage({ type: 'notes:client-version', version: APP_VERSION });
}

export function registerOfflineShell(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'notes:report-version') reportAppVersion();
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    reportAppVersion();
    // Other tabs receive a reminder; they keep their current editor until their own update is requested.
    window.dispatchEvent(new Event(UPDATE_CHECK_EVENT));
  });
  const register = () => {
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then(() => navigator.serviceWorker.ready)
      .then(() => { reportAppVersion(); window.dispatchEvent(new Event('notes:offline-ready')); })
      .catch(() => window.dispatchEvent(new Event('notes:offline-unavailable')));
  };
  if (document.readyState === 'complete') register(); else window.addEventListener('load', register, { once: true });
}
