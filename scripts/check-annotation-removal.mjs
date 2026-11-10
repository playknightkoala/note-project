// 僅對全新、可拋棄的測試實例執行；會建立隨機合成帳號與筆記。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const { chromium } = await import(process.env.NOTES_PLAYWRIGHT_MODULE ?? 'playwright');
const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:18084').origin;
const browser = await chromium.launch({ ...(process.env.NOTES_CHROME_PATH ? { executablePath: process.env.NOTES_CHROME_PATH } : {}), headless: true });
async function assertHighlight(page, expected) {
  await page.waitForFunction(expected => [...globalThis.document.querySelectorAll('.block-editor span')].some(element => element.textContent.includes('要取消的文字') && !['transparent', 'rgba(0, 0, 0, 0)'].includes(globalThis.getComputedStyle(element).backgroundColor)) === expected, expected, { timeout: 3000 });
}
try {
  const context = await browser.newContext();
  assert.ok((await (await context.request.get(origin + '/api/auth/status')).json()).setupRequired, '請使用全新實例');
  const auth = await context.request.post(origin + '/api/auth/register', { headers: { origin }, data: { email: `${randomUUID()}@example.test`, displayName: '留言取消驗收', password: randomUUID() } });
  assert.ok(auth.ok());
  const session = await auth.json(), headers = { origin, 'x-csrf-token': session.csrfToken };
  const created = await context.request.post(origin + '/api/pages', { headers, data: { title: '取消黃色標記驗收' } });
  const note = (await created.json()).page;
  const path = `/api/pages/${note.id}/annotations`;
  const result = await context.request.post(origin + path, { headers, data: { quote: '要取消的文字', blockIds: ['b'], text: '測試留言' } });
  const annotation = (await result.json()).annotation;
  const content = [{ id: 'b', type: 'paragraph', props: {}, children: [], content: [{ type: 'text', text: '要取消的文字', styles: { annotation: annotation.id } }] }];
  assert.equal((await context.request.put(origin + `/api/pages/${note.id}/content`, { headers: { ...headers, 'if-match': `"${note.version}"` }, data: { content } })).status(), 200);
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + `/p/${note.id}`);
  const mark = page.locator('.selection-annotation').first();
  await mark.waitFor();
  await page.getByText('離線筆記已同步完成', { exact: true }).waitFor();
  await assertHighlight(page, true);
  await mark.click();
  await page.getByRole('button', { name: '標示為已解決', exact: true }).click();
  await page.getByText('已解決', { exact: true }).waitFor();
  await page.getByRole('button', { name: '關閉留言', exact: true }).click();
  const saved = await (await context.request.get(origin + path)).json();
  assert.equal(saved.annotations[0].resolved, true, '線上討論應已解決');
  await assertHighlight(page, false);
  await page.reload(); await mark.waitFor(); await assertHighlight(page, false);
  await context.setOffline(true); await page.reload(); await mark.waitFor(); await assertHighlight(page, false);
  await context.setOffline(false); await page.reload(); await mark.waitFor();
  await page.getByRole('button', { name: /^留言與反應/ }).click();
  await page.getByRole('button', { name: '包含已解決／已取消' }).click();
  await page.locator('.annotation-list-item').first().click();
  await page.getByRole('button', { name: '重新開啟討論', exact: true }).click();
  await page.getByRole('button', { name: '標示為已解決', exact: true }).waitFor();
  await page.getByRole('button', { name: '關閉留言', exact: true }).click();
  await assertHighlight(page, true);
  console.log('PASS 解決後取消黃色、連線與離線重載保持取消、重新開啟討論恢復標記');

  const reacted = await context.request.post(origin + path, { headers, data: { quote: '要取消的文字', blockIds: ['b'], emoji: '👍' } });
  const reaction = (await reacted.json()).annotation;
  const remote = (await (await context.request.get(origin + `/api/pages/${note.id}`)).json()).page;
  const overlapping = [{ ...content[0], content: [{ ...content[0].content[0], styles: { bold: true, annotation: `${annotation.id} ${reaction.id}` } }] }];
  assert.equal((await context.request.put(origin + `/api/pages/${note.id}/content`, { headers: { ...headers, 'if-match': `"${remote.version}"` }, data: { content: overlapping } })).status(), 200);
  await page.reload(); await mark.waitFor(); await assertHighlight(page, true);
  await mark.click();
  await page.getByText('測試留言', { exact: true }).waitFor();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '刪除整則討論', exact: true }).click();
  assert.ok((await (await context.request.get(origin + path)).json()).annotations.some(item => item.id === annotation.id));
  page.once('dialog', dialog => dialog.accept());
  await Promise.all([
    // Every change to a discussion is one repeatable operation sent to the offline queue endpoint.
    page.waitForResponse(response => response.url() === origin + '/api/offline/ops' && response.request().postDataJSON()?.op?.type === 'annotation.delete' && response.status() === 200),
    page.getByRole('button', { name: '刪除整則討論', exact: true }).click(),
  ]);
  await page.waitForFunction(async ({ noteId, removedId }) => {
    const response = await fetch(`/api/pages/${noteId}`), body = await response.json();
    return !JSON.stringify(body.page.content).includes(removedId);
  }, { noteId: note.id, removedId: annotation.id });
  await page.getByRole('button', { name: '關閉留言', exact: true }).click();
  await assertHighlight(page, true);
  const preserved = (await (await context.request.get(origin + `/api/pages/${note.id}`)).json()).page;
  assert.match(JSON.stringify(preserved.content), /要取消的文字/);
  assert.match(JSON.stringify(preserved.content), /"bold":true/);
  assert.ok(JSON.stringify(preserved.content).includes(reaction.id));
  console.log('PASS 可取消刪除確認、可刪除整則討論、保留文字／粗體及重疊的另一個討論');

  await mark.click();
  await page.getByRole('button', { name: '移除反應 👍', exact: true }).click();
  await page.getByText('已取消', { exact: true }).waitFor();
  await page.getByRole('button', { name: '關閉留言', exact: true }).click();
  await assertHighlight(page, false);
  await page.reload(); await mark.waitFor(); await assertHighlight(page, false);
  await context.setOffline(true); await page.reload(); await mark.waitFor(); await assertHighlight(page, false);
  assert.deepEqual(errors, []);
  console.log('PASS 移除最後反應後取消黃色、連線與離線重載不復發、無前端錯誤');
  await context.close();
} finally { await browser.close(); }
