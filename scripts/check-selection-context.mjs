// 僅對全新、可拋棄的測試實例執行；會建立隨機合成帳號與筆記。
//   node scripts/check-selection-context.mjs http://127.0.0.1:18091
// 驗收選取文字後的右鍵：選取時格式面板照常出現，對選取的文字按右鍵不被攔截（瀏覽器自己的選單），
// 選取仍在、頁面的自訂右鍵選單不出現；內文以外的空白處按右鍵仍是頁面的自訂選單。
// headless 看不到瀏覽器自己的選單，檢查的是 contextmenu 事件沒有被取消。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const { chromium } = await import(process.env.NOTES_PLAYWRIGHT_MODULE ?? 'playwright');
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:18091').origin;
const browser = await chromium.launch({ ...(process.env.NOTES_CHROME_PATH ? { executablePath: process.env.NOTES_CHROME_PATH } : {}), headless: true });
const passed = [];
const pass = name => { passed.push(name); console.log(`PASS ${name}`); };

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  context.setDefaultTimeout(20_000);
  const auth = await context.request.post(origin + '/api/auth/register', { headers: { origin }, data: { email: `${randomUUID()}@example.test`, displayName: '選取右鍵驗收', password: randomUUID() } });
  assert.ok(auth.ok(), `註冊：${auth.status()}（需要全新的測試實例）`);
  const headers = { origin, 'x-csrf-token': (await auth.json()).csrfToken };
  const created = await context.request.post(origin + '/api/pages', { headers, data: { title: '選取右鍵驗收' } });
  assert.ok(created.ok());
  const note = (await created.json()).page;
  const content = [{ id: 'first', type: 'paragraph', props: {}, content: [{ type: 'text', text: 'selection keeps the native menu', styles: {} }], children: [] }];
  const saved = await context.request.put(origin + `/api/pages/${note.id}/content`, { headers: { ...headers, 'if-match': `"${note.version}"` }, data: { content } });
  assert.equal(saved.status(), 200);

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto(origin + '/p/' + note.id);
  await page.locator('.bn-editor').waitFor();
  // What reaches the browser after every handler of the page has run: a cancelled event means no native menu.
  await page.evaluate(() => {
    globalThis.contextEvents = [];
    globalThis.window.addEventListener('contextmenu', event => { globalThis.contextEvents.push({ cancelled: event.defaultPrevented, shift: event.shiftKey }); });
  });
  const events = () => page.evaluate(() => globalThis.contextEvents.splice(0));
  const selectedText = () => page.evaluate(() => globalThis.window.getSelection()?.toString() ?? '');
  const toolbar = page.getByLabel('文字選取工具');
  const pageMenu = page.getByRole('menu', { name: '頁面右鍵選單' });

  // 選取文字：格式面板照常出現
  const block = page.locator('.bn-editor .bn-block[data-id="first"] .bn-inline-content');
  const box = await block.boundingBox();
  const at = { x: box.x + 30, y: box.y + box.height / 2 };
  await page.mouse.dblclick(at.x, at.y);
  await toolbar.waitFor();
  assert.equal(await selectedText(), 'selection');
  pass('選取文字後格式面板照常出現');

  // 對選取的文字按右鍵：不攔截
  await page.mouse.click(at.x, at.y, { button: 'right' });
  assert.deepEqual(await events(), [{ cancelled: false, shift: false }]);
  assert.equal(await selectedText(), 'selection', '右鍵後選取仍在');
  assert.equal(await pageMenu.count(), 0, '不出現頁面的自訂右鍵選單');
  assert.ok(await toolbar.isVisible(), '格式面板仍在');
  pass('對選取的文字按右鍵不被攔截，選取與格式面板仍在');

  await page.keyboard.down('Shift');
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.keyboard.up('Shift');
  assert.deepEqual((await events()).map(event => event.cancelled), [false]);
  pass('Shift+右鍵同樣不被攔截');

  // 沒有選取時在內文按右鍵：原本就不攔截
  await page.keyboard.press('Escape');
  await page.mouse.click(at.x + 200, at.y);
  await page.mouse.click(at.x + 200, at.y, { button: 'right' });
  assert.deepEqual((await events()).map(event => event.cancelled), [false]);
  assert.equal(await pageMenu.count(), 0);
  pass('沒有選取時在內文按右鍵不被攔截');

  // 內文以外的空白處：仍是頁面的自訂選單
  const body = await page.locator('.page-body').boundingBox();
  await page.mouse.click(body.x + body.width - 20, body.y + body.height - 20, { button: 'right' });
  await pageMenu.waitFor();
  // The custom menu takes the event for itself, so it never reaches the listener on the window.
  assert.deepEqual(await events(), []);
  await page.keyboard.press('Escape');
  pass('內文以外的空白處按右鍵仍是頁面的自訂選單');

  assert.deepEqual(errors, [], '頁面沒有未處理的錯誤');
  console.log(`\n${passed.length} 項通過`);
} finally {
  await browser.close();
}
