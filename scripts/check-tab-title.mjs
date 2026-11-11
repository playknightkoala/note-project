// 僅對全新、可拋棄的測試實例執行；會建立隨機合成帳號與筆記。
//   node scripts/check-tab-title.mjs http://127.0.0.1:18091
// 驗收瀏覽器分頁的標題與圖示：頁面開啟時是「標題 | Notes」與頁面的表情圖示，改標題、換圖示、移除圖示時跟著變；
// 沒有圖示的頁面是原本的 LOGO；離開頁面後還原；公開連結頁相同。headless 沒有分頁列，圖示另外畫出來截圖檢視
// （設定 NOTES_SCREENSHOT_DIR 時）。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const { chromium } = await import(process.env.NOTES_PLAYWRIGHT_MODULE ?? 'playwright');
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:18091').origin;
const shots = process.env.NOTES_SCREENSHOT_DIR;
const browser = await chromium.launch({ ...(process.env.NOTES_CHROME_PATH ? { executablePath: process.env.NOTES_CHROME_PATH } : {}), headless: true });
const passed = [];
const pass = name => { passed.push(name); console.log(`PASS ${name}`); };
const LOGO = '/notes-icon.svg';

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  context.setDefaultTimeout(20_000);
  const auth = await context.request.post(origin + '/api/auth/register', { headers: { origin }, data: { email: `${randomUUID()}@example.test`, displayName: '分頁標題驗收', password: randomUUID() } });
  assert.ok(auth.ok(), `註冊：${auth.status()}（需要全新的測試實例）`);
  const headers = { origin, 'x-csrf-token': (await auth.json()).csrfToken };
  const send = async (method, path, data = {}) => { const response = await context.request.fetch(origin + path, { method, headers, data }); assert.ok(response.ok(), `${method} ${path}：${response.status()}`); return response.json(); };
  const get = async path => (await context.request.get(origin + path)).json();

  const welcome = (await send('POST', '/api/pages', { title: 'Welcome to Notes' })).page;
  await send('PATCH', `/api/pages/${welcome.id}`, { icon: '👋' });
  const plain = (await send('POST', '/api/pages', { title: 'TEST' })).page;
  const database = (await send('POST', '/api/pages', { title: '分頁標題資料庫', kind: 'database' })).page;
  await send('PATCH', `/api/pages/${database.id}`, { icon: '📊' });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  /** The tab as the browser has it: the document title, and what the only icon link points to. */
  const tab = target => target.evaluate(() => {
    const links = [...globalThis.document.querySelectorAll('link[rel="icon"]')];
    const href = links[0]?.getAttribute('href') ?? '';
    return { title: globalThis.document.title, count: links.length, logo: href, emoji: href.startsWith('data:image/svg+xml,') ? new globalThis.DOMParser().parseFromString(decodeURIComponent(href.slice(19)), 'image/svg+xml').querySelector('text')?.textContent ?? '' : null };
  });
  const waitTab = (target, title, emoji) => target.waitForFunction(([wantTitle, wantEmoji]) => {
    const href = globalThis.document.querySelector('link[rel="icon"]')?.getAttribute('href') ?? '';
    return globalThis.document.title === wantTitle && (wantEmoji === null ? href === '/notes-icon.svg' : href.startsWith('data:image/svg+xml,') && decodeURIComponent(href).includes(`>${wantEmoji}</text>`));
  }, [title, emoji]);
  /** Whether the browser can draw the icon: it is loaded as an image, the way a tab icon is. */
  const drawable = target => target.evaluate(async () => {
    const image = new globalThis.Image();
    image.src = globalThis.document.querySelector('link[rel="icon"]').href;
    await image.decode();
    return image.naturalWidth > 0;
  });

  // 首頁：應用程式自己的標題與 LOGO
  await page.goto(origin + '/');
  await page.getByText('新增頁面').first().waitFor();
  assert.deepEqual(await tab(page), { title: 'Notes', count: 1, logo: LOGO, emoji: null });
  pass('首頁是「Notes」與 LOGO');

  // 有圖示的頁面
  await page.goto(origin + '/p/' + welcome.id);
  await page.locator('.bn-editor').waitFor();
  await waitTab(page, 'Welcome to Notes | Notes', '👋');
  assert.equal((await tab(page)).count, 1, '只有一個圖示連結');
  assert.ok(await drawable(page), '表情圖示可以畫出來');
  pass('有圖示的頁面：「Welcome to Notes | Notes」與 👋');

  // 改標題：分頁跟著變
  const title = page.getByLabel('頁面標題');
  await title.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' 2');
  await waitTab(page, 'Welcome to Notes 2 | Notes', '👋');
  pass('改標題後分頁標題跟著變');

  // 換圖示、移除圖示
  await page.getByRole('button', { name: '變更圖示' }).click();
  await page.locator('.icon-picker__emoji:visible').first().waitFor();
  const picked = await page.locator('.icon-picker__emoji:visible').nth(3).textContent();
  await page.locator('.icon-picker__emoji:visible').nth(3).click();
  await waitTab(page, 'Welcome to Notes 2 | Notes', picked);
  assert.ok(await drawable(page));
  pass(`換圖示後分頁圖示跟著變（${picked}）`);
  await page.getByRole('button', { name: '變更圖示' }).click();
  await page.getByRole('button', { name: '移除圖示' }).click();
  await waitTab(page, 'Welcome to Notes 2 | Notes', null);
  pass('移除圖示後回到 LOGO');
  await page.getByRole('button', { name: '新增圖示' }).click();
  await page.locator('.icon-picker__emoji:visible').first().click();
  const added = await page.getByRole('button', { name: '變更圖示' }).textContent();
  await waitTab(page, 'Welcome to Notes 2 | Notes', added);
  pass(`新增圖示後分頁圖示出現（${added}）`);

  // 沒有圖示的頁面（從側邊欄切換，不重新載入）：LOGO
  await page.locator('.tree-row', { hasText: 'TEST' }).first().click();
  await page.waitForURL('**/p/' + plain.id);
  await waitTab(page, 'TEST | Notes', null);
  assert.ok(await drawable(page));
  pass('沒有圖示的頁面：「TEST | Notes」與 LOGO');

  // 清空標題
  await page.getByLabel('頁面標題').fill('');
  await waitTab(page, '無標題 | Notes', null);
  pass('沒有標題的頁面：「無標題 | Notes」');

  // 資料庫頁面
  await page.goto(origin + '/p/' + database.id);
  await waitTab(page, '分頁標題資料庫 | Notes', '📊');
  pass('資料庫頁面也跟著標題與圖示');

  // 離開頁面：還原
  await page.goto(origin + '/p/' + welcome.id);
  await waitTab(page, 'Welcome to Notes 2 | Notes', added);
  await page.locator('.tree-row', { hasText: '垃圾桶' }).or(page.getByRole('link', { name: '垃圾桶' })).first().click();
  await page.waitForURL('**/trash');
  await waitTab(page, 'Notes', null);
  pass('離開頁面後還原為「Notes」與 LOGO');

  // 公開連結
  await send('POST', `/api/pages/${welcome.id}/share/link`);
  const token = (await get(`/api/pages/${welcome.id}/share`)).share.link.token;
  const visitorContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  visitorContext.setDefaultTimeout(20_000);
  const visitor = await visitorContext.newPage();
  visitor.on('pageerror', error => errors.push(String(error)));
  await visitor.goto(origin + '/s/' + token);
  await visitor.locator('.bn-editor').waitFor();
  await waitTab(visitor, 'Welcome to Notes 2 | Notes', added);
  assert.equal((await tab(visitor)).count, 1);
  pass('公開連結頁相同');

  // 把分頁圖示照分頁列的大小畫出來，供人工檢視。
  if (shots) {
    // The sheet is drawn inside the app's own page: the logo may only be loaded from the same origin.
    await visitor.evaluate(logo => {
      const emoji = globalThis.document.querySelector('link[rel="icon"]').href;
      const sheet = globalThis.document.createElement('div');
      sheet.id = 'tab-icon-sheet';
      sheet.style.cssText = 'position:fixed;top:0;left:0;z-index:9999;display:flex;gap:16px;align-items:center;padding:16px;background:#2b2b2b';
      for (const size of [16, 32, 64]) for (const src of [emoji, logo]) { const image = new globalThis.Image(size, size); image.src = src; sheet.append(image); }
      globalThis.document.body.append(sheet);
    }, LOGO);
    await visitor.waitForFunction(() => [...globalThis.document.querySelectorAll('#tab-icon-sheet img')].every(image => image.complete && image.naturalWidth > 0));
    await visitor.locator('#tab-icon-sheet').screenshot({ path: join(shots, 'tab-icons.png') });
  }

  assert.deepEqual(errors, [], '頁面沒有未處理的錯誤');
  console.log(`\n${passed.length} 項通過`);
} finally {
  await browser.close();
}
