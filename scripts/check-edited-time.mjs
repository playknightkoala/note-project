// 僅對全新、可拋棄的測試實例執行；會建立隨機合成帳號與筆記。
//   node scripts/check-edited-time.mjs http://127.0.0.1:18091
// 驗收頁面頂列的最後編輯時間：與保存狀態並列、開著頁面時會自己更新、在此編輯後變成「剛剛編輯」、
// 手機寬度改列在頁面選單底部、資料庫頁面不顯示。設定 NOTES_SCREENSHOT_DIR 時另存畫面截圖。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const { chromium } = await import(process.env.NOTES_PLAYWRIGHT_MODULE ?? 'playwright');
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:18091').origin;
const shots = process.env.NOTES_SCREENSHOT_DIR;
const browser = await chromium.launch({ ...(process.env.NOTES_CHROME_PATH ? { executablePath: process.env.NOTES_CHROME_PATH } : {}), headless: true });
const passed = [];
const pass = name => { passed.push(name); console.log(`PASS ${name}`); };
const HOUR = 3_600_000;

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  context.setDefaultTimeout(20_000);
  const auth = await context.request.post(origin + '/api/auth/register', { headers: { origin }, data: { email: `${randomUUID()}@example.test`, displayName: '編輯時間驗收', password: randomUUID() } });
  assert.ok(auth.ok(), `註冊：${auth.status()}（需要全新的測試實例）`);
  const headers = { origin, 'x-csrf-token': (await auth.json()).csrfToken };
  const post = async (path, data = {}) => { const response = await context.request.post(origin + path, { headers, data }); assert.ok(response.ok(), `${path}：${response.status()}`); return response.json(); };

  const note = (await post('/api/pages', { title: '編輯時間驗收' })).page;
  const content = [{ id: 'first', type: 'paragraph', props: {}, content: [{ type: 'text', text: '四小時前寫下的內容', styles: {} }], children: [] }];
  const saved = await context.request.put(origin + `/api/pages/${note.id}/content`, { headers: { ...headers, 'if-match': `"${note.version}"` }, data: { content } });
  assert.equal(saved.status(), 200);
  const database = (await post('/api/pages', { title: '編輯時間驗收資料庫', kind: 'database' })).page;

  // 瀏覽器的時鐘撥快四小時又五分鐘：剛才保存的筆記就是「四小時前」編輯的。
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.clock.install({ time: Date.now() + 4 * HOUR + 5 * 60_000 });
  await page.goto(origin + '/p/' + note.id);
  await page.locator('.bn-editor').waitFor();
  const label = page.locator('.topbar .edited-time');
  await label.waitFor();
  assert.equal(await label.textContent(), '已於 4 小時前 編輯');
  assert.match(await label.getAttribute('title'), /^最後編輯：\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}$/);
  const status = page.locator('.topbar .save-status');
  await page.waitForFunction(() => globalThis.document.querySelector('.save-status')?.getAttribute('data-status') === 'clean');
  assert.equal((await status.textContent()).trim(), '已同步');
  const [labelBox, statusBox] = [await label.boundingBox(), await status.boundingBox()];
  assert.ok(labelBox.x + labelBox.width <= statusBox.x && Math.abs(labelBox.y + labelBox.height / 2 - statusBox.y - statusBox.height / 2) <= 3, '編輯時間在保存狀態左邊、同一列');
  if (shots) await page.screenshot({ path: join(shots, 'edited-light.png') });
  pass('頂列在「已同步」左邊顯示「已於 4 小時前 編輯」，滑鼠停留有完整時間');

  // 開著不動，時間自己往前走。
  await page.clock.fastForward(HOUR);
  await page.waitForFunction(() => globalThis.document.querySelector('.topbar .edited-time')?.textContent === '已於 5 小時前 編輯');
  pass('頁面開著一小時後自動變成「已於 5 小時前 編輯」');

  // 在這裡編輯：立刻變成剛剛，保存完成後兩個狀態並列。
  await page.locator('.bn-editor .bn-block[data-id="first"]').click();
  await page.keyboard.press('End');
  await page.keyboard.type('，現在補上一句');
  await page.waitForFunction(() => globalThis.document.querySelector('.topbar .edited-time')?.textContent === '剛剛編輯');
  await page.waitForFunction(() => globalThis.document.querySelector('.save-status')?.getAttribute('data-status') === 'clean');
  assert.equal(await label.textContent(), '剛剛編輯');
  pass('在此編輯後變成「剛剛編輯」，保存後仍與「已同步」並列');
  await page.clock.fastForward(3 * 60_000);
  await page.waitForFunction(() => globalThis.document.querySelector('.topbar .edited-time')?.textContent === '已於 3 分鐘前 編輯');
  pass('三分鐘後變成「已於 3 分鐘前 編輯」');

  // 深色模式
  await page.emulateMedia({ colorScheme: 'dark' });
  if (shots) await page.screenshot({ path: join(shots, 'edited-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });

  // 資料庫頁面：資料列各自編輯，頁面本身不顯示編輯時間。
  await page.goto(origin + '/p/' + database.id);
  await page.locator('.topbar .save-status').waitFor();
  assert.equal(await page.locator('.edited-time').count(), 0);
  await page.getByRole('button', { name: '頁面選單' }).click();
  await page.getByRole('menuitem', { name: '複製連結' }).waitFor();
  assert.equal(await page.locator('.edited-time-menu').count(), 0);
  await page.keyboard.press('Escape');
  pass('資料庫頁面不顯示編輯時間');

  // 手機寬度：頂列放不下，改列在頁面選單底部。
  const phone = await browser.newContext({ viewport: { width: 390, height: 800 }, storageState: await context.storageState() });
  phone.setDefaultTimeout(20_000);
  const mobile = await phone.newPage();
  mobile.on('pageerror', error => errors.push(String(error)));
  await mobile.goto(origin + '/p/' + note.id);
  await mobile.locator('.bn-editor').waitFor();
  await mobile.locator('.topbar .save-status').waitFor();
  assert.equal(await mobile.locator('.topbar .edited-time').isVisible(), false, '手機寬度的頂列不顯示編輯時間');
  await mobile.getByRole('button', { name: '頁面選單' }).click();
  const inMenu = mobile.locator('.edited-time-menu');
  await inMenu.waitFor();
  assert.equal(await inMenu.textContent(), '剛剛編輯');
  if (shots) { await mobile.waitForTimeout(400); await mobile.screenshot({ path: join(shots, 'edited-mobile-menu.png') }); }
  pass('手機寬度改列在頁面選單底部');
  await mobile.keyboard.press('Escape');

  // 電腦寬度的頁面選單不重複顯示。
  await page.goto(origin + '/p/' + note.id);
  await page.locator('.bn-editor').waitFor();
  await page.getByRole('button', { name: '頁面選單' }).click();
  await page.getByRole('menuitem', { name: '頁面歷史' }).waitFor();
  assert.equal(await page.locator('.edited-time-menu').isVisible(), false);
  pass('電腦寬度的頁面選單不重複顯示');

  assert.deepEqual(errors, [], '頁面沒有未處理的錯誤');
  console.log(`\n${passed.length} 項通過`);
} finally {
  await browser.close();
}
