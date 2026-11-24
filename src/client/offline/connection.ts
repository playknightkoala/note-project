export const CONNECTION_EVENT = 'notes:connection';
const PROBE_INTERVAL_MS = 5_000;
const PROBE_TIMEOUT_MS = 2_000;
const REQUIRED_SUCCESSES = 3;

let unstable = false;
let failures = 0;
let watching = false;
export const connectionState = () => navigator.onLine === false ? 'offline' : unstable ? 'unstable' : 'online';
export const canReachServer = () => connectionState() === 'online';

function announce() { window.dispatchEvent(new Event(CONNECTION_EVENT)); }

/** A cancelled query or an application error does not indicate a bad connection. */
export function recordConnectionResult(reached: boolean): void {
  if (!watching || unstable || navigator.onLine === false) return;
  failures = reached ? 0 : failures + 1;
  if (failures < 2) return;
  unstable = true;
  announce();
}

/** Watch only while the private interface is mounted. Health checks carry no credentials. */
export function watchConnection(verifySession: () => Promise<boolean>): () => void {
  watching = true;
  let successes = 0;
  let active = true;
  let probing = false;
  let interrupted = false;
  let probeController: AbortController | undefined;
  const probe = async () => {
    if (!active || probing || connectionState() !== 'unstable' || document.visibilityState !== 'visible') return;
    probing = true;
    interrupted = false;
    const controller = new AbortController();
    probeController = controller;
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const result = await fetch('/healthz', { signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' });
      const healthy = result.ok && (await result.text()).trim() === 'ok';
      clearTimeout(timer);
      if (!active || interrupted || controller.signal.aborted || !healthy) { successes = 0; return; }
      if (++successes < REQUIRED_SUCCESSES) return;
      successes = 0;
      if (!await verifySession() || !active || interrupted || navigator.onLine === false) return;
      unstable = false;
      failures = 0;
      announce();
    } catch {
      successes = 0;
    } finally {
      clearTimeout(timer);
      probing = false;
      probeController = undefined;
    }
  };
  const connectivityChanged = () => {
    if (navigator.onLine === false) {
      unstable = true;
      interrupted = true;
      successes = 0;
      probeController?.abort();
    }
    announce();
  };
  const check = () => { void probe(); };
  if (navigator.onLine === false) unstable = true;
  const timer = setInterval(check, PROBE_INTERVAL_MS);
  window.addEventListener('online', connectivityChanged);
  window.addEventListener('offline', connectivityChanged);
  window.addEventListener(CONNECTION_EVENT, check);
  document.addEventListener('visibilitychange', check);
  check();
  return () => {
    active = false;
    watching = false;
    unstable = false;
    failures = 0;
    probeController?.abort();
    clearInterval(timer);
    window.removeEventListener('online', connectivityChanged);
    window.removeEventListener('offline', connectivityChanged);
    window.removeEventListener(CONNECTION_EVENT, check);
    document.removeEventListener('visibilitychange', check);
  };
}
