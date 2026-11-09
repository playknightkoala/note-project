// 僅對全新、可拋棄的測試實例執行；會建立隨機合成帳號與筆記。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const { chromium } = await import(process.env.NOTES_PLAYWRIGHT_MODULE ?? 'playwright');
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:18083').origin;
const browser = await chromium.launch({ ...(process.env.NOTES_CHROME_PATH ? { executablePath: process.env.NOTES_CHROME_PATH } : {}), headless: true });
const block = text => [{ id: randomUUID(), type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] }];
async function localContains(page, id, text) {
  await page.waitForFunction(({ id, text }) => new Promise(resolve => {
    const request = globalThis.indexedDB.open('notes-offline-v1', 1);
    request.onsuccess = () => {
      const db = request.result, read = db.transaction('records').objectStore('records').getAll();
      read.onsuccess = () => { db.close(); resolve(read.result.some(item => item?.local?.page.id === id && JSON.stringify(item.local.page.content).includes(text))); };
    };
  }), { id, text });
}
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const setup = await (await context.request.get(origin + '/api/auth/status')).json();
  assert.ok(setup.setupRequired, '測試必須使用全新實例，避免寫入既有資料');
  const auth = await context.request.post(origin + '/api/auth/register', { headers: { origin }, data: { email: `${randomUUID()}@example.test`, displayName: '同步驗收', password: randomUUID() } });
  assert.ok(auth.ok());
  const session = await auth.json();
  const headers = { origin, 'x-csrf-token': session.csrfToken };
  const create = async title => {
    const response = await context.request.post(origin + '/api/pages', { headers, data: { title } });
    assert.ok(response.ok()); return (await response.json()).page;
  };
  const write = async (id, text) => {
    const remote = (await (await context.request.get(origin + `/api/pages/${id}`)).json()).page;
    const response = await context.request.put(origin + `/api/pages/${id}/content`, { headers: { ...headers, 'if-match': `"${remote.version}"` }, data: { content: block(text) } });
    assert.equal(response.status(), 200);
  };
  const first = await create('初始筆記'); await write(first.id, '初始線上內容');
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByText('離線筆記已同步完成', { exact: true }).waitFor();
  await localContains(page, first.id, '初始線上內容');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const second = await create('另一裝置新增'); await write(second.id, '未曾開啟的遠端筆記');
  await write(first.id, '遠端更新後的內文');
  await page.evaluate(() => globalThis.document.dispatchEvent(new Event('visibilitychange')));
  await localContains(page, second.id, '未曾開啟的遠端筆記');
  await localContains(page, first.id, '遠端更新後的內文');
  await page.getByText('離線筆記已同步完成', { exact: true }).waitFor();
  console.log('PASS 首次自動下載、切回前景取得遠端新增與修改、同步完成提示');

  await context.setOffline(true);
  await page.goto(origin + `/p/${second.id}`);
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.waitFor();
  assert.match(await editor.innerText(), /未曾開啟的遠端筆記/);
  await editor.fill('本機衝突草稿'); await localContains(page, second.id, '本機衝突草稿');
  await page.reload(); await editor.waitFor();
  assert.match(await editor.innerText(), /本機衝突草稿/);
  await write(second.id, '另一裝置的衝突內容');
  await context.setOffline(false);
  const overwrite = page.getByRole('button', { name: '以我的內容覆蓋', exact: true });
  await overwrite.waitFor();
  assert.match(await editor.innerText(), /本機衝突草稿/);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '匯出此處草稿' }).click();
  assert.match((await download).suggestedFilename(), /筆記草稿/);
  page.once('dialog', dialog => dialog.accept()); await overwrite.click();
  await page.waitForFunction(() => globalThis.document.querySelector('.save-status')?.getAttribute('data-status') === 'clean');
  const final = (await (await context.request.get(origin + `/api/pages/${second.id}`)).json()).page;
  assert.match(JSON.stringify(final.content), /本機衝突草稿/);
  const versions = (await (await context.request.get(origin + `/api/pages/${second.id}/versions`)).json()).versions;
  let found = false;
  for (const version of versions) {
    const snapshot = await (await context.request.get(origin + `/api/pages/${second.id}/versions/${version.id}`)).json();
    if (JSON.stringify(snapshot.content).includes('另一裝置的衝突內容')) found = true;
  }
  assert.ok(found, '被覆蓋的線上版本必須留在歷史');
  console.log('PASS 未造訪筆記離線開啟、草稿重載、衝突保留／匯出、明確覆蓋與歷史');

  await context.setOffline(true);
  await editor.fill('準備捨棄的草稿'); await localContains(page, second.id, '準備捨棄的草稿');
  await write(second.id, '載入最新版本驗收');
  await context.setOffline(false);
  const reload = page.getByRole('button', { name: '載入最新版本', exact: true }); await reload.waitFor();
  page.once('dialog', dialog => dialog.accept()); await reload.click();
  await page.waitForFunction(() => globalThis.document.querySelector('[contenteditable="true"]')?.textContent.includes('載入最新版本驗收'));
  const pdf = Buffer.alloc(21 * 1024 * 1024, 32); pdf.write('%PDF-1.4\n');
  const uploaded = await context.request.post(origin + '/api/files', { headers, multipart: { file: { name: 'synthetic-large.pdf', mimeType: 'application/pdf', buffer: pdf } } });
  assert.equal(uploaded.status(), 201, '超過舊 20 MB 上限的附件應可上傳');
  const attachment = await uploaded.json();
  assert.equal(await page.evaluate(async url => (await fetch(url)).status, attachment.url), 200);
  await page.getByRole('button', { name: '離線與同步' }).click();
  await page.getByLabel('此裝置的附件離線快取上限（MB）').fill('700');
  await page.getByRole('button', { name: '儲存快取容量' }).click();
  await page.getByText(/附件快取已用 21\.0 MB／700 MB/).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS 明確載入線上版本、21 MB 附件上傳與離線快取、手機容量設定、沒有未捕捉的前端錯誤');
  await context.close();
} finally { await browser.close(); }
