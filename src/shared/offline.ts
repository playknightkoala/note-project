import { z } from 'zod';
import { pageIdSchema } from './api.ts';
import type { PageResponse, PageNode } from './api.ts';
import { cellValueSchema, isEmptyValue, propertyInputSchema, pruneViewConfig, viewInputSchema } from './database.ts';
import type { DatabaseDto, DatabaseProperty, DatabaseRow } from './database.ts';
import { reactionSchema } from './annotations.ts';
import { myReactions } from './annotations.ts';
import type { Annotation, AnnotationAuthor } from './annotations.ts';
import type { IncomingShareDto } from './shares.ts';

/** Content versions plus all metadata (including ancestor names) used by an offline copy. */
export function summarizePage(response: PageResponse) {
  const { content: _content, ...page } = response.page;
  // The reader's role is part of what a device keeps; the key is left out for the reader's own pages.
  return { page, breadcrumbs: response.breadcrumbs, ...(response.access ? { access: response.access } : {}) };
}
export interface OfflineManifest {
  userId: string;
  tree: PageNode[];
  pages: ReturnType<typeof summarizePage>[];
  maxUploadBytes: number;
  databases: DatabaseStamp[];
  annotations: AnnotationStamp[];
  /** What other accounts share with this one. Their pages, databases and discussions are listed above with the user's own. */
  shared?: IncomingShareDto[];
}

/** A durable operation id makes retries safe even if the first response was lost. */
export const syncNoteSchema = z.object({
  operationId: z.string().uuid(),
  baseVersion: z.number().int().min(0).nullable(),
  baseTitle: z.string().max(500),
  title: z.string().max(500),
  parentId: pageIdSchema.nullable(),
  content: z.array(z.unknown()).max(20_000),
  overwrite: z.boolean().default(false),
  /**
   * Sent by an interface that reads `applied` in the answer (below). One that does not would take the answer to a
   * repeat as its new baseline, so it is refused instead when the page has moved on since its operation.
   */
  repeatAware: z.boolean().default(false),
});
export type SyncNoteInput = z.infer<typeof syncNoteSchema>;
/**
 * The answer to a synced note: the page as it is now, and `applied`, the version and title that this very operation
 * left behind. They differ when the answer is to a repeat and somebody else has saved since: the device must then
 * treat what it wrote in the meantime as a conflict, never as a draft based on the page it is shown here.
 */
export interface SyncNoteResult extends PageResponse { applied: { version: number; title: string } }
/** Whether the page has moved on since the operation this answers. A row's name is not part of its synced text. */
export const movedSince = (result: PageResponse & { applied?: SyncNoteResult['applied'] }): boolean => !!result.applied
  && (result.applied.version !== result.page.version || (result.page.kind === 'page' && result.applied.title !== result.page.title));

// ---- M9: databases, discussions and attachments ----

/** Changes when anything a device keeps of a database (structure, views, rows, row pages) changed. */
export interface DatabaseStamp { id: string; stamp: string }
/** Changes when any discussion on a page changed. Pages without discussions are not listed. */
export interface AnnotationStamp { pageId: string; stamp: string }
export interface DatabaseSnapshot { meta: DatabaseDto; rows: DatabaseRow[] }
/** Everything a device needs to show a database offline; row page content is fetched separately, only when changed. */
export interface DatabaseSnapshotDto extends DatabaseSnapshot { stamp: string; /** The database page itself. */ page: PageResponse; /** Its row pages, without content. */ pages: ReturnType<typeof summarizePage>[] }
export const pageBatchSchema = z.object({ ids: z.string().max(4000).transform(value => value.split(',').filter(Boolean)).pipe(z.array(pageIdSchema).min(1).max(100)) });

const id = z.string().uuid();
const cellChangeSchema = z.object({ base: cellValueSchema, value: cellValueSchema });
const cells = <T extends z.ZodTypeAny>(value: T) => z.record(id, value).refine(values => Object.keys(values).length <= 50, '一次最多更新 50 個欄位。').default({});
const schemaOp = { databaseId: id, baseVersion: z.number().int().min(0) };
const note = z.string().trim().min(1).max(4000);
const at = z.number().int().min(0);

/**
 * One user action that may be carried out later. Row changes carry the value each cell had when it was edited, so
 * only a cell changed on both sides is a conflict; structure changes carry the structure version they were made on.
 * Ids of new things are chosen by the client, so a repeated operation never creates a second copy.
 */
