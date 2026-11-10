// 僅對全新、可拋棄的測試實例執行；會建立隨機合成帳號、資料庫與筆記。
//   node scripts/check-offline-m9.mjs http://127.0.0.1:18090
// 驗收 M9：資料庫（讀取、資料列、欄位）、留言與附件在離線時可用，連線後同步，衝突不靜默覆蓋。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const { chromium } = await import(process.env.NOTES_PLAYWRIGHT_MODULE ?? 'playwright');
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:18090').origin;
const browser = await chromium.launch({ ...(process.env.NOTES_CHROME_PATH ? { executablePath: process.env.NOTES_CHROME_PATH } : {}), headless: true });
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const block = text => [{ id: randomUUID(), type: 'paragraph', props: {}, content: [{ type: 'text', text, styles: {} }], children: [] }];
/** Records kept on this device, by key prefix. */
const local = (page, prefix) => page.evaluate(prefix => new Promise(resolve => {
  const request = globalThis.indexedDB.open('notes-offline-v1', 1);
  request.onsuccess = () => {
    const db = request.result, read = db.transaction('records').objectStore('records').getAll(globalThis.IDBKeyRange.bound(prefix, prefix + '￿'));
    read.onsuccess = () => { db.close(); resolve(read.result); };
  };
}), prefix);
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(30_000);
  const setup = await (await context.request.get(origin + '/api/auth/status')).json();
  assert.ok(setup.setupRequired, '測試必須使用全新實例，避免寫入既有資料');
  const auth = await context.request.post(origin + '/api/auth/register', { headers: { origin }, data: { email: `${randomUUID()}@example.test`, displayName: 'M9 驗收', password: randomUUID() } });
  assert.ok(auth.ok());
  const session = await auth.json();
  const headers = { origin, 'x-csrf-token': session.csrfToken };
  const post = async (path, data, extra = {}) => { const response = await context.request.post(origin + path, { headers: { ...headers, ...extra }, data }); assert.ok(response.ok(), `${path} ${response.status()}`); return response.json(); };
  const get = async path => (await context.request.get(origin + path)).json();
  const sendOp = (op, force = false) => context.request.post(origin + '/api/offline/ops', { headers, data: { operationId: randomUUID(), force, op } });

  const database = (await post('/api/pages', { kind: 'database', title: '離線資料庫' })).page;
  const meta = await post(`/api/databases/${database.id}/properties`, { name: '摘要', type: 'text', choices: [] }, { 'if-match': `"${(await get(`/api/databases/${database.id}`)).version}"` });
  const summary = meta.properties[0].id;
  const existing = await post(`/api/databases/${database.id}/rows`, { title: '既有列', values: { [summary]: '線上的值' } }, { 'if-match': `"${meta.version}"` });
  const note = (await post('/api/pages', { title: '可留言的筆記' })).page;
  assert.equal((await context.request.put(origin + `/api/pages/${note.id}/content`, { headers: { ...headers, 'if-match': `"${note.version}"` }, data: { content: block('可以留言的文字') } })).status(), 200);

  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const synced = () => page.getByText('離線筆記已同步完成', { exact: true }).first().waitFor();
  await page.goto(origin);
  await synced();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const copies = await local(page, 'db:');
  assert.equal(copies.length, 1, '資料庫應已自動下載');
  assert.equal(copies[0].rows[0].values[summary], '線上的值');
  assert.ok((await local(page, 'page:')).some(item => item.local.page.id === existing.id && item.local.page.kind === 'row'), '列頁面應已自動下載');
  console.log('PASS 首次同步自動下載資料庫結構、資料列與列頁面');

  // ---- 離線：資料庫 ----
  await context.setOffline(true);
  await page.goto(origin + `/p/${database.id}`);
  await page.getByText(/目前顯示此裝置上的副本/).first().waitFor();
  const cell = page.getByRole('gridcell', { name: '既有列／摘要' });
  await cell.waitFor();
  assert.match(await cell.innerText(), /線上的值/);
  await cell.click();
  await page.getByLabel('摘要', { exact: true }).fill('離線改的值');
  await page.getByLabel('摘要', { exact: true }).press('Enter');
  await page.waitForFunction(() => [...globalThis.document.querySelectorAll('[role="gridcell"]')].some(item => item.textContent.includes('離線改的值')));
  await page.getByRole('button', { name: '新增', exact: true }).click();
  await page.getByLabel('新資料列名稱').fill('離線新增列');
  await page.getByLabel('新資料列名稱').press('Enter');
  await page.getByRole('gridcell', { name: '離線新增列／名稱' }).waitFor();
  await page.getByRole('button', { name: '＋ 新增屬性' }).click();
  await page.getByLabel('欄位名稱').fill('備註');
  await page.getByRole('button', { name: '儲存欄位' }).click();
  await page.getByRole('button', { name: '欄位選單：備註' }).waitFor();
  await page.getByText(/3 項修改待同步/).waitFor();
  console.log('PASS 離線開啟資料庫、修改儲存格、新增資料列與欄位，並顯示待同步數量');

  await page.getByRole('button', { name: '開啟資料列：離線新增列' }).click();
  await page.waitForURL(/\/p\/[0-9a-f-]{36}$/);
  const newRowId = new URL(page.url()).pathname.split('/').pop();
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.waitFor();
  await editor.click();
  await page.keyboard.type('離線列內文');
  await page.waitForFunction(() => globalThis.document.querySelector('.save-status')?.getAttribute('data-status') === 'local');
  const panelCell = page.getByRole('button', { name: '屬性：摘要' });
  await panelCell.click();
  await page.getByLabel('摘要', { exact: true }).fill('新列的摘要');
  await page.getByLabel('摘要', { exact: true }).press('Enter');
  await page.waitForFunction(() => globalThis.document.querySelector('.row-properties')?.textContent.includes('新列的摘要'));
  console.log('PASS 離線開啟此裝置新增的資料列頁面，編輯列內文與屬性');

  // ---- 離線：留言與附件 ----
  await page.goto(origin + `/p/${note.id}`);
  await editor.waitFor();
  await page.getByText('可以留言的文字').click({ clickCount: 3 });
  await page.getByRole('button', { name: '留言', exact: true }).click();
  await page.getByLabel('留言', { exact: true }).fill('離線寫的留言');
  await page.getByRole('button', { name: '送出留言' }).click();
  await page.locator('.annotation-message', { hasText: '離線寫的留言' }).waitFor();
  await page.getByText(/目前顯示此裝置上的留言/).waitFor();
  await page.getByRole('button', { name: '反應 👍' }).click();
  await page.getByRole('button', { name: '移除反應 👍' }).waitFor();
  await page.getByRole('button', { name: '關閉留言' }).click();
  await page.locator('.annotation-highlight').first().waitFor();
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.evaluate(base64 => {
    const bytes = Uint8Array.from(globalThis.atob(base64), char => char.charCodeAt(0));
    const data = new globalThis.DataTransfer();
    data.items.add(new File([bytes], '離線照片.png', { type: 'image/png' }));
    globalThis.document.querySelector('[contenteditable="true"]').dispatchEvent(new globalThis.ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, PNG);
  const image = page.locator('.bn-editor img[src^="/api/files/"]').first();
  await image.waitFor();
  await page.waitForFunction(() => { const img = globalThis.document.querySelector('.bn-editor img[src^="/api/files/"]'); return img?.complete && img.naturalWidth > 0; });
  const fileUrl = await image.getAttribute('src');
  await page.getByText(/1 個附件待上傳/).waitFor();
  await page.waitForFunction(() => globalThis.document.querySelector('.save-status')?.getAttribute('data-status') === 'local');
  assert.equal((await context.request.get(origin + fileUrl)).status(), 404, '伺服器此時還沒有這個附件');
  console.log('PASS 離線新增留言與表情反應並標記原文；離線貼上圖片，由離線介面以正式網址顯示');

  // ---- 離線重新載入後仍在 ----
  await page.reload();
  await editor.waitFor();
  await page.waitForFunction(() => { const img = globalThis.document.querySelector('.bn-editor img[src^="/api/files/"]'); return img?.complete && img.naturalWidth > 0; });
  await page.locator('.annotation-highlight').first().waitFor();
  await page.goto(origin + `/p/${database.id}`);
  await page.getByRole('gridcell', { name: '離線新增列／摘要' }).waitFor();
  assert.match(await page.getByRole('gridcell', { name: '既有列／摘要' }).innerText(), /離線改的值/);
  assert.match(await page.getByRole('gridcell', { name: '離線新增列／摘要' }).innerText(), /新列的摘要/);
  assert.equal((await get(`/api/databases/${database.id}/rows`)).total, 1, '離線期間伺服器不應有任何變動');
  console.log('PASS 離線重新載入後，資料庫修改、留言標記與附件仍保存在此裝置');

  // ---- 恢復連線：自動同步 ----
  await context.setOffline(false);
  await synced();
  const remote = await get(`/api/databases/${database.id}`);
  assert.deepEqual(remote.properties.map(property => property.name), ['摘要', '備註']);
  const rows = (await get(`/api/databases/${database.id}/rows`)).rows;
  assert.deepEqual(rows.map(row => [row.title, row.values[summary]]), [['既有列', '離線改的值'], ['離線新增列', '新列的摘要']]);
  assert.equal(rows[1].id, newRowId, '伺服器上的資料列沿用此裝置產生的 ID');
  assert.match(JSON.stringify((await get(`/api/pages/${newRowId}`)).page.content), /離線列內文/);
  const discussions = (await get(`/api/pages/${note.id}/annotations`)).annotations;
  assert.equal(discussions.length, 1);
  assert.equal(discussions[0].messages[0].text, '離線寫的留言');
  assert.deepEqual(discussions[0].reactions, ['👍']);
  const savedNote = JSON.stringify((await get(`/api/pages/${note.id}`)).page.content);
  assert.ok(savedNote.includes(discussions[0].id), '筆記內文應帶有討論的標記');
  assert.ok(savedNote.includes(fileUrl), '筆記內文應引用附件的正式網址');
  const uploaded = await context.request.get(origin + fileUrl);
  assert.equal(uploaded.status(), 200);
  assert.equal(uploaded.headers()['content-type'], 'image/png');
  assert.equal((await local(page, 'op:')).length + (await local(page, 'upload:')).length, 0, '佇列應已清空');
  console.log('PASS 恢復連線後自動同步：資料列、欄位、列內文、留言、反應與附件都已在伺服器');

  // ---- 衝突：同一格在兩邊都被修改 ----
  await context.setOffline(true);
  await page.goto(origin + `/p/${database.id}`);
  await page.getByText(/目前顯示此裝置上的副本/).first().waitFor();
  await page.getByRole('gridcell', { name: '既有列／摘要' }).click();
  await page.getByLabel('摘要', { exact: true }).fill('手機的值');
  await page.getByLabel('摘要', { exact: true }).press('Enter');
  await page.getByText(/1 項修改待同步/).waitFor();
  // 另一台裝置改了同一格，以及另一列的另一格（後者不該造成衝突）。
  assert.equal((await sendOp({ type: 'row.update', databaseId: database.id, rowId: existing.id, values: { [summary]: { base: '離線改的值', value: '電腦的值' } } })).status(), 200);
  await context.setOffline(false);
  await page.getByText('部分修改需要處理').waitFor();
  assert.equal((await get(`/api/rows/${existing.id}`)).values[summary], '電腦的值', '衝突時不得覆蓋另一台裝置的值');
  await page.getByRole('button', { name: '離線與同步' }).click();
  await page.getByText('「摘要」已在其他地方更新。').waitFor();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '以我的修改覆蓋' }).click();
  await page.waitForFunction(async id => (await (await fetch(`/api/rows/${id}`)).json()).values && Object.values((await (await fetch(`/api/rows/${id}`)).json()).values).includes('手機的值'), existing.id);
  await page.keyboard.press('Escape');
  await synced();
  console.log('PASS 同一格兩邊修改時保留線上值並列為衝突；使用者明確選擇後才以本機修改覆蓋');

  // ---- 同步完成後再次離線修改，恢復連線自動送出 ----
  await context.setOffline(true);
  await page.getByRole('gridcell', { name: '既有列／摘要' }).click();
  await page.getByLabel('摘要', { exact: true }).fill('登出前的修改');
  await page.getByLabel('摘要', { exact: true }).press('Enter');
  await page.getByText(/1 項修改待同步/).waitFor();
  assert.equal((await local(page, 'op:')).length, 1);
  await context.setOffline(false);
  await synced();
  assert.equal((await get(`/api/rows/${existing.id}`)).values[summary], '登出前的修改');
  assert.deepEqual(errors, []);
  console.log('PASS 再次離線修改後恢復連線自動送出；全程沒有未捕捉的前端錯誤');
  await context.close();
} finally { await browser.close(); }
