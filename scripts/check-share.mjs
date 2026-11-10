// 僅對全新、可拋棄的測試實例執行；會建立隨機合成帳號、筆記與資料庫。
//   node scripts/check-share.mjs http://127.0.0.1:18090
// 驗收 M10：擁有者設定分享；可編輯與唯讀成員依角色使用（含留言、資料庫與離線）；公開連結唯讀且可停用。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const { chromium } = await import(process.env.NOTES_PLAYWRIGHT_MODULE ?? 'playwright');
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:18090').origin;
const browser = await chromium.launch({ ...(process.env.NOTES_CHROME_PATH ? { executablePath: process.env.NOTES_CHROME_PATH } : {}), headless: true });
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const text = (id, value) => ({ id, type: 'paragraph', props: {}, content: [{ type: 'text', text: value, styles: {} }], children: [] });
const errors = [];
/** Records kept on this device, by key prefix. */
const local = (page, prefix) => page.evaluate(prefix => new Promise(resolve => {
  const request = globalThis.indexedDB.open('notes-offline-v1', 1);
  request.onsuccess = () => {
    const db = request.result, read = db.transaction('records').objectStore('records').getAll(globalThis.IDBKeyRange.bound(prefix, prefix + '￿'));
    read.onsuccess = () => { db.close(); resolve(read.result); };
  };
}), prefix);

/** A signed-in browser of its own: cookies, storage and offline copy are separate from everybody else's. */
async function account(name, inviteCode) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(30_000);
  const email = `${randomUUID()}@example.test`;
  const auth = await context.request.post(origin + '/api/auth/register', { headers: { origin }, data: { email, displayName: name, password: randomUUID(), ...(inviteCode ? { inviteCode } : {}) } });
  assert.ok(auth.ok(), `註冊 ${name}：${auth.status()}`);
  const session = await auth.json();
  const headers = { origin, 'x-csrf-token': session.csrfToken };
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
  return {
    name, email, id: session.user.id, context, page, headers,
    get: async path => (await context.request.get(origin + path)).json(),
    status: async path => (await context.request.get(origin + path)).status(),
    post: async (path, data, extra = {}) => { const response = await context.request.post(origin + path, { headers: { ...headers, ...extra }, data }); assert.ok(response.ok(), `${path} ${response.status()}`); return response.json(); },
    synced: () => page.getByText('離線筆記已同步完成', { exact: true }).first().waitFor(),
  };
}