export const offlineOpSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('row.create'), databaseId: id, rowId: id, title: z.string().max(500).default(''), values: cells(cellValueSchema) }),
  z.object({ type: z.literal('row.update'), databaseId: id, rowId: id, title: z.object({ base: z.string().max(500), value: z.string().max(500) }).optional(), values: cells(cellChangeSchema) }),
  z.object({ type: z.literal('property.add'), ...schemaOp, propertyId: id, input: propertyInputSchema }),
  z.object({ type: z.literal('property.update'), ...schemaOp, propertyId: id, input: propertyInputSchema }),
  z.object({ type: z.literal('property.delete'), ...schemaOp, propertyId: id }),
  z.object({ type: z.literal('view.add'), ...schemaOp, viewId: id, input: viewInputSchema }),
  z.object({ type: z.literal('view.update'), ...schemaOp, viewId: id, input: viewInputSchema }),
  z.object({ type: z.literal('view.delete'), ...schemaOp, viewId: id }),
  z.object({ type: z.literal('annotation.create'), pageId: id, annotationId: id, messageId: id, quote: z.string().trim().min(1).max(8000), blockIds: z.array(z.string().min(1).max(64)).min(1).max(100), text: note.optional(), emoji: reactionSchema.optional(), at,
    /** Set by a reader who may not write the page: the discussion is shown by its quote, without a mark in the text. */
    floating: z.boolean().optional() })
    .refine(input => input.text !== undefined || input.emoji !== undefined, '請輸入留言或選擇表情符號。'),
  z.object({ type: z.literal('annotation.comment'), pageId: id, annotationId: id, messageId: id, text: note, at }),
  z.object({ type: z.literal('annotation.reaction'), pageId: id, annotationId: id, emoji: reactionSchema, on: z.boolean() }),
  z.object({ type: z.literal('annotation.resolve'), pageId: id, annotationId: id, resolved: z.boolean() }),
  // Deleting takes the comments with it, so it says how many the user had seen; a newer reply is a conflict.
  z.object({ type: z.literal('annotation.delete'), pageId: id, annotationId: id, messages: z.number().int().min(0).max(100) }),
]);
export type OfflineOp = z.infer<typeof offlineOpSchema>;
export type DatabaseOp = Extract<OfflineOp, { databaseId: string }>;
export type AnnotationOp = Extract<OfflineOp, { pageId: string }>;
/** `force` is the user's explicit "apply mine anyway" after a conflict was shown; nothing sets it automatically. */
export const offlineOpRequestSchema = z.object({ operationId: id, force: z.boolean().default(false), op: offlineOpSchema });
/** The state of whatever the operation touched, after it. Empty when that thing no longer exists. */
export interface OfflineOpResult { row?: DatabaseRow; database?: DatabaseDto; annotation?: Annotation; deletedId?: string }

export const isDatabaseOp = (op: OfflineOp): op is DatabaseOp => 'databaseId' in op;
export const isSchemaOp = (op: OfflineOp): op is Extract<OfflineOp, { baseVersion: number }> => 'baseVersion' in op;
/** Operations in one scope are carried out strictly in order; a failed one holds back only its own scope. */
export const opScope = (op: OfflineOp): string => isDatabaseOp(op) ? `db:${op.databaseId}` : `ann:${op.pageId}`;

/** What the user did, for the list of changes waiting on this device. */
export function describeOp(op: OfflineOp): string {
  switch (op.type) {
    case 'row.create': return `新增資料列「${op.title || '無標題'}」`;
    case 'row.update': return `修改資料列${op.title ? `名稱為「${op.title.value || '無標題'}」` : ''}${Object.keys(op.values).length ? `${op.title ? '與' : ''} ${Object.keys(op.values).length} 個欄位` : ''}`;
    case 'property.add': return `新增欄位「${op.input.name}」`;
    case 'property.update': return `修改欄位「${op.input.name}」`;
    case 'property.delete': return '刪除欄位';
    case 'view.add': return `新增視圖「${op.input.name}」`;
    case 'view.update': return `修改視圖「${op.input.name}」`;
    case 'view.delete': return '刪除視圖';
    case 'annotation.create': return `新增討論「${op.quote.slice(0, 30)}」`;
    case 'annotation.comment': return `留言「${op.text.slice(0, 30)}」`;
    case 'annotation.reaction': return `${op.on ? '加上' : '取消'}表情 ${op.emoji}`;
    case 'annotation.resolve': return op.resolved ? '標示討論為已解決' : '重新開啟討論';
    case 'annotation.delete': return '刪除整則討論';
  }
}

/**
 * The database as it will look once `op` is carried out. Used to show waiting changes on top of the last downloaded
 * copy, so it never throws: a change that no longer fits (its row or column is gone) is simply not shown.
 * Applying the same operation twice gives the same result.
 */
