/** Only note data and a cached user profile live here. Never persist passwords, cookies or CSRF tokens. */
export const OFFLINE_DB = 'notes-offline-v1';
export const OFFLINE_EVENT = 'notes:offline-change';
let database: Promise<IDBDatabase> | undefined;
let channel: BroadcastChannel | undefined;

export function announceOfflineChange(): void {
  window.dispatchEvent(new Event(OFFLINE_EVENT));
  channel?.postMessage('changed');
}

function open(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(new Error('此瀏覽器無法使用本機儲存；請使用一般瀏覽模式。')); return; }
      const request = indexedDB.open(OFFLINE_DB, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('records'); };
      request.onerror = () => reject(new Error('無法開啟本機儲存，請檢查裝置空間與瀏覽器設定。'));
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); database = undefined; };
        resolve(request.result);
      };
    }).catch(error => { database = undefined; throw error; });
    if (typeof BroadcastChannel !== 'undefined' && !channel) {
      channel = new BroadcastChannel(OFFLINE_DB);
      channel.onmessage = () => window.dispatchEvent(new Event(OFFLINE_EVENT));
    }
  }
  return database!;
}

export async function readLocal<T>(key: string): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction('records').objectStore('records').get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

/** Read/modify/write in one transaction, including cross-tab compare-and-swap. */
export async function updateLocal<T>(key: string, update: (value: T | undefined) => T | undefined): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite');
    const store = tx.objectStore('records');
    let result: T | undefined;
    let failure: unknown;
    const request = store.get(key);
    request.onsuccess = () => {
      try {
        result = update(request.result as T | undefined);
        if (result === undefined) store.delete(key); else store.put(result, key);
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => { announceOfflineChange(); resolve(result); };
    tx.onabort = tx.onerror = () => reject(failure ?? new Error('無法保存至此裝置，可能儲存空間不足。請勿關閉尚未同步的筆記。'));
  });
}

export async function listLocal<T>(prefix: string): Promise<T[]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction('records').objectStore('records').getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

/** Deletes every record the predicate selects, in one transaction. */
export async function removeLocal(select: (key: string, value: unknown) => boolean): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite');
    const request = tx.objectStore('records').openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (select(String(cursor.key), cursor.value)) cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
  announceOfflineChange();
}

export async function clearLocal(): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite');
    tx.objectStore('records').clear();
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
  announceOfflineChange();
}
