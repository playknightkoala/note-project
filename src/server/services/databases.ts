import type { Db } from '../db/driver.ts';
import type { DatabaseDto, DatabaseProperty, DatabaseRow, PropertyInput, PropertyPatch, RowInput, CellValue, ViewConfig, ViewInput, RowsDto, ViewType } from '../../shared/database.ts';
import { evaluateRows, propertyInputSchema, pruneViewConfig, sameValue, validateView, valueSchema, viewConfigSchema } from '../../shared/database.ts';
import { emptyParagraph } from '../../shared/blocks.ts';
import { AppError } from '../../shared/errors.ts';
import { loadPage } from './pages.ts';
import type { PageRow } from './pages.ts';
import { parseValue } from '../routes/validate.ts';

interface DatabasePage extends PageRow { schema_version: number; attributes_version: number }
interface PropertyRow { id: string; name: string; type: DatabaseProperty['type']; options: string; position: number }
const MAX_ROWS = 5000;
function database(db: Db, userId: string, id: string): DatabasePage {
  const row = loadPage(db, userId, id) as DatabasePage;
  if (row.kind !== 'database') throw new AppError('not_found', '找不到資料庫。');
  return row;
}
/** `expected` is null only for a change the user explicitly chose to apply on top of whatever is there now. */
function assertVersion(actual: number, expected: number | null): void {
  if (expected !== null && actual !== expected) throw new AppError('version_conflict', '資料已在其他地方更新，請重新載入後再修改。', { current: { version: actual } });
}
function properties(db: Db, userId: string, id: string): DatabaseProperty[] {
  return db.all<PropertyRow>(`SELECT pr.* FROM db_properties pr JOIN pages p ON p.id = pr.database_id WHERE p.id = ? AND p.user_id = ? ORDER BY pr.position, pr.id`, id, userId)
    .map(row => ({ id: row.id, position: row.position, ...propertyInputSchema.parse({ name: row.name, type: row.type, ...JSON.parse(row.options) }) }));
}
export function getDatabase(db: Db, userId: string, id: string): DatabaseDto {
  const row = database(db, userId, id);
  const views = db.all<{ id: string; name: string; type: ViewType; config: string }>('SELECT v.* FROM db_views v JOIN pages p ON p.id = v.database_id WHERE p.id = ? AND p.user_id = ? ORDER BY v.position, v.id', id, userId);
  return { id, version: row.schema_version, properties: properties(db, userId, id), views: views.map(view => ({ id: view.id, name: view.name, type: view.type, config: viewConfigSchema.parse(JSON.parse(view.config)) })) };
}
function bumpSchema(db: Db, userId: string, id: string, now: number): DatabaseDto {
  db.run('UPDATE pages SET schema_version = schema_version + 1, updated_at = ? WHERE id = ? AND user_id = ?', now, id, userId);
  return getDatabase(db, userId, id);
}
function checkChoices(input: PropertyInput): void {
  if (!['select', 'multi_select'].includes(input.type) && input.choices.length) throw new AppError('bad_request', '只有單選與多選欄位能設定選項。');
  if (new Set(input.choices.map(choice => choice.label.toLowerCase())).size !== input.choices.length) throw new AppError('bad_request', '選項名稱不可重複。');
}
/** An id chosen by the client (`propertyId`, `viewId`, `rowId` below) makes the request repeatable: the second time nothing is added. */
function alreadyThere(db: Db, table: 'db_properties' | 'db_views', id: string | undefined, databaseId: string): boolean {
  if (!id) return false;
  const existing = db.get<{ database_id: string }>(`SELECT database_id FROM ${table} WHERE id = ?`, id);
  if (existing && existing.database_id !== databaseId) throw new AppError('conflict', '識別碼無法使用。');
  return !!existing;
}
export function addProperty(db: Db, userId: string, id: string, input: PropertyInput, version: number | null, now: number, propertyId?: string): DatabaseDto {
  return db.transaction(() => {
    const page = database(db, userId, id);
    if (alreadyThere(db, 'db_properties', propertyId, id)) return getDatabase(db, userId, id);
    assertVersion(page.schema_version, version);
    checkChoices(input);
    const current = properties(db, userId, id);
    if (current.length >= 50) throw new AppError('conflict', '每個資料庫最多 50 個屬性。');
    db.run('INSERT INTO db_properties (id, database_id, name, type, options, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      propertyId ?? crypto.randomUUID(), id, input.name, input.type, JSON.stringify({ choices: input.choices }), (current.at(-1)?.position ?? 0) + 1024, now);
    return bumpSchema(db, userId, id, now);
  });
}
function pruneViews(db: Db, userId: string, id: string, propertyId: string, options: { remove: boolean; clearGrouping: boolean; validChoices?: Set<string> }): void {
  for (const view of getDatabase(db, userId, id).views) {
    db.run('UPDATE db_views SET config = ? WHERE id = ? AND database_id = ? AND EXISTS (SELECT 1 FROM pages WHERE id = db_views.database_id AND user_id = ?)', JSON.stringify(pruneViewConfig(view.config, propertyId, options)), view.id, id, userId);
  }
}
export function updateProperty(db: Db, userId: string, id: string, propertyId: string, patch: PropertyPatch, version: number | null, now: number): DatabaseDto {
  return db.transaction(() => {
    assertVersion(database(db, userId, id).schema_version, version);
    const current = properties(db, userId, id).find(property => property.id === propertyId);
    if (!current) throw new AppError('not_found');
    const input = parseValue({ ...current, ...patch }, propertyInputSchema);
    checkChoices(input);
    const values = db.all<{ value_json: string }>(`SELECT v.value_json FROM row_values v JOIN pages p ON p.id = v.page_id WHERE v.property_id = ? AND p.database_id = ? AND p.user_id = ?`, propertyId, id, userId);
    if (input.type !== current.type && values.length) throw new AppError('conflict', '此欄位已有資料，請先清空後再變更型別。');
    const candidate: DatabaseProperty = { ...current, ...input };
    if (input.type === current.type && values.some(value => !valueSchema(candidate).safeParse(JSON.parse(value.value_json)).success)) throw new AppError('conflict', '選項仍有資料列使用，請先更新資料列後再移除。');
    if (input.type !== current.type) pruneViews(db, userId, id, propertyId, { remove: false, clearGrouping: input.type !== 'select' });
    else if (JSON.stringify(input.choices) !== JSON.stringify(current.choices)) pruneViews(db, userId, id, propertyId, { remove: false, clearGrouping: false, validChoices: new Set(input.choices.map(choice => choice.id)) });
    db.run('UPDATE db_properties SET name = ?, type = ?, options = ? WHERE id = ? AND database_id = ?', input.name, input.type, JSON.stringify({ choices: input.choices }), propertyId, id);
    return bumpSchema(db, userId, id, now);
  });
}
export function deleteProperty(db: Db, userId: string, id: string, propertyId: string, version: number | null, now: number): DatabaseDto {
  return db.transaction(() => {
    assertVersion(database(db, userId, id).schema_version, version);
    if (!properties(db, userId, id).some(p => p.id === propertyId)) throw new AppError('not_found');
    pruneViews(db, userId, id, propertyId, { remove: true, clearGrouping: true });
    db.run('DELETE FROM db_properties WHERE id = ? AND database_id = ?', propertyId, id);
    return bumpSchema(db, userId, id, now);
  });
}
export function addView(db: Db, userId: string, id: string, input: ViewInput, version: number | null, now: number, viewId?: string): DatabaseDto {
  return db.transaction(() => {
    const page = database(db, userId, id);
    if (alreadyThere(db, 'db_views', viewId, id)) return getDatabase(db, userId, id);
    assertVersion(page.schema_version, version);
    const meta = getDatabase(db, userId, id);
    if (meta.views.length >= 20) throw new AppError('conflict', '每個資料庫最多 20 個視圖。');
    const config = { ...input.config };
    const error = validateView(config, meta.properties);
    if (error) throw new AppError('bad_request', error);
    if (input.type === 'board' && !config.groupBy) {
      let group = meta.properties.find(property => property.type === 'select');
      if (!group) {
        if (meta.properties.length >= 50) throw new AppError('conflict', '請先建立或改用單選欄位作為看板分組。');
        group = { id: crypto.randomUUID(), name: '狀態', type: 'select', position: (meta.properties.at(-1)?.position ?? 0) + 1024, choices: [
          { id: crypto.randomUUID(), label: '尚未開始', color: 'gray' },
          { id: crypto.randomUUID(), label: '進行中', color: 'blue' },
          { id: crypto.randomUUID(), label: '已完成', color: 'green' },
        ] };
        db.run('INSERT INTO db_properties (id, database_id, name, type, options, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', group.id, id, group.name, group.type, JSON.stringify({ choices: group.choices }), group.position, now);
      }
      config.groupBy = group.id;
    }
    const last = db.get<{ position: number }>('SELECT MAX(v.position) AS position FROM db_views v JOIN pages p ON p.id = v.database_id WHERE p.id = ? AND p.user_id = ?', id, userId)?.position ?? 0;
    db.run('INSERT INTO db_views (id, database_id, name, type, config, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', viewId ?? crypto.randomUUID(), id, input.name, input.type ?? 'table', JSON.stringify(config), last + 1024, now);
    return bumpSchema(db, userId, id, now);
  });
}
export function deleteView(db: Db, userId: string, id: string, viewId: string, version: number | null, now: number): DatabaseDto {
  return db.transaction(() => {
    assertVersion(database(db, userId, id).schema_version, version);
    const views = getDatabase(db, userId, id).views;
    if (!views.some(view => view.id === viewId)) throw new AppError('not_found');
    if (views.length <= 1) throw new AppError('conflict', '至少需要保留一個視圖。');
    db.run('DELETE FROM db_views WHERE id = ? AND database_id = ? AND EXISTS (SELECT 1 FROM pages WHERE id = db_views.database_id AND user_id = ?)', viewId, id, userId);
    return bumpSchema(db, userId, id, now);
  });
}
export function updateView(db: Db, userId: string, id: string, viewId: string, input: ViewInput, version: number | null, now: number): DatabaseDto {
  return db.transaction(() => {
    assertVersion(database(db, userId, id).schema_version, version);
    const error = validateView(input.config, properties(db, userId, id));
    if (error) throw new AppError('bad_request', error);
    const current = getDatabase(db, userId, id).views.find(view => view.id === viewId);
    if (!current) throw new AppError('not_found');
    db.run('UPDATE db_views SET name = ?, type = ?, config = ? WHERE id = ? AND database_id = ? AND EXISTS (SELECT 1 FROM pages WHERE id = db_views.database_id AND user_id = ?)', input.name, input.type ?? current.type, JSON.stringify(input.config), viewId, id, userId);
    return bumpSchema(db, userId, id, now);
  });
}
function rowPage(db: Db, userId: string, id: string): DatabasePage {
  const row = loadPage(db, userId, id) as DatabasePage;
  if (row.kind !== 'row' || !row.database_id) throw new AppError('not_found', '找不到資料列。');
  database(db, userId, row.database_id);
  return row;
}
function rowDto(page: DatabasePage, values: Record<string, CellValue>): DatabaseRow {
  return { id: page.id, databaseId: page.database_id!, title: page.title, icon: page.icon, version: page.attributes_version, values, updatedAt: page.updated_at };
}
function readValues(db: Db, userId: string, databaseId: string): Map<string, Record<string, CellValue>> {
  const result = new Map<string, Record<string, CellValue>>();
  for (const row of db.all<{ page_id: string; property_id: string; value_json: string }>(`SELECT v.* FROM row_values v JOIN pages p ON p.id = v.page_id JOIN db_properties pr ON pr.id = v.property_id AND pr.database_id = p.database_id
    WHERE p.database_id = ? AND p.user_id = ? AND p.trashed_at IS NULL`, databaseId, userId)) {
    const values = result.get(row.page_id) ?? {};
    values[row.property_id] = JSON.parse(row.value_json) as CellValue;
    result.set(row.page_id, values);
  }
  return result;
}
export function getRow(db: Db, userId: string, id: string): DatabaseRow {
  const page = rowPage(db, userId, id);
  const values: Record<string, CellValue> = {};
  for (const row of db.all<{ property_id: string; value_json: string }>(`SELECT v.* FROM row_values v JOIN pages p ON p.id = v.page_id JOIN db_properties pr ON pr.id = v.property_id AND pr.database_id = p.database_id WHERE p.id = ? AND p.user_id = ?`, id, userId)) values[row.property_id] = JSON.parse(row.value_json) as CellValue;
  return rowDto(page, values);
}
function writeValues(db: Db, userId: string, page: DatabasePage, values: Record<string, CellValue>, now: number): void {
  const available = properties(db, userId, page.database_id!);
  for (const [id, raw] of Object.entries(values)) {
    const property = available.find(property => property.id === id);
    if (!property) throw new AppError('not_found', '找不到屬性。');
    const value = parseValue(raw, valueSchema(property));
    if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
      db.run('DELETE FROM row_values WHERE page_id = ? AND property_id = ?', page.id, id);
    } else {
      db.run(`INSERT INTO row_values (page_id,property_id,value_text,value_number,value_json,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(page_id,property_id) DO UPDATE SET value_text=excluded.value_text,value_number=excluded.value_number,value_json=excluded.value_json,updated_at=excluded.updated_at`,
      page.id, id, typeof value === 'string' ? value : null, typeof value === 'number' ? value : null, JSON.stringify(value), now);
    }
  }
}
/** `version` is the structure the client built the row for; null when the values are checked against the current structure only. */
export function addRow(db: Db, userId: string, id: string, input: RowInput, version: number | null, now: number, rowId: string = crypto.randomUUID()): DatabaseRow {
  return db.transaction(() => {
    const page = database(db, userId, id);
    const existing = db.get<{ user_id: string; database_id: string | null; kind: string }>('SELECT user_id, database_id, kind FROM pages WHERE id = ?', rowId);
    if (existing) {
      if (existing.user_id !== userId || existing.kind !== 'row' || existing.database_id !== id) throw new AppError('conflict', '識別碼無法使用。');
      return getRow(db, userId, rowId);
    }
    assertVersion(page.schema_version, version);
    const { n = 0, last = 0 } = db.get<{ n: number; last: number }>('SELECT COUNT(*) AS n, COALESCE(MAX(position),0) AS last FROM pages WHERE database_id = ? AND user_id = ?', id, userId) ?? {};
    if (n >= MAX_ROWS) throw new AppError('conflict', '每個資料庫最多 5,000 列（包含垃圾桶），請先永久刪除不需要的列。');
    db.run(`INSERT INTO pages (id,user_id,parent_id,database_id,kind,position,title,content,created_at,updated_at) VALUES (?,?,?,?,'row',?,?,?,?,?)`,
      rowId, userId, id, id, last + 1024, input.title ?? '', JSON.stringify([emptyParagraph()]), now, now);
    writeValues(db, userId, rowPage(db, userId, rowId), input.values, now);
    return getRow(db, userId, rowId);
  });
}
export function updateRow(db: Db, userId: string, id: string, input: RowInput, version: number, now: number): DatabaseRow {
  return db.transaction(() => {
    const page = rowPage(db, userId, id);
    assertVersion(page.attributes_version, version);
    writeValues(db, userId, page, input.values, now);
    db.run('UPDATE pages SET title = ?, attributes_version = attributes_version + 1, updated_at = ? WHERE id = ? AND user_id = ?', input.title ?? page.title, now, id, userId);
    return getRow(db, userId, id);
  });
}
export interface CellChange { base: CellValue; value: CellValue }
/**
 * A change made without knowing the row's latest version (typically offline). Each cell says what it held when it was
 * edited: a cell that still holds that value is updated, one that already holds the new value is left alone, anything
 * else is a conflict naming the cells. With `force` the user has seen the conflict and chose their own values.
 */
