export function reloadForUpdate(version: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set('__notes_update', `${version}-${Date.now()}`);
  window.location.replace(url.href);
}

function workerVersion(worker: ServiceWorker): Promise<string> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const close = () => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); };
    const timer = setTimeout(() => { close(); reject(new Error('無法確認新版介面，請稍後重試。')); }, 2000);
    channel.port1.onmessage = event => { close(); resolve(event.data?.version ?? ''); };
    worker.postMessage({ type: 'notes:get-version' }, [channel.port2]);
  });
}

/** Activate only a completely installed worker with the requested version; reload only this tab. */
export async function activateAppUpdate(version: string, reload = reloadForUpdate): Promise<void> {
  if (!('serviceWorker' in navigator) || window.isSecureContext === false) { reload(version); return; }
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) { reload(version); return; }
  try { await registration.update(); }
  catch { throw new Error('下載新版介面失敗，請確認連線後重試。'); }
  const deadline = Date.now() + 20_000;
  while (!registration.waiting && registration.installing && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  const waiting = registration.waiting;
  if (!waiting) {
    if (registration.active && await workerVersion(registration.active) === version) { reload(version); return; }
    throw new Error('新版介面尚未下載完成，請確認連線後重試。');
  }
  if (await workerVersion(waiting) !== version) throw new Error('下載的版本與伺服器不同，請稍後再試。');
  await new Promise<void>((resolve, reject) => {
    const changed = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', changed); resolve(); };
    const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener('controllerchange', changed); reject(new Error('新版尚未接手，請重試更新。')); }, 15_000);
    navigator.serviceWorker.addEventListener('controllerchange', changed);
    waiting.postMessage({ type: 'notes:activate-update', version });
  });
  if (!navigator.serviceWorker.controller || await workerVersion(navigator.serviceWorker.controller) !== version) throw new Error('介面版本已再次變更，請重新檢查更新。');
  reload(version);
}