try {
  const probe = await browser.newContext();
  assert.ok((await (await probe.request.get(origin + '/api/auth/status')).json()).setupRequired, '測試必須使用全新實例，避免寫入既有資料');
  await probe.close();
  const owner = await account('擁有者');
  const invite = async () => (await owner.post('/api/admin/invites', { expiresInHours: 1 })).code;
  const editor = await account('編輯者', await invite());
  const viewer = await account('唯讀者', await invite());

  // ---- 擁有者的內容：筆記（含圖片、範圍內外的頁面連結）、子頁、資料庫與不分享的頁面 ----
  const note = (await owner.post('/api/pages', { title: '分享的筆記' })).page;
  const child = (await owner.post('/api/pages', { title: '範圍內子頁', parentId: note.id })).page;
  const secret = (await owner.post('/api/pages', { title: '不分享的私人頁面' })).page;
  const database = (await owner.post('/api/pages', { title: '分享的資料庫', kind: 'database', parentId: note.id })).page;
  const meta = await owner.post(`/api/databases/${database.id}/properties`, { name: '摘要', type: 'text', choices: [] }, { 'if-match': `"${(await owner.get(`/api/databases/${database.id}`)).version}"` });
  const summary = meta.properties[0].id;
  await owner.post(`/api/databases/${database.id}/rows`, { title: '既有列', values: { [summary]: '擁有者的值' } }, { 'if-match': `"${meta.version}"` });
  const upload = await owner.context.request.post(origin + '/api/files', { headers: owner.headers, multipart: { file: { name: '分享的圖片.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') } } });
  assert.ok(upload.ok());
  const picture = await upload.json();
  const content = [
    text('p1', '可以留言的文字'),
    { id: 'p2', type: 'paragraph', props: {}, children: [], content: [{ type: 'text', text: '連結：', styles: {} }, { type: 'pageLink', props: { pageId: child.id, title: '範圍內子頁' } }, { type: 'pageLink', props: { pageId: secret.id, title: '不分享的私人頁面' } }] },
    { id: 'img', type: 'image', props: { url: picture.url, name: picture.name }, children: [] },
  ];
  assert.equal((await owner.context.request.put(origin + `/api/pages/${note.id}/content`, { headers: { ...owner.headers, 'if-match': `"${note.version}"` }, data: { content } })).status(), 200);

  // ---- 擁有者在畫面上設定分享 ----
  await owner.page.goto(origin + `/p/${note.id}`);
  await owner.page.getByRole('button', { name: '分享', exact: true }).click();
  const dialog = owner.page.getByRole('dialog');
  await dialog.getByLabel('此頁面、子頁面與資料庫').check();
  await dialog.getByRole('switch', { name: /公開連結/ }).check();
  const linkOf = async () => new URL((await dialog.getByLabel('公開連結網址').innerText()).trim());
  const firstLink = await linkOf();
  assert.match(firstLink.pathname, /^\/s\/[A-Za-z0-9_-]{43}$/);
  for (const [who, role] of [[editor, '可編輯'], [viewer, '唯讀']]) {
    await dialog.getByLabel('Email').fill(who.email);
    await dialog.getByLabel('新成員的權限').click();
    await dialog.getByRole('option', { name: role, exact: true }).click();
    await dialog.getByRole('button', { name: '加入' }).click();
    await dialog.getByText(who.email).waitFor();
  }
  await dialog.getByLabel('Email').fill(`${randomUUID()}@example.test`);
  await dialog.getByRole('button', { name: '加入' }).click();
  await dialog.getByText(/找不到這個帳號/).waitFor();
  await dialog.getByRole('button', { name: '完成' }).click();
  await owner.page.getByRole('button', { name: '已分享' }).waitFor();
  const state = await owner.get(`/api/pages/${note.id}/share`);
  assert.equal(state.share.scope, 'all');
  assert.deepEqual(state.share.members.map(member => [member.email, member.role]).sort(), [[editor.email, 'editor'], [viewer.email, 'viewer']].sort());
  console.log('PASS 擁有者以分享視窗設定範圍、開啟公開連結並加入可編輯與唯讀成員；不存在的帳號被拒絕');

  // ---- 可編輯成員：側欄、內文、資料庫 ----
  await editor.page.goto(origin);
  await editor.synced();
  await editor.page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await editor.page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await editor.page.getByText('與我共用', { exact: true }).waitFor();
  await editor.page.getByRole('treeitem', { name: /分享的筆記/ }).click();
  await editor.page.getByText(/擁有者 與你共用這個頁面 · 可編輯/).waitFor();
  assert.equal(await editor.page.getByRole('button', { name: '分享', exact: true }).count(), 0, '成員沒有分享按鈕');
  assert.equal(await editor.page.getByText('新增圖示').count(), 0, '成員不能改圖示與封面');
  const editorImage = editor.page.locator('.bn-editor img[src^="/api/files/"]').first();
  await editorImage.waitFor();
  await editor.page.waitForFunction(() => { const img = globalThis.document.querySelector('.bn-editor img[src^="/api/files/"]'); return img?.complete && img.naturalWidth > 0; });
  await editor.page.getByText('可以留言的文字').click();
  await editor.page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
  await editor.page.keyboard.type('，編輯者補充');
  await editor.page.waitForFunction(() => ['clean', 'local'].includes(globalThis.document.querySelector('.save-status')?.getAttribute('data-status')));
  await editor.synced();
  await owner.page.waitForFunction(() => globalThis.document.querySelector('.bn-editor')?.textContent.includes('編輯者補充'), null, { timeout: 60_000 });
  assert.match(JSON.stringify((await owner.get(`/api/pages/${note.id}`)).page.content), /可以留言的文字，編輯者補充/);
  // 資料庫：可改儲存格與新增列，不能改結構。
  await editor.page.goto(origin + `/p/${database.id}`);
  const cell = editor.page.getByRole('gridcell', { name: '既有列／摘要' });
  await cell.click();
  await editor.page.getByLabel('摘要', { exact: true }).fill('編輯者改的值');
  await editor.page.getByLabel('摘要', { exact: true }).press('Enter');
  await editor.page.getByRole('button', { name: '新增', exact: true }).click();
  await editor.page.getByLabel('新資料列名稱').fill('編輯者新增列');
  await editor.page.getByLabel('新資料列名稱').press('Enter');
  await editor.page.getByRole('gridcell', { name: '編輯者新增列／名稱' }).waitFor();
  assert.equal(await editor.page.getByRole('button', { name: '＋ 新增屬性' }).count(), 0, '成員不能新增欄位');
  assert.equal(await editor.page.getByRole('button', { name: '編輯視圖' }).count(), 0, '成員不能改視圖');
  await editor.synced();
  const rows = (await owner.get(`/api/databases/${database.id}/rows`)).rows;
  assert.deepEqual(rows.map(item => [item.title, item.values[summary] ?? null]), [['既有列', '編輯者改的值'], ['編輯者新增列', null]]);
  console.log('PASS 可編輯成員從「與我共用」開啟，修改內文、儲存格並新增資料列；擁有者端看到變更；結構與分享設定不對成員開放');

  // ---- 唯讀成員：不能輸入，但能選字留言；擁有者看到標記與作者 ----
  await viewer.page.goto(origin + `/p/${note.id}`);
  await viewer.page.getByText(/擁有者 與你共用這個頁面 · 唯讀/).waitFor();
  await viewer.page.locator('.bn-editor').waitFor();
  assert.equal(await viewer.page.locator('.bn-editor[contenteditable="true"]').count(), 0, '唯讀成員的編輯器不可輸入');
  assert.equal(await viewer.page.getByRole('textbox', { name: '頁面標題' }).count(), 0, '唯讀成員不能改標題');
  const before = (await owner.get(`/api/pages/${note.id}`)).page.version;
  await viewer.page.getByText('可以留言的文字').click({ clickCount: 3 });
  const bar = viewer.page.getByRole('toolbar', { name: '選取文字工具' });
  await bar.getByRole('button', { name: '留言' }).click();
  await viewer.page.getByLabel('留言', { exact: true }).fill('唯讀者的留言');
  await viewer.page.getByRole('button', { name: '送出留言' }).click();
  await viewer.page.locator('.annotation-message', { hasText: '唯讀者的留言' }).waitFor();
  await viewer.page.getByRole('button', { name: '反應 👍' }).click();
  await viewer.page.getByRole('button', { name: '移除反應 👍' }).waitFor();
  await viewer.page.getByRole('button', { name: '關閉留言' }).click();
  await viewer.page.locator('.annotation-highlight').first().waitFor();
  const discussions = (await owner.get(`/api/pages/${note.id}/annotations`)).annotations;
  assert.equal(discussions.length, 1);
  assert.deepEqual([discussions[0].author.name, discussions[0].messages[0].text, discussions[0].messages[0].author.name], ['唯讀者', '唯讀者的留言', '唯讀者']);
  assert.deepEqual([discussions[0].reactions, discussions[0].mine, discussions[0].canDelete, discussions[0].floating], [['👍'], [], true, true], '表情是唯讀者的，不是擁有者的；討論不在內文留標記');
  const marked = (await owner.get(`/api/pages/${note.id}`)).page;
  assert.equal(marked.version, before, '唯讀成員的留言不會改動頁面，也不產生新版本');
  assert.ok(!JSON.stringify(marked.content).includes(discussions[0].id), '內文沒有被加入任何標記');
  assert.match(JSON.stringify(marked.content), /編輯者補充/, '內文不變');
  // 唯讀成員直接寫入內文會被拒絕。
  assert.equal((await viewer.context.request.put(origin + `/api/pages/${note.id}/content`, { headers: { ...viewer.headers, 'if-match': `"${marked.version}"` }, data: { content: [text('x', '唯讀者想改')] } })).status(), 403);
  await owner.page.locator('.annotation-highlight').first().waitFor({ timeout: 60_000 });
  await owner.page.locator('.annotation-highlight').first().click();
  await owner.page.locator('.annotation-message', { hasText: '唯讀者的留言' }).waitFor();
  assert.match(await owner.page.locator('.annotation-message').first().innerText(), /唯讀者 ·/);
  await owner.page.getByRole('button', { name: '加上反應 👍' }).click();
  await owner.page.getByRole('button', { name: '移除反應 👍' }).waitFor();
  assert.match(await owner.page.getByRole('button', { name: '移除反應 👍' }).innerText(), /2/, '兩個人各自的表情合計為 2');
  await owner.page.getByRole('button', { name: '關閉留言' }).click();
  // 唯讀成員看資料庫：只有值，沒有新增。
  await viewer.page.goto(origin + `/p/${database.id}`);
  await viewer.page.getByRole('gridcell', { name: '既有列／摘要' }).click();
  assert.equal(await viewer.page.getByLabel('摘要', { exact: true }).count(), 0, '唯讀成員不能編輯儲存格');
  assert.equal(await viewer.page.getByRole('button', { name: '新增', exact: true }).count(), 0);
  console.log('PASS 唯讀成員不能輸入但可選字留言與加表情；頁面內容與版本不變，雙方畫面依引文標示，擁有者看到作者與各自的表情');

  // ---- 公開連結：匿名、唯讀、看不到留言，範圍外的連結被替換 ----
  const anonymous = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  anonymous.setDefaultTimeout(30_000);
  const visitor = await anonymous.newPage();
  visitor.on('pageerror', error => errors.push(`訪客: ${error.message}`));
  const asked = []; visitor.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/')) asked.push(url.pathname); });
  const landing = await visitor.goto(firstLink.href);
  assert.equal(landing.headers()['x-robots-tag'], 'noindex, nofollow');
  await visitor.getByRole('heading', { level: 1, name: '分享的筆記' }).waitFor();
  await visitor.waitForFunction(() => { const img = globalThis.document.querySelector('.bn-editor img'); return img?.complete && img.naturalWidth > 0; });
  assert.match(await visitor.locator('.bn-editor img').first().getAttribute('src'), /^\/api\/public\/[^/]+\/files\//);
  const shown = await visitor.locator('.bn-editor').innerText();
  assert.match(shown, /可以留言的文字，編輯者補充/);
  assert.match(shown, /無法存取的頁面/);
  assert.doesNotMatch(await visitor.content(), /不分享的私人頁面|唯讀者的留言/, '私人頁面的標題與留言不會送到訪客的瀏覽器');
  assert.equal(await visitor.locator('.annotation-highlight').count(), 0);
  assert.equal(await visitor.getByRole('button', { name: /留言與反應/ }).count(), 0);
  assert.equal(await visitor.locator('[contenteditable="true"]').count(), 0);
  await visitor.locator('.page-link-chip', { hasText: '範圍內子頁' }).click();
  await visitor.waitForURL(new RegExp(`/s/[^/]+/${child.id}$`));
  await visitor.getByRole('heading', { level: 1, name: '範圍內子頁' }).waitFor();
  await visitor.getByRole('navigation', { name: '分享的頁面' }).getByText('分享的資料庫').click();
  await visitor.getByRole('gridcell', { name: '既有列／摘要' }).waitFor();
  assert.match(await visitor.getByRole('gridcell', { name: '既有列／摘要' }).innerText(), /編輯者改的值/);
  assert.equal(await visitor.getByRole('button', { name: '新增', exact: true }).count(), 0);
  assert.ok(asked.length > 0 && asked.every(path => path.startsWith('/api/public/') || path === '/api/version'), `訪客只使用公開端點：${[...new Set(asked.filter(path => !path.startsWith('/api/public/')))].join(', ')}`);
  for (const path of [`/api/pages/${note.id}`, `/api/pages/${note.id}/annotations`, picture.url, '/api/shares']) assert.equal((await anonymous.request.get(origin + path)).status(), 401, path);
  assert.equal((await anonymous.request.get(`${origin}/api/public${firstLink.pathname.slice(2)}/pages/${secret.id}`)).status(), 404);
  console.log('PASS 匿名訪客開啟公開連結：圖片可見、內容唯讀、沒有留言，範圍外連結被替換，可在範圍內瀏覽子頁與資料庫，只使用公開端點');

  // ---- 停用與重新開啟公開連結 ----
  await owner.page.getByRole('button', { name: '已分享' }).click();
  await dialog.getByRole('switch', { name: /公開連結/ }).uncheck();
  await dialog.getByLabel('公開連結網址').waitFor({ state: 'detached' });
  await visitor.goto(firstLink.href);
  await visitor.getByText('這個連結無法開啟').waitFor();
  await dialog.getByRole('switch', { name: /公開連結/ }).check();
  const secondLink = await linkOf();
  assert.notEqual(secondLink.pathname, firstLink.pathname, '重新開啟會換新網址');
  await dialog.getByRole('button', { name: '完成' }).click();
  await visitor.goto(secondLink.href);
  await visitor.getByRole('heading', { level: 1, name: '分享的筆記' }).waitFor();
  assert.equal((await anonymous.request.get(`${origin}/api/public${firstLink.pathname.slice(2)}`)).status(), 404, '舊網址永久失效');
  console.log('PASS 停用公開連結後舊網址失效；重新開啟產生新網址');

  // ---- 可編輯成員離線編輯共用筆記，連線後同步 ----
  await editor.page.goto(origin + `/p/${child.id}`);
  await editor.page.getByRole('textbox', { name: '頁面標題' }).waitFor();
  await editor.synced();
  await editor.context.setOffline(true);
  await editor.page.reload();
  await editor.page.getByRole('treeitem', { name: /分享的筆記/ }).waitFor();
  const body = editor.page.locator('.bn-editor[contenteditable="true"]').first();
  await body.click();
  await editor.page.keyboard.type('編輯者離線寫的內容');
  await editor.page.waitForFunction(() => globalThis.document.querySelector('.save-status')?.getAttribute('data-status') === 'local');
  await editor.page.reload();
  await editor.page.waitForFunction(() => globalThis.document.querySelector('.bn-editor')?.textContent.includes('編輯者離線寫的內容'));
  assert.doesNotMatch(JSON.stringify((await owner.get(`/api/pages/${child.id}`)).page.content), /編輯者離線寫的內容/);
  await editor.context.setOffline(false);
  await editor.page.waitForFunction(() => globalThis.document.querySelector('.save-status')?.getAttribute('data-status') === 'clean', null, { timeout: 60_000 });
  assert.match(JSON.stringify((await owner.get(`/api/pages/${child.id}`)).page.content), /編輯者離線寫的內容/);
  console.log('PASS 可編輯成員離線開啟並編輯共用筆記，離線重新載入後仍在，恢復連線後同步到擁有者的頁面');

  // ---- 離線期間被移除：修改留在裝置上，不會寫入，也不會消失 ----
  await editor.context.setOffline(true);
  await body.click();
  await editor.page.keyboard.type('，被移除後才同步的修改');
  await editor.page.waitForFunction(() => globalThis.document.querySelector('.save-status')?.getAttribute('data-status') === 'local');
  const removed = await owner.context.request.delete(origin + `/api/pages/${note.id}/share/members/${editor.id}`, { headers: owner.headers });
  assert.equal(removed.status(), 200);
  await editor.context.setOffline(false);
  await editor.page.waitForFunction(async id => {
    const request = globalThis.indexedDB.open('notes-offline-v1', 1);
    const records = await new Promise(resolve => { request.onsuccess = () => { const db = request.result, read = db.transaction('records').objectStore('records').getAll(); read.onsuccess = () => { db.close(); resolve(read.result); }; }; });
    return records.some(item => item?.local?.page?.id === id && item.pending && item.problem);
  }, child.id, { timeout: 60_000 });
  const kept = (await local(editor.page, 'page:')).find(item => item.local.page.id === child.id);
  assert.match(JSON.stringify(kept.local.page.content), /被移除後才同步的修改/, '未同步的修改仍在裝置上，可匯出');
  assert.doesNotMatch(JSON.stringify((await owner.get(`/api/pages/${child.id}`)).page.content), /被移除後才同步的修改/);
  assert.equal(await editor.status(`/api/pages/${note.id}`), 404);
  assert.equal(await editor.status(picture.url), 404);
  await editor.page.goto(origin);
  await editor.page.getByText('部分筆記需要處理').first().waitFor();
  await editor.page.getByRole('button', { name: '離線與同步' }).click();
  await editor.page.getByRole('link', { name: '範圍內子頁' }).waitFor();
  await editor.page.getByRole('button', { name: '匯出本機草稿' }).waitFor();
  await editor.page.keyboard.press('Escape');
  assert.equal(await editor.page.getByRole('treeitem', { name: /分享的筆記/ }).count(), 0, '被移除後不再列在「與我共用」');
  console.log('PASS 離線期間被移除的成員：修改不會寫入擁有者的頁面，草稿留在裝置上待匯出，頁面與附件不再可讀');

  assert.deepEqual(errors, [], `前端錯誤：${errors.join('; ')}`);
  console.log('PASS 全程沒有未捕捉的前端錯誤');
} finally { await browser.close(); }
