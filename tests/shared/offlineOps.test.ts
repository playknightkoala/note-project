import { describe, expect, it } from 'vitest';
import type { Annotation } from '../../src/shared/annotations.ts';
import type { DatabaseProperty } from '../../src/shared/database.ts';
import { applyAnnotationOp, applyDatabaseOp, describeOp, offlineOpRequestSchema, opScope } from '../../src/shared/offline.ts';
import type { DatabaseOp, DatabaseSnapshot, OfflineOp } from '../../src/shared/offline.ts';
import { fileHeaders, sanitizeName, sniffMime } from '../../src/shared/files.ts';

const uuid = () => crypto.randomUUID();
const databaseId = uuid(), statusId = uuid(), textId = uuid(), doneId = uuid(), rowId = uuid(), viewId = uuid();
const status: DatabaseProperty = { id: statusId, name: '狀態', type: 'select', position: 1024, choices: [{ id: doneId, label: '完成', color: 'green' }] };
const text: DatabaseProperty = { id: textId, name: '摘要', type: 'text', position: 2048, choices: [] };
const snapshot = (): DatabaseSnapshot => ({
  meta: { id: databaseId, version: 3, properties: [status, text], views: [{ id: viewId, name: '看板', type: 'board', config: { groupBy: statusId, sorts: [{ propertyId: statusId, direction: 'asc' }], filters: [{ propertyId: statusId, operator: 'equals', value: doneId }, { propertyId: textId, operator: 'is_not_empty', value: null }], columns: [statusId, textId] } }] },
  rows: [{ id: rowId, databaseId, title: '列', icon: null, version: 2, values: { [statusId]: doneId, [textId]: '原文' }, updatedAt: 1 }],
});
const apply = (ops: DatabaseOp[], start = snapshot()) => ops.reduce((view, op) => applyDatabaseOp(view, op, 9), start);

describe('the local view of a database', () => {
  it('shows new and changed rows, and is unchanged by applying an operation twice', () => {
    const newRow = uuid();
    const ops: DatabaseOp[] = [
      { type: 'row.create', databaseId, rowId: newRow, title: '離線新增', values: { [textId]: '新', [statusId]: null, [uuid()]: '未知欄位' } },
      { type: 'row.update', databaseId, rowId, title: { base: '列', value: '改名' }, values: { [textId]: { base: '原文', value: '' }, [statusId]: { base: doneId, value: doneId } } },
    ];
    const once = apply(ops);
    expect(once.rows).toEqual([
      { id: rowId, databaseId, title: '改名', icon: null, version: 2, values: { [statusId]: doneId }, updatedAt: 9 },
      { id: newRow, databaseId, title: '離線新增', icon: null, version: 1, values: { [textId]: '新' }, updatedAt: 9 },
    ]);
    expect(apply(ops, once)).toEqual(once);
    // The downloaded copy itself is never modified.
    expect(snapshot().rows[0]!.title).toBe('列');
  });

  it('follows the server when a column changes type, loses a choice or is deleted', () => {
    const retyped = apply([{ type: 'property.update', databaseId, baseVersion: 3, propertyId: statusId, input: { name: '狀態', type: 'text', choices: [] } }]);
    expect(retyped.meta.views[0]!.config).toEqual({ sorts: [], filters: [{ propertyId: textId, operator: 'is_not_empty', value: null }], columns: [statusId, textId] });
    const withoutChoice = apply([{ type: 'property.update', databaseId, baseVersion: 3, propertyId: statusId, input: { name: '進度', type: 'select', choices: [] } }]);
    expect(withoutChoice.meta.views[0]!.config).toMatchObject({ groupBy: statusId, sorts: [{ propertyId: statusId }], filters: [{ propertyId: textId }] });
    expect(withoutChoice.meta.properties[0]!.name).toBe('進度');
    const deleted = apply([{ type: 'property.delete', databaseId, baseVersion: 3, propertyId: statusId }]);
    expect(deleted.meta.properties).toEqual([text]);
    expect(deleted.meta.views[0]!.config).toEqual({ sorts: [], filters: [{ propertyId: textId, operator: 'is_not_empty', value: null }], columns: [textId] });
    expect(deleted.rows[0]!.values).toEqual({ [textId]: '原文' });
    // A change to something that is gone is simply not shown.
    expect(apply([{ type: 'row.update', databaseId, rowId, values: { [statusId]: { base: doneId, value: null } } }], deleted).rows[0]!.values).toEqual({ [textId]: '原文' });
  });

  it('adds, changes and removes views and columns, keeping the last view', () => {
    const added = uuid(), column = uuid();
    const view = apply([
      { type: 'property.add', databaseId, baseVersion: 3, propertyId: column, input: { name: '數量', type: 'number', choices: [] } },
      { type: 'view.add', databaseId, baseVersion: 3, viewId: added, input: { name: '清單', type: 'list', config: { sorts: [], filters: [] } } },
      { type: 'view.update', databaseId, baseVersion: 3, viewId: added, input: { name: '改名清單', config: { sorts: [], filters: [], columns: [column] } } },
      { type: 'view.delete', databaseId, baseVersion: 3, viewId },
      { type: 'view.delete', databaseId, baseVersion: 3, viewId: added },
    ]);
    expect(view.meta.properties.at(-1)).toEqual({ id: column, position: 3072, name: '數量', type: 'number', choices: [] });
    expect(view.meta.views).toEqual([{ id: added, name: '改名清單', type: 'list', config: { sorts: [], filters: [], columns: [column] } }]);
    expect(view.meta.version).toBe(3);
  });
});