export function changeRow(db: Db, userId: string, id: string, change: { title?: { base: string; value: string } | undefined; values: Record<string, CellChange> }, force: boolean, now: number): DatabaseRow {
  return db.transaction(() => {
    const page = rowPage(db, userId, id);
    const current = getRow(db, userId, id);
    const names = new Map(properties(db, userId, page.database_id!).map(property => [property.id, property.name]));
    const conflicts: Record<string, CellValue> = {}, labels: string[] = [], values: Record<string, CellValue> = {};
    for (const [propertyId, cell] of Object.entries(change.values)) {
      if (!names.has(propertyId)) throw new AppError('not_found', '找不到屬性；欄位可能已在其他地方刪除。');
      const actual = current.values[propertyId] ?? null;
      if (sameValue(actual, cell.value)) continue;
      if (!force && !sameValue(actual, cell.base)) { conflicts[propertyId] = actual; labels.push(names.get(propertyId)!); continue; }
      values[propertyId] = cell.value;
    }
    let title = page.title;
    if (change.title && change.title.value !== page.title) {
      if (!force && change.title.base !== page.title) { conflicts.title = page.title; labels.unshift('名稱'); }
      else title = change.title.value;
    }
    if (labels.length) throw new AppError('version_conflict', `「${labels.join('」、「')}」已在其他地方更新。`, { current: conflicts });
    if (title === page.title && Object.keys(values).length === 0) return current;
    writeValues(db, userId, page, values, now);
    db.run('UPDATE pages SET title = ?, attributes_version = attributes_version + 1, updated_at = ? WHERE id = ? AND user_id = ?', title, now, id, userId);
    return getRow(db, userId, id);
  });
}
function allRows(db: Db, userId: string, id: string): DatabasePage[] {
  const pages = db.all<DatabasePage>("SELECT * FROM pages WHERE database_id = ? AND user_id = ? AND kind = 'row' AND trashed_at IS NULL ORDER BY position, id LIMIT 5001", id, userId);
  if (pages.length > MAX_ROWS) throw new AppError('conflict', '資料庫超過 5,000 列，請先整理資料。');
  return pages;
}
export function listRows(db: Db, userId: string, id: string, config: ViewConfig, offset: number, limit: number): RowsDto {
  database(db, userId, id);
  const props = properties(db, userId, id);
  const error = validateView(config, props);
  if (error) throw new AppError('bad_request', error);
  const values = readValues(db, userId, id);
  const rows = evaluateRows(allRows(db, userId, id).map(page => rowDto(page, values.get(page.id) ?? {})), props, config);
  return { rows: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
}

/** One entry per database; the stamp changes with its structure, its title and any row (values, title, content, count). */
export function databaseStamps(db: Db, userId: string, id?: string): { id: string; stamp: string }[] {
  return db.all<{ id: string; s: number; du: number; n: number; a: number; v: number; u: number }>(`SELECT d.id, d.schema_version AS s, d.updated_at AS du, COUNT(r.id) AS n,
      COALESCE(SUM(r.attributes_version), 0) AS a, COALESCE(SUM(r.version), 0) AS v, COALESCE(MAX(r.updated_at), 0) AS u
    FROM pages d LEFT JOIN pages r ON r.database_id = d.id AND r.user_id = d.user_id AND r.kind = 'row' AND r.trashed_at IS NULL
    WHERE d.user_id = ? AND d.kind = 'database' AND d.trashed_at IS NULL ${id ? 'AND d.id = ?' : ''} GROUP BY d.id`, ...(id ? [userId, id] : [userId]))
    .map(row => ({ id: row.id, stamp: [row.s, row.du, row.n, row.a, row.v, row.u].join('.') }));
}

/** The whole database in its stored order, for a device to keep: structure, every row, and the row pages without content. */
export function snapshot(db: Db, userId: string, id: string): { stamp: string; meta: DatabaseDto; rows: DatabaseRow[]; pages: PageRow[] } {
  return db.transaction(() => {
    const meta = getDatabase(db, userId, id);
    const values = readValues(db, userId, id);
    const pages = allRows(db, userId, id);
    return { stamp: databaseStamps(db, userId, id)[0]!.stamp, meta, rows: pages.map(page => rowDto(page, values.get(page.id) ?? {})), pages: pages.map(page => ({ ...page, content: '[]' })) };
  });
}