export function applyDatabaseOp(snapshot: DatabaseSnapshot, op: DatabaseOp, now: number): DatabaseSnapshot {
  const { meta, rows } = snapshot;
  const known = (propertyId: string) => meta.properties.some(property => property.id === propertyId);
  const prune = (propertyId: string, options: Parameters<typeof pruneViewConfig>[2]) => meta.views.map(view => ({ ...view, config: pruneViewConfig(view.config, propertyId, options) }));
  switch (op.type) {
    case 'row.create': {
      if (rows.some(row => row.id === op.rowId)) return snapshot;
      const values = Object.fromEntries(Object.entries(op.values).filter(([propertyId, value]) => known(propertyId) && !isEmptyValue(value)));
      return { meta, rows: [...rows, { id: op.rowId, databaseId: op.databaseId, title: op.title, icon: null, version: 1, values, updatedAt: now }] };
    }
    case 'row.update': return { meta, rows: rows.map(row => {
      if (row.id !== op.rowId) return row;
      const values = { ...row.values };
      for (const [propertyId, change] of Object.entries(op.values)) {
        if (!known(propertyId)) continue;
        if (isEmptyValue(change.value)) delete values[propertyId]; else values[propertyId] = change.value;
      }
      return { ...row, title: op.title ? op.title.value : row.title, values, updatedAt: now };
    }) };
    case 'property.add':
      if (known(op.propertyId) || meta.properties.length >= 50) return snapshot;
      return { rows, meta: { ...meta, properties: [...meta.properties, { id: op.propertyId, position: (meta.properties.at(-1)?.position ?? 0) + 1024, ...op.input }] } };
    case 'property.update': {
      const current = meta.properties.find(property => property.id === op.propertyId);
      if (!current) return snapshot;
      const next: DatabaseProperty = { ...current, ...op.input };
      const views = next.type !== current.type ? prune(current.id, { remove: false, clearGrouping: next.type !== 'select' })
        : JSON.stringify(next.choices) !== JSON.stringify(current.choices) ? prune(current.id, { remove: false, clearGrouping: false, validChoices: new Set(next.choices.map(choice => choice.id)) }) : meta.views;
      return { rows, meta: { ...meta, views, properties: meta.properties.map(property => property.id === current.id ? next : property) } };
    }
    case 'property.delete':
      if (!known(op.propertyId)) return snapshot;
      return {
        meta: { ...meta, properties: meta.properties.filter(property => property.id !== op.propertyId), views: prune(op.propertyId, { remove: true, clearGrouping: true }) },
        rows: rows.map(row => { if (!(op.propertyId in row.values)) return row; const values = { ...row.values }; delete values[op.propertyId]; return { ...row, values }; }),
      };
    case 'view.add':
      if (meta.views.some(view => view.id === op.viewId) || meta.views.length >= 20) return snapshot;
      return { rows, meta: { ...meta, views: [...meta.views, { id: op.viewId, name: op.input.name, type: op.input.type ?? 'table', config: op.input.config }] } };
    case 'view.update':
      return { rows, meta: { ...meta, views: meta.views.map(view => view.id === op.viewId ? { id: view.id, name: op.input.name, type: op.input.type ?? view.type, config: op.input.config } : view) } };
    case 'view.delete':
      if (meta.views.length <= 1) return snapshot;
      return { rows, meta: { ...meta, views: meta.views.filter(view => view.id !== op.viewId) } };
  }
}

/**
 * The discussions of a page as they will look once `op` is carried out; same rules as `applyDatabaseOp`.
 * `actor` is the person this device belongs to: their name on what they write, and whose reaction is switched.
 */
export function applyAnnotationOp(items: Annotation[], op: AnnotationOp, actor?: AnnotationAuthor): Annotation[] {
  const change = (update: (item: Annotation) => Annotation) => items.map(item => item.id === op.annotationId ? update(item) : item);
  const author = actor ? { author: actor } : {};
  switch (op.type) {
    case 'annotation.create':
      if (items.some(item => item.id === op.annotationId)) return items;
      return [...items, { id: op.annotationId, quote: op.quote, blockIds: op.blockIds, messages: op.text ? [{ id: op.messageId, text: op.text, createdAt: op.at, ...author }] : [],
        reactions: op.emoji ? [op.emoji] : [], resolved: false, version: 1, createdAt: op.at, updatedAt: op.at,
        ...author, mine: op.emoji ? [op.emoji] : [], counts: op.emoji ? { [op.emoji]: 1 } : {}, canDelete: true, ...(op.floating ? { floating: true } : {}) }];
    case 'annotation.comment':
      return change(item => item.messages.some(message => message.id === op.messageId) ? item : { ...item, messages: [...item.messages, { id: op.messageId, text: op.text, createdAt: op.at, ...author }], updatedAt: op.at });
    case 'annotation.reaction':
      return change(item => {
        const mine = myReactions(item);
        if (mine.includes(op.emoji) === op.on) return item;
        const counts = { ...(item.counts ?? Object.fromEntries(item.reactions.map(emoji => [emoji, 1]))) };
        const left = (counts[op.emoji] ?? 0) + (op.on ? 1 : -1);
        if (left > 0) counts[op.emoji] = left; else delete counts[op.emoji];
        return { ...item, counts, mine: op.on ? [...mine, op.emoji] : mine.filter(emoji => emoji !== op.emoji),
          reactions: left > 0 ? (item.reactions.includes(op.emoji) ? item.reactions : [...item.reactions, op.emoji]) : item.reactions.filter(emoji => emoji !== op.emoji) };
      });
    case 'annotation.resolve': return change(item => ({ ...item, resolved: op.resolved }));
    case 'annotation.delete': return items.filter(item => item.id !== op.annotationId);
  }
}