describe('the local view of discussions', () => {
  const pageId = uuid(), annotationId = uuid(), first = uuid(), second = uuid();
  it('appends comments once, sets reactions and flags, and forgets a deleted discussion', () => {
    const ops: OfflineOp[] = [
      { type: 'annotation.create', pageId, annotationId, messageId: first, quote: '文字', blockIds: ['b'], text: '第一則', at: 5 },
      { type: 'annotation.comment', pageId, annotationId, messageId: second, text: '第二則', at: 6 },
      { type: 'annotation.reaction', pageId, annotationId, emoji: '👍', on: true },
      { type: 'annotation.reaction', pageId, annotationId, emoji: '🎉', on: true },
      { type: 'annotation.reaction', pageId, annotationId, emoji: '👍', on: false },
      { type: 'annotation.resolve', pageId, annotationId, resolved: true },
    ];
    const run = (items: Annotation[]) => ops.reduce((list, op) => 'pageId' in op ? applyAnnotationOp(list, op) : list, items);
    const once = run([]);
    expect(once).toEqual([{ id: annotationId, quote: '文字', blockIds: ['b'], messages: [{ id: first, text: '第一則', createdAt: 5 }, { id: second, text: '第二則', createdAt: 6 }], reactions: ['🎉'], resolved: true, version: 1, createdAt: 5, updatedAt: 6 }]);
    expect(run(once)).toEqual(once);
    expect(applyAnnotationOp(once, { type: 'annotation.delete', pageId, annotationId, messages: 2 })).toEqual([]);
    expect(applyAnnotationOp([], { type: 'annotation.comment', pageId, annotationId, messageId: second, text: '孤立', at: 1 })).toEqual([]);
  });

  it('groups operations by database or page, describes them, and validates what a device may send', () => {
    const comment: OfflineOp = { type: 'annotation.comment', pageId, annotationId, messageId: second, text: '留言內容', at: 6 };
    expect(opScope(comment)).toBe(`ann:${pageId}`);
    expect(opScope({ type: 'view.delete', databaseId, baseVersion: 1, viewId })).toBe(`db:${databaseId}`);
    expect(describeOp(comment)).toContain('留言內容');
    expect(describeOp({ type: 'row.update', databaseId, rowId, title: { base: 'a', value: 'b' }, values: { [textId]: { base: null, value: 'x' } } })).toMatch(/b.*1 個欄位/);
    const parse = (op: unknown) => offlineOpRequestSchema.safeParse({ operationId: uuid(), op }).success;
    expect(parse(comment)).toBe(true);
    expect(offlineOpRequestSchema.parse({ operationId: uuid(), op: comment }).force).toBe(false);
    expect(parse({ ...comment, text: '   ' })).toBe(false);
    expect(parse({ type: 'annotation.create', pageId, annotationId, messageId: first, quote: '文字', blockIds: ['b'], at: 1 })).toBe(false);
    expect(parse({ type: 'annotation.reaction', pageId, annotationId, emoji: '<script>', on: true })).toBe(false);
    expect(parse({ type: 'row.update', databaseId, rowId, values: { 'not-a-uuid': { base: null, value: 1 } } })).toBe(false);
    expect(parse({ type: 'property.add', databaseId, propertyId: uuid(), input: { name: 'x', type: 'text' } })).toBe(false);
  });
});

describe('file rules shared with a device that keeps an upload for later', () => {
  it('shows only real images inline and makes everything else a sandboxed download', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffMime(png, 'text/html')).toBe('image/png');
    expect(fileHeaders('image/png', '圖.png')).toMatchObject({ 'Content-Type': 'image/png', 'Content-Disposition': expect.stringMatching(/^inline/), 'X-Content-Type-Options': 'nosniff' });
    expect(fileHeaders('image/png', '圖.png')).not.toHaveProperty('Content-Security-Policy');
    const html = new TextEncoder().encode('<script>alert(1)</script>');
    expect(sniffMime(html, 'text/html')).toBe('application/octet-stream');
    expect(sniffMime(html, 'image/png')).toBe('application/octet-stream');
    expect(fileHeaders(sniffMime(html, 'image/svg+xml'), 'x.svg')).toMatchObject({ 'Content-Disposition': expect.stringMatching(/^attachment/), 'Content-Security-Policy': 'sandbox' });
    expect(sniffMime(new Uint8Array([0x52, 0x49]), 'text/plain')).toBe('text/plain');
    expect(sanitizeName('a/b:c', 'png')).toBe('abc.png');
  });
});
