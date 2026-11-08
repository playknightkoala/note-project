import type { Db } from '../db/driver.ts';
import type { DatabaseDto, DatabaseProperty, DatabaseRow, PropertyInput, PropertyPatch, RowInput, CellValue, ViewConfig, RowsDto } from '../../shared/database.ts';
import { evaluateRows, propertyInputSchema, validateView, valueSchema, viewConfigSchema } from '../../shared/database.ts';
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
function assertVersion(actual: number, expected: number): void {
  if (actual !== expected) throw new AppError('version_conflict', '資料已在其他地方更新，請重新載入後再修改。', { current: { version: actual } });
}
function properties(db: Db, userId: string, id: string): DatabaseProperty[] {
  return db.all<PropertyRow>(`SELECT pr.* FROM db_properties pr JOIN pages p ON p.id = pr.database_id WHERE p.id = ? AND p.user_id = ? ORDER BY pr.position, pr.id`, id, userId)
    .map(row => ({ id: row.id, position: row.position, ...propertyInputSchema.parse({ name: row.name, type: row.type, ...JSON.parse(row.options) }) }));
}
export function getDatabase(db: Db, userId: string, id: string): DatabaseDto {
  const row = database(db, userId, id);
  const views = db.all<{ id: string; name: string; config: string }>('SELECT v.* FROM db_views v JOIN pages p ON p.id = v.database_id WHERE p.id = ? AND p.user_id = ? ORDER BY v.position, v.id', id, userId);
  return { id, version: row.schema_version, properties: properties(db, userId, id), views: views.map(view => ({ id: view.id, name: view.name, config: viewConfigSchema.parse(JSON.parse(view.config)) })) };
}
function bumpSchema(db: Db, userId: string, id: string, now: number): DatabaseDto {
  db.run('UPDATE pages SET schema_version = schema_version + 1, updated_at = ? WHERE id = ? AND user_id = ?', now, id, userId);
  return getDatabase(db, userId, id);
}
function checkChoices(input: PropertyInput): void {
  if (!['select', 'multi_select'].includes(input.type) && input.choices.length) throw new AppError('bad_request', '只有單選與多選欄位能設定選項。');
  if (new Set(input.choices.map(choice => choice.label.toLowerCase())).size !== input.choices.length) throw new AppError('bad_request', '選項名稱不可重複。');
}
export function addProperty(db: Db, userId: string, id: string, input: PropertyInput, version: number, now: number): DatabaseDto {
  return db.transaction(() => {
    assertVersion(database(db, userId, id).schema_version, version);
    checkChoices(input);
    const current = properties(db, userId, id);
    if (current.length >= 50) throw new AppError('conflict', '每個資料庫最多 50 個屬性。');
    db.run('INSERT INTO db_properties (id, database_id, name, type, options, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      crypto.randomUUID(), id, input.name, input.type, JSON.stringify({ choices: input.choices }), (current.at(-1)?.position ?? 0) + 1024, now);
    return bumpSchema(db, userId, id, now);
  });
}
function pruneViews(db: Db, userId: string, id: string, propertyId: string, remove: boolean): void {
  const views = getDatabase(db, userId, id).views;
  for (const view of views) {
    const config = { ...view.config, sorts: view.config.sorts.filter(sort => sort.propertyId !== propertyId), filters: view.config.filters.filter(filter => filter.propertyId !== propertyId),
      ...(remove && view.config.columns ? { columns: view.config.columns.filter(col => col !== propertyId) } : {}) };
    db.run('UPDATE db_views SET config = ? WHERE id = ? AND database_id = ?', JSON.stringify(config), view.id, id);
  }
}
export function updateProperty(db: Db, userId: string, id: string, propertyId: string, patch: PropertyPatch, version: number, now: number): DatabaseDto {
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
    if (input.type !== current.type || JSON.stringify(input.choices) !== JSON.stringify(current.choices)) pruneViews(db, userId, id, propertyId, false);
    db.run('UPDATE db_properties SET name = ?, type = ?, options = ? WHERE id = ? AND database_id = ?', input.name, input.type, JSON.stringify({ choices: input.choices }), propertyId, id);
    return bumpSchema(db, userId, id, now);
  });
}
export function deleteProperty(db: Db, userId: string, id: string, propertyId: string, version: number, now: number): DatabaseDto {
  return db.transaction(() => {
    assertVersion(database(db, userId, id).schema_version, version);
    if (!properties(db, userId, id).some(p => p.id === propertyId)) throw new AppError('not_found');
    pruneViews(db, userId, id, propertyId, true);
    db.run('DELETE FROM db_properties WHERE id = ? AND database_id = ?', propertyId, id);
    return bumpSchema(db, userId, id, now);
  });
}
export function updateView(db: Db, userId: string, id: string, viewId: string, input: { name: string; config: ViewConfig }, version: number, now: number): DatabaseDto {
  return db.transaction(() => {
    assertVersion(database(db, userId, id).schema_version, version);
    const error = validateView(input.config, properties(db, userId, id));
    if (error) throw new AppError('bad_request', error);
    if (!db.run('UPDATE db_views SET name = ?, config = ? WHERE id = ? AND database_id = ?', input.name, JSON.stringify(input.config), viewId, id).changes) throw new AppError('not_found');
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
export function addRow(db: Db, userId: string, id: string, input: RowInput, version: number, now: number): DatabaseRow {
  return db.transaction(() => {
    assertVersion(database(db, userId, id).schema_version, version);
    const { n = 0, last = 0 } = db.get<{ n: number; last: number }>('SELECT COUNT(*) AS n, COALESCE(MAX(position),0) AS last FROM pages WHERE database_id = ? AND user_id = ?', id, userId) ?? {};
    if (n >= MAX_ROWS) throw new AppError('conflict', '每個資料庫最多 5,000 列（包含垃圾桶），請先永久刪除不需要的列。');
    const rowId = crypto.randomUUID();
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
export function listRows(db: Db, userId: string, id: string, config: ViewConfig, offset: number, limit: number): RowsDto {
  database(db, userId, id);
  const props = properties(db, userId, id);
  const error = validateView(config, props);
  if (error) throw new AppError('bad_request', error);
  const pages = db.all<DatabasePage>("SELECT * FROM pages WHERE database_id = ? AND user_id = ? AND kind = 'row' AND trashed_at IS NULL ORDER BY position, id LIMIT 5001", id, userId);
  if (pages.length > MAX_ROWS) throw new AppError('conflict', '資料庫超過 5,000 列，請先整理資料。');
  const values = readValues(db, userId, id);
  const rows = evaluateRows(pages.map(page => rowDto(page, values.get(page.id) ?? {})), props, config);
  return { rows: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
}
