import { describe, expect, it } from 'vitest';
import type { Annotation } from '../../src/shared/annotations.ts';
import { applyAnnotationOp, summarizePage } from '../../src/shared/offline.ts';
import type { OfflineOp } from '../../src/shared/offline.ts';
import { publicContent, scopeCovers, UNREACHABLE_PAGE } from '../../src/shared/shares.ts';
import type { PageResponse } from '../../src/shared/api.ts';

const run = (text: string, styles: Record<string, unknown> = {}) => ({ type: 'text', text, styles });

describe('how far a share reaches', () => {
  it('follows the scope down the tree, and a database always brings its rows', () => {
    expect(scopeCovers('page', [])).toBe(true);
    expect(scopeCovers('page', ['row'])).toBe(true);
    expect(scopeCovers('page', ['page'])).toBe(false);
    expect(scopeCovers('page', ['row', 'page'])).toBe(false);
    expect(scopeCovers('subpages', ['page', 'page'])).toBe(true);
    expect(scopeCovers('subpages', ['row', 'page'])).toBe(true);
    expect(scopeCovers('subpages', ['page', 'database'])).toBe(false);
    expect(scopeCovers('subpages', ['database', 'row'])).toBe(false);
    expect(scopeCovers('all', ['page', 'database', 'row', 'page'])).toBe(true);
  });
});

describe('what a public link gives out', () => {
  it('strips discussion marks, hides links that leave the share and points files at the link', () => {
    const content = [{ id: 'p', type: 'paragraph', props: {}, children: [{ id: 'c', type: 'image', props: { url: '/api/files/f1/a.png', caption: '/api/files/不是網址' }, children: [] }], content: [
      run('文字', { annotation: 'd1', italic: true }), { type: 'pageLink', props: { pageId: 'in', title: '範圍內' } }, { type: 'pageLink', props: { pageId: 'out', title: '私人頁面' } },
      { type: 'link', href: '/api/files/f2/b.pdf', content: [run('下載', { annotation: 'd2' })] }, run('/api/files/這是內文')] }];
    const shown = publicContent(content, 'TOKEN', new Set(['in']));
    expect(shown).toEqual([{ id: 'p', type: 'paragraph', props: {}, children: [{ id: 'c', type: 'image', props: { url: '/api/public/TOKEN/files/f1/a.png', caption: '/api/files/不是網址' }, children: [] }], content: [
      run('文字', { italic: true }), { type: 'pageLink', props: { pageId: 'in', title: '範圍內' } }, run(UNREACHABLE_PAGE),
      { type: 'link', href: '/api/public/TOKEN/files/f2/b.pdf', content: [run('下載')] }, run('/api/files/這是內文')] }]);
    expect(JSON.stringify(shown)).not.toMatch(/out|私人頁面|d1|d2/);
    // The stored content is not touched.
    expect(JSON.stringify(content)).toContain('私人頁面');
  });

  it('keeps the text of an ordinary link to a page outside the share, without its address', () => {
    const inside = '11111111-1111-4111-8111-111111111111', outsideId = '22222222-2222-4222-8222-222222222222';
    const content = [{ id: 'p', type: 'paragraph', props: {}, children: [], content: [
      { type: 'link', href: `/p/${inside}`, content: [run('範圍內')] }, { type: 'link', href: `/p/${outsideId}?view=x`, content: [run('私人', { bold: true }), run('連結')] },
      { type: 'link', href: 'https://example.test/p/x', content: [run('外部')] }] },
      { id: 't', type: 'table', props: {}, children: [], content: { type: 'tableContent', rows: [{ cells: [{ type: 'tableCell', props: {}, content: [{ type: 'pageLink', props: { pageId: outsideId, title: '表格裡的私人頁面' } }, { type: 'link', href: `/p/${outsideId}`, content: [run('格內')] }] }] }] } }];
    const shown = publicContent(content, 'TOKEN', new Set([inside]));
    expect((shown[0] as { content: unknown[] }).content).toEqual([
      { type: 'link', href: `/s/TOKEN/${inside}`, content: [run('範圍內')] }, run('私人', { bold: true }), run('連結'), { type: 'link', href: 'https://example.test/p/x', content: [run('外部')] }]);
    expect(JSON.stringify(shown)).not.toMatch(new RegExp(`${outsideId}|表格裡的私人頁面`));
    expect(JSON.stringify(shown)).toContain('格內');
  });
});

