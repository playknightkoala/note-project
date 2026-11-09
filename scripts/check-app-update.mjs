// 僅對全新、可拋棄的 Notes 實例執行。會另建高一個 patch 版本的前端及本機測試代理。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request as proxyRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
const { chromium } = await import(process.env.NOTES_PLAYWRIGHT_MODULE ?? 'playwright');
const backend = new URL(process.argv[2] ?? 'http://127.0.0.1:18085');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const current = pkg.version, parts = current.split('.').map(Number), next = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
const scratch = mkdtempSync(join(tmpdir(), 'notes-update-build-'));
let browser, server;
try {
  for (const entry of ['src', 'vite.config.ts', 'tsconfig.json', 'tsconfig.client.json', 'index.html']) cpSync(entry, join(scratch, entry), { recursive: true });
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ ...pkg, version: next }));
  symlinkSync(resolve('node_modules'), join(scratch, 'node_modules'), 'dir');
  execFileSync(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build'], { cwd: scratch, stdio: 'pipe' });
  const oldRoot = resolve('dist/client'), newRoot = join(scratch, 'dist/client');
  let published = false, failWorker = false;
  const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
  server = createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/api/version') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ version: published ? next : current, releases: published ? [{ version: next, title: '瀏覽器升級驗收', changes: ['驗證立即更新與離線草稿保留'] }] : [] })); return;
    }
    if (pathname.startsWith('/api/') || pathname === '/healthz') {
      const upstream = proxyRequest({ hostname: backend.hostname, port: backend.port, method: request.method, path: request.url, headers: request.headers }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response); });
      upstream.on('error', () => { response.writeHead(502); response.end(); }); request.pipe(upstream); return;
    }
    if (pathname === '/sw.js' && failWorker) { response.writeHead(503, { 'cache-control': 'no-store' }); response.end(); return; }
    const root = published ? newRoot : oldRoot;
    const candidate = resolve(root, `.${decodeURIComponent(pathname)}`);
    const file = candidate.startsWith(root + sep) && existsSync(candidate) && extname(candidate) ? candidate : join(root, 'index.html');
    response.writeHead(200, { 'content-type': contentTypes[extname(file)] ?? 'application/octet-stream', 'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache', ...(pathname === '/sw.js' ? { 'service-worker-allowed': '/' } : {}) });
    createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ ...(process.env.NOTES_CHROME_PATH ? { executablePath: process.env.NOTES_CHROME_PATH } : {}), headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  assert.ok((await (await context.request.get(origin + '/api/auth/status')).json()).setupRequired, '請使用全新的測試實例');
  const auth = await context.request.post(origin + '/api/auth/register', { headers: { origin }, data: { email: `${randomUUID()}@example.test`, displayName: '強制更新驗收', password: randomUUID() } });
  assert.ok(auth.ok()); const session = await auth.json();
  const create = async title => {
    const response = await context.request.post(origin + '/api/pages', { headers: { origin, 'x-csrf-token': session.csrfToken }, data: { title } });
    assert.ok(response.ok()); return (await response.json()).page;
  };
  const first = await create('更新中的筆記'), second = await create('其他分頁的筆記');
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  await page.goto(origin + `/p/${first.id}`);
  const versionButton = (tab, version) => tab.getByRole('button', { name: `目前版本 ${version}，檢查更新`, exact: true });
  await versionButton(page, current).waitFor();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const oldShells = await page.evaluate(async () => (await globalThis.caches.keys()).filter(name => name.startsWith('notes-shell-')));
  const oldEntry = /src="([^"]+[.]js)"/.exec(readFileSync(join(oldRoot, 'index.html'), 'utf8'))[1];
  const bounds = await versionButton(page, current).boundingBox();
  assert.ok(bounds.x < 260 && bounds.y > 700, '版號應位於桌面側欄左下角');
  await page.evaluate(async userId => { const cache = await globalThis.caches.open(`notes-files-${userId}`); await cache.put('/api/files/update-canary', new Response('synthetic', { headers: { 'content-length': '9' } })); }, session.user.id);
  const other = await context.newPage(); other.on('pageerror', error => errors.push(error.message));
  await other.goto(origin + `/p/${second.id}`); await versionButton(other, current).waitFor();
  await context.route('**/api/offline/pages/**', route => route.abort());
  await other.locator('[contenteditable="true"]').first().fill('另一分頁保留的草稿');
  await page.bringToFront();
  published = true; failWorker = true;
  await page.clock.fastForward(61_000);
  await page.getByRole('dialog', { name: '有新版本可更新' }).waitFor();
  await page.getByText('驗證立即更新與離線草稿保留', { exact: true }).waitFor();
  console.log('PASS 左下角為目前介面版號，定期檢查自動顯示新版 Modal 與更新資訊');
  await page.getByRole('button', { name: '稍後更新' }).click();
  await page.locator('[contenteditable="true"]').first().fill('強制更新前的待同步草稿');
  await versionButton(page, current).click();
  await page.getByRole('button', { name: '立即更新' }).click();
  await page.getByText('下載新版介面失敗，請確認連線後重試。', { exact: true }).waitFor();
  assert.ok(await versionButton(page, current).isVisible());
  failWorker = false;
  await page.getByRole('button', { name: '立即更新' }).click();
  await versionButton(page, next).waitFor();
  assert.match(await page.locator('[contenteditable="true"]').first().innerText(), /強制更新前的待同步草稿/);
  const persisted = await page.evaluate(async ({ userId, id }) => new Promise(resolve => {
    const request = globalThis.indexedDB.open('notes-offline-v1', 1);
    request.onsuccess = () => { const db = request.result, read = db.transaction('records').objectStore('records').get(`page:${userId}:${id}`); read.onsuccess = () => { db.close(); resolve(read.result?.pending); }; };
  }), { userId: session.user.id, id: first.id });
  assert.equal(persisted, true, '未同步的草稿仍須保留在 IndexedDB');
  assert.equal(await page.evaluate(async userId => await (await (await globalThis.caches.open(`notes-files-${userId}`)).match('/api/files/update-canary'))?.text(), session.user.id), 'synthetic');
  console.log('PASS 下載失敗可重試，立即更新切至新版並保留登入、待同步草稿與附件快取');
  assert.ok(await versionButton(other, current).isVisible(), '其他分頁不可自動重新載入');
  assert.match(await other.locator('[contenteditable="true"]').first().innerText(), /另一分頁保留的草稿/);
  assert.ok((await page.evaluate(() => globalThis.caches.keys())).some(name => oldShells.includes(name)));
  assert.equal(await other.evaluate(async entry => (await fetch(entry)).status, oldEntry), 200);
  await other.getByRole('dialog', { name: '有新版本可更新' }).waitFor();
  await other.getByRole('button', { name: '立即更新' }).click();
  await versionButton(other, next).waitFor();
  assert.match(await other.locator('[contenteditable="true"]').first().innerText(), /另一分頁保留的草稿/);
  await page.waitForFunction(async old => !(await globalThis.caches.keys()).some(name => old.includes(name)), oldShells);
  console.log('PASS 其他分頁保留原介面及資源，主動更新後才清理舊版介面快取');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '開啟側邊欄', exact: true }).click();
  await versionButton(page, next).waitFor();
  await page.waitForFunction(() => {
    const bounds = globalThis.document.querySelector('.app-version')?.getBoundingClientRect();
    return bounds && bounds.x >= 0 && bounds.right <= globalThis.innerWidth && bounds.bottom <= globalThis.innerHeight;
  });
  mkdirSync('.local/validation', { recursive: true });
  await page.screenshot({ path: '.local/validation/app-version-mobile.png' });
  assert.deepEqual(errors, []);
  console.log('PASS 手機側欄顯示版號，沒有未捕捉的前端錯誤');
  await context.close();
} finally {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  rmSync(scratch, { recursive: true, force: true });
}
