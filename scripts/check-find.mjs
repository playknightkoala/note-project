// 僅對全新、可拋棄的測試實例執行；會建立隨機合成帳號與筆記。
//   node scripts/check-find.mjs http://127.0.0.1:18091
// 驗收頁面內的尋找與取代：Ctrl／⌘+F 開啟、計數與上下一個、捲動到目前結果並展開收合的折疊列表、
// 取代與全部取代會自動保存且可一次復原、Esc 關閉、頁面選單入口、手機寬度、深色模式、公開連結只能尋找、
// 資料庫頁面交還瀏覽器。設定 NOTES_SCREENSHOT_DIR 時另存畫面截圖。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const { chromium } = await import(process.env.NOTES_PLAYWRIGHT_MODULE ?? 'playwright');
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:18091').origin;
const shots = process.env.NOTES_SCREENSHOT_DIR;
const browser = await chromium.launch({ ...(process.env.NOTES_CHROME_PATH ? { executablePath: process.env.NOTES_CHROME_PATH } : {}), headless: true });
const text = (id, value, type = 'paragraph') => ({ id, type, props: {}, content: [{ type: 'text', text: value, styles: {} }], children: [] });
const passed = [];
const pass = name => { passed.push(name); console.log(`PASS ${name}`); };
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  context.setDefaultTimeout(20_000);
  const auth = await context.request.post(origin + '/api/auth/register', { headers: { origin }, data: { email: `${randomUUID()}@example.test`, displayName: '尋找取代驗收', password: randomUUID() } });
  assert.ok(auth.ok(), `註冊：${auth.status()}（需要全新的測試實例）`);
  const headers = { origin, 'x-csrf-token': (await auth.json()).csrfToken };
  const post = async (path, data = {}) => { const response = await context.request.post(origin + path, { headers, data }); assert.ok(response.ok(), `${path}：${response.status()}`); return response.json(); };
  const get = async path => (await context.request.get(origin + path)).json();

  const note = (await post('/api/pages', { title: '尋找與取代驗收' })).page;
  const content = [
    text('top', 'Check 清單：先 check 第一項'),
    { id: 'styled', type: 'paragraph', props: {}, content: [{ type: 'text', text: '粗體 che', styles: { bold: true } }, { type: 'text', text: 'ck 跨樣式', styles: {} }], children: [] },
    ...Array.from({ length: 40 }, (_, index) => text(`filler-${index}`, `填充段落 ${index + 1}`)),
    { ...text('toggle', '折疊的項目', 'toggleListItem'), children: [text('hidden', '收合在裡面的 check')] },
    text('bottom', '最後一個 CHECK'),
  ];
  const saved = await context.request.put(origin + `/api/pages/${note.id}/content`, { headers: { ...headers, 'if-match': `"${note.version}"` }, data: { content } });
  assert.equal(saved.status(), 200);
  /** The saved note as plain text, one line per block (a word may be split across differently styled pieces). */
  const plain = blocks => blocks.map(block => [Array.isArray(block.content) ? block.content.map(part => part.text ?? '').join('') : '', plain(block.children ?? [])].filter(Boolean).join('\n')).join('\n');
  const serverBlocks = async () => (await get(`/api/pages/${note.id}`)).page.content;
  const serverText = async () => plain(await serverBlocks());
  /** The note's autosave reaching the server (an ordinary note is saved through the offline endpoint). */
  const savedNote = response => response.request().method() === 'PUT' && response.url().includes(note.id) && response.status() === 200;
  const occurrences = (value, word) => value.toLowerCase().split(word).length - 1;

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(origin + '/p/' + note.id);
  await page.locator('.bn-editor').waitFor();
  const mod = (await page.evaluate(() => /Mac|iPhone|iPad/.test(globalThis.navigator.platform))) ? 'Meta' : 'Control';
  const bar = page.getByRole('search', { name: '在頁面中尋找' });
  const input = page.getByLabel('尋找文字');
  const count = bar.getByRole('status').first();
  const inView = () => page.evaluate(() => { const box = globalThis.document.querySelector('.find-match--current')?.getBoundingClientRect(); return !!box && box.top >= 44 && box.bottom <= globalThis.window.innerHeight; });
  const currentText = () => page.evaluate(() => [...globalThis.document.querySelectorAll('.find-match--current')].map(element => element.textContent).join(''));

  // 開啟、輸入、計數
  await page.keyboard.press(`${mod}+f`);
  await bar.waitFor();
  assert.ok(await input.evaluate(element => element === globalThis.document.activeElement), '開啟後焦點在尋找欄位');
  await page.keyboard.type('check');
  await assert.doesNotReject(page.waitForFunction(() => globalThis.document.querySelector('.find-bar [role="status"]')?.textContent === '1 / 5'));
  assert.equal(await page.locator('.find-match--current').count() > 0, true);
  assert.equal(await currentText(), 'Check');
  const under = async () => { const top = await page.locator('.page > .topbar').boundingBox(), box = await bar.boundingBox(); return box.y >= top.y + top.height; };
  assert.ok(await under(), '尋找列在頂列下方，不蓋住頂列按鈕');
  await shot(page, 'find-light');
  pass('Ctrl／⌘+F 開啟尋找列，不分大小寫找到 5 筆');

  // 上下一個、跨樣式、捲動、展開折疊
  await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
  assert.equal(await count.textContent(), '3 / 5');
  assert.equal(await currentText(), 'check', '跨粗體與一般文字的結果');
  const toggle = page.locator('.bn-toggle-button').first();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false', '折疊列表起始為收合');
  await page.keyboard.press('Enter');
  assert.equal(await count.textContent(), '4 / 5');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true', '目前結果在收合的折疊列表內時會展開');
  assert.ok(await inView(), '目前結果捲入畫面');
  assert.ok(await under(), '捲動後尋找列仍在頂列下方');
  await page.keyboard.press(`${mod}+g`);
  assert.equal(await count.textContent(), '5 / 5');
  assert.ok(await inView());
  await page.keyboard.press('Enter');
  assert.equal(await count.textContent(), '1 / 5', '最後一筆之後回到第一筆');
  assert.ok(await inView());
  await page.keyboard.press('Shift+Enter');
  assert.equal(await count.textContent(), '5 / 5');
  await bar.getByRole('button', { name: '下一個' }).click();
  assert.equal(await count.textContent(), '1 / 5');
  assert.ok(await input.evaluate(element => element === globalThis.document.activeElement), '按箭頭後焦點仍在尋找欄位');
  pass('Enter／Shift+Enter／箭頭／⌘G 切換結果，會捲動並展開折疊列表');

  // 取代與全部取代
  const before = await serverText();
  assert.equal(occurrences(before, 'check'), 5);
  await bar.getByRole('button', { name: '取代', exact: true }).click();
  await page.getByLabel('取代為').fill('確認');
  await shot(page, 'replace-light');
  const firstSave = page.waitForResponse(savedNote);
  await page.getByLabel('取代為').press('Enter');
  assert.equal(await count.textContent(), '1 / 4');
  await firstSave;
  let now = await serverText();
  assert.equal(occurrences(now, 'check'), 4);
  assert.ok(now.includes('確認 清單：先 check 第一項'), '只取代目前這一筆');
  pass('「取代」只改目前這一筆並自動保存');

  const secondSave = page.waitForResponse(savedNote);
  await bar.getByRole('button', { name: '全部取代' }).click();
  assert.equal(await count.textContent(), '無結果');
  assert.equal(await bar.getByText('已取代 4 處').count(), 1);
  await secondSave;
  now = await serverText();
  assert.equal(occurrences(now, 'check'), 0);
  assert.equal(occurrences(now, '確認'), 5);
  assert.ok(JSON.stringify(await serverBlocks()).includes('"text":"粗體 確認","styles":{"bold":true}'), '取代的文字沿用原本第一個字的樣式');
  pass('「全部取代」改掉其餘 4 筆並自動保存，樣式保留');

  // Esc 關閉、復原
  await input.press('Escape');
  await bar.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.find-match').count(), 0, '關閉後不留高亮');
  assert.ok(await page.evaluate(() => !!globalThis.document.activeElement?.closest('.bn-editor')), 'Esc 後焦點回到內文');
  const undone = page.waitForResponse(savedNote);
  await page.keyboard.press(`${mod}+z`);
  await undone;
  assert.equal(occurrences(await serverText(), 'check'), 4, '一次復原還原整個「全部取代」');
  pass('Esc 關閉並清除高亮；全部取代可一次復原');

  // 頁面選單入口、再按一次交還瀏覽器
  await page.getByRole('button', { name: '頁面選單' }).click();
  await page.getByRole('menuitem', { name: '尋找與取代' }).click();
  await bar.waitFor();
  await page.waitForFunction(() => globalThis.document.activeElement?.getAttribute('aria-label') === '尋找文字');
  assert.equal(await input.inputValue(), 'check', '再次開啟時保留上次的搜尋文字');
  assert.equal(await count.textContent(), '1 / 4');
  await page.keyboard.press(`${mod}+f`);
  await bar.waitFor({ state: 'hidden' });
  pass('頁面選單可開啟；在尋找欄位再按一次 Ctrl／⌘+F 會關閉並交還瀏覽器');

  // 選取文字後開啟會帶入
  await page.locator('.bn-editor').getByText('填充段落 1', { exact: true }).dblclick();
  const picked = await page.evaluate(() => String(globalThis.window.getSelection()));
  assert.ok(picked.length > 0 && '填充段落 1'.includes(picked), '雙擊選到這一行的文字');
  await page.keyboard.press(`${mod}+f`);
  await bar.waitFor();
  assert.equal(await input.inputValue(), picked);
  assert.match(await count.textContent(), /^1 \/ \d+$/);
  assert.ok(picked.includes(await currentText()) && await inView(), '從選取的位置開始找');
  await input.press('Escape');
  pass('選取文字後開啟會帶入選取的文字');

  // 手機寬度
  await page.setViewportSize({ width: 390, height: 780 });
  await page.getByRole('button', { name: '頁面選單' }).click();
  await page.getByRole('menuitem', { name: '尋找與取代' }).click();
  await bar.waitFor();
  await input.fill('check');
  await bar.getByRole('button', { name: '取代', exact: true }).click().catch(() => {});
  const box = await bar.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, '手機寬度下尋找列不超出畫面');
  await shot(page, 'find-mobile');
  await input.press('Escape');
  await page.setViewportSize({ width: 1280, height: 800 });
  pass('手機寬度下尋找列完整顯示');

  // 資料庫頁面沒有內文：不攔截
  const database = (await post('/api/pages', { kind: 'database', title: '資料庫' })).page;
  await page.goto(origin + '/p/' + database.id);
  await page.locator('.database-view').waitFor();
  await page.keyboard.press(`${mod}+f`);
  await page.waitForTimeout(300);
  assert.equal(await bar.count(), 0, '資料庫頁面不顯示尋找列');
  pass('資料庫頁面交還瀏覽器的尋找');

  // 深色模式
  const dark = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', storageState: await context.storageState() });
  const darkPage = await dark.newPage();
  await darkPage.goto(origin + '/p/' + note.id);
  await darkPage.locator('.bn-editor').waitFor();
  await darkPage.keyboard.press(`${mod}+f`);
  await darkPage.getByLabel('尋找文字').fill('check');
  await darkPage.getByRole('button', { name: '取代', exact: true }).click();
  await darkPage.getByLabel('取代為').fill('確認');
  await shot(darkPage, 'replace-dark');
  await dark.close();
  pass('深色模式可開啟');

  // 公開連結：只能尋找
  await post(`/api/pages/${note.id}/share/link`);
  const token = (await get(`/api/pages/${note.id}/share`)).share.link.token;
  const anonymous = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const visitor = await anonymous.newPage();
  visitor.on('pageerror', error => errors.push(String(error)));
  await visitor.goto(origin + '/s/' + token);
  await visitor.locator('.bn-editor').waitFor();
  await visitor.keyboard.press(`${mod}+f`);
  await visitor.getByLabel('尋找文字').fill('check');
  assert.equal(await visitor.getByRole('search').getByRole('status').first().textContent(), '1 / 4');
  assert.equal(await visitor.getByRole('button', { name: '取代', exact: true }).count(), 0, '公開連結沒有取代');
  await shot(visitor, 'find-public');
  await anonymous.close();
  pass('公開連結可尋找、不能取代');

  assert.deepEqual(errors, [], '頁面不應有未處理的錯誤');
  console.log(`\n${passed.length} 項 PASS`);
} finally {
  await browser.close();
}