describe('discussions as each reader sees them', () => {
  const pageId = crypto.randomUUID(), annotationId = crypto.randomUUID();
  const me = { id: 'me', name: '我' };
  it('puts my name on what I write and switches only my own reaction', () => {
    const theirs: Annotation = { id: annotationId, quote: '文字', blockIds: ['b'], messages: [{ id: 'm1', text: '對方', createdAt: 1, author: { id: 'them', name: '對方' } }],
      reactions: ['👍'], resolved: false, version: 3, createdAt: 1, updatedAt: 1, author: { id: 'them', name: '對方' }, mine: [], counts: { '👍': 1 }, canDelete: false };
    const apply = (items: Annotation[], op: OfflineOp) => 'pageId' in op ? applyAnnotationOp(items, op, me) : items;
    let [item] = apply([theirs], { type: 'annotation.reaction', pageId, annotationId, emoji: '👍', on: true });
    expect(item).toMatchObject({ reactions: ['👍'], mine: ['👍'], counts: { '👍': 2 } });
    [item] = apply([item!], { type: 'annotation.reaction', pageId, annotationId, emoji: '👍', on: false });
    expect(item).toMatchObject({ reactions: ['👍'], mine: [], counts: { '👍': 1 }, canDelete: false });
    // Taking away a reaction I never gave changes nothing.
    expect(apply([item!], { type: 'annotation.reaction', pageId, annotationId, emoji: '👍', on: false })[0]).toBe(item);
    [item] = apply([item!], { type: 'annotation.comment', pageId, annotationId, messageId: crypto.randomUUID(), text: '我的回覆', at: 5 });
    expect(item!.messages.map(message => message.author?.name)).toEqual(['對方', '我']);
    const created = apply([], { type: 'annotation.create', pageId, annotationId: crypto.randomUUID(), messageId: crypto.randomUUID(), quote: '新', blockIds: ['b'], emoji: '🎉', at: 9 });
    expect(created[0]).toMatchObject({ author: me, mine: ['🎉'], counts: { '🎉': 1 }, canDelete: true });
  });

  it('treats a copy stored before sharing existed as the reader\'s own', () => {
    const old: Annotation = { id: annotationId, quote: '文字', blockIds: ['b'], messages: [], reactions: ['👍', '🎉'], resolved: false, version: 1, createdAt: 1, updatedAt: 1 };
    const [off] = applyAnnotationOp([old], { type: 'annotation.reaction', pageId, annotationId, emoji: '👍', on: false }, me);
    expect(off).toMatchObject({ reactions: ['🎉'], mine: ['🎉'], counts: { '🎉': 1 } });
    expect(applyAnnotationOp([old], { type: 'annotation.reaction', pageId, annotationId, emoji: '👍', on: true }, me)[0]).toBe(old);
  });
});

describe('what a device compares to notice changes', () => {
  it('includes the reader\'s role for a shared page and nothing new for an own page', () => {
    const page: PageResponse = { page: { id: 'p', parentId: null, kind: 'page', databaseId: null, title: '頁', icon: null, coverUrl: null, coverPosition: 50, fullWidth: false, content: [{ id: 'b' }], version: 1, isFavorite: false, trashedAt: null, createdAt: 1, updatedAt: 1 }, breadcrumbs: [] };
    expect(Object.keys(summarizePage(page))).toEqual(['page', 'breadcrumbs']);
    const shared = summarizePage({ ...page, access: { role: 'viewer', rootId: 'p', owner: { id: 'o', name: '擁有者' } } });
    expect(shared).toMatchObject({ access: { role: 'viewer' } });
    expect('content' in shared.page).toBe(false);
  });
});
