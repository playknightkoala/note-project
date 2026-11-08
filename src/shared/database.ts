import { z } from 'zod';

export const PROPERTY_TYPES = ['text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url'] as const;
export const CHOICE_COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const;
export const propertyTypeSchema = z.enum(PROPERTY_TYPES);
export type PropertyType = z.infer<typeof propertyTypeSchema>;
export const propertyLabels: Record<PropertyType, string> = { text: '文字', number: '數字', select: '單選', multi_select: '多選', date: '日期', checkbox: '核取方塊', url: '網址' };
export const choiceSchema = z.object({ id: z.string().uuid(), label: z.string().trim().min(1).max(80), color: z.enum(CHOICE_COLORS).default('gray') });
export type PropertyChoice = z.infer<typeof choiceSchema>;
const choicesSchema = z.array(choiceSchema).max(100).refine(choices => new Set(choices.map(c => c.id)).size === choices.length, '選項 ID 不可重複。');
export const propertyInputSchema = z.object({ name: z.string().trim().min(1).max(80), type: propertyTypeSchema, choices: choicesSchema.default([]) });
export type PropertyInput = z.infer<typeof propertyInputSchema>;
export const propertyPatchSchema = propertyInputSchema.partial();
export type PropertyPatch = z.infer<typeof propertyPatchSchema>;
export interface DatabaseProperty extends PropertyInput { id: string; position: number }
export type CellValue = string | number | boolean | string[] | null;
export interface DatabaseRow { id: string; databaseId: string; title: string; icon: string | null; version: number; values: Record<string, CellValue>; updatedAt: number }
export const rowInputSchema = z.object({ title: z.string().max(500).optional(), values: z.record(z.string().uuid(), z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.array(z.string()).max(100), z.null()])).refine(values => Object.keys(values).length <= 50, '一次最多更新 50 個欄位。').default({}) });
export type RowInput = z.infer<typeof rowInputSchema>;

export const fieldIdSchema = z.union([z.literal('title'), z.string().uuid()]);
export const sortSchema = z.object({ propertyId: fieldIdSchema, direction: z.enum(['asc', 'desc']) });
export const FILTER_OPERATORS = ['contains', 'not_contains', 'equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'] as const;
export type FilterOperator = typeof FILTER_OPERATORS[number];
export const filterLabels: Record<FilterOperator, string> = { contains: '包含', not_contains: '不包含', equals: '等於', not_equals: '不等於', gt: '大於／晚於', gte: '大於等於／不早於', lt: '小於／早於', lte: '小於等於／不晚於', is_empty: '為空', is_not_empty: '不為空' };
export const filterSchema = z.object({ propertyId: fieldIdSchema, operator: z.enum(FILTER_OPERATORS), value: z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]).default(null) });
export const viewConfigSchema = z.object({
  groupBy: z.string().uuid().optional(),
  sorts: z.array(sortSchema).max(10).default([]), filters: z.array(filterSchema).max(20).default([]),
  columns: z.array(z.string().uuid()).max(50).refine(ids => new Set(ids).size === ids.length, '欄位不可重複。').optional(),
});
export type ViewConfig = z.infer<typeof viewConfigSchema>;
export type DatabaseSort = z.infer<typeof sortSchema>;
export type DatabaseFilter = z.infer<typeof filterSchema>;
export const VIEW_TYPES = ['table', 'list', 'board'] as const;
export type ViewType = typeof VIEW_TYPES[number];
export const viewLabels: Record<ViewType, string> = { table: '表格', list: '清單', board: '看板' };
export const viewInputSchema = z.object({ name: z.string().trim().min(1).max(80), type: z.enum(VIEW_TYPES).optional(), config: viewConfigSchema });
export type ViewInput = z.infer<typeof viewInputSchema>;
export interface DatabaseView { id: string; name: string; type: ViewType; config: ViewConfig }
export interface DatabaseDto { id: string; version: number; properties: DatabaseProperty[]; views: DatabaseView[] }
export interface RowsDto { rows: DatabaseRow[]; total: number; offset: number; limit: number }
export const rowsQuerySchema = z.object({ offset: z.coerce.number().int().min(0).max(5000).default(0), limit: z.coerce.number().int().min(1).max(200).default(100), sort: z.string().max(5000).optional(), filter: z.string().max(20000).optional() });

const emptyOperators: FilterOperator[] = ['is_empty', 'is_not_empty'];
export function operatorsFor(type: PropertyType | 'title'): FilterOperator[] {
  if (type === 'checkbox') return ['equals', 'not_equals'];
  if (type === 'multi_select') return ['contains', 'not_contains', ...emptyOperators];
  if (type === 'number' || type === 'date') return ['equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', ...emptyOperators];
  if (type === 'select') return ['equals', 'not_equals', ...emptyOperators];
  return ['contains', 'not_contains', 'equals', 'not_equals', ...emptyOperators];
}
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, '日期不正確。');
export function valueSchema(property: DatabaseProperty) {
  switch (property.type) {
    case 'number': return z.number().finite().nullable();
    case 'checkbox': return z.boolean().nullable();
    case 'date': return dateSchema.nullable();
    case 'url': return z.url().max(2000).refine(value => /^https?:\/\//i.test(value), '網址只接受 http 或 https。').nullable();
    case 'select': return z.string().refine(id => property.choices.some(choice => choice.id === id), '選項不存在。').nullable();
    case 'multi_select': return z.array(z.string().refine(id => property.choices.some(choice => choice.id === id), '選項不存在。')).max(100).refine(ids => new Set(ids).size === ids.length, '選項不可重複。').nullable();
    default: return z.string().max(2000).nullable();
  }
}

export function validateView(config: ViewConfig, properties: DatabaseProperty[]): string | null {
  const byId = new Map(properties.map(p => [p.id, p]));
  if (config.groupBy && byId.get(config.groupBy)?.type !== 'select') return '看板分組必須使用此資料庫的單選欄位。';
  for (const id of [...config.sorts.map(s => s.propertyId), ...config.filters.map(f => f.propertyId), ...(config.columns ?? [])]) {
    if (id !== 'title' && !byId.has(id)) return '視圖包含不存在的欄位。';
  }
  for (const filter of config.filters) {
    const property = byId.get(filter.propertyId);
    if (!operatorsFor(property?.type ?? 'title').includes(filter.operator)) return '此欄位不支援選取的篩選條件。';
    if (emptyOperators.includes(filter.operator)) continue;
    if (property?.type === 'multi_select') {
      if (typeof filter.value !== 'string' || !property.choices.some(c => c.id === filter.value)) return '篩選選項不存在。';
    } else if (filter.value === null || !(property ? valueSchema(property) : z.string().max(2000)).safeParse(filter.value).success) return '篩選值與欄位型別不符。';
  }
  return null;
}

const collator = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' });
const empty = (value: CellValue | undefined) => value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
function valueOf(row: DatabaseRow, id: string, properties: DatabaseProperty[]): CellValue {
  if (id === 'title') return row.title;
  return row.values[id] ?? (properties.find(p => p.id === id)?.type === 'checkbox' ? false : null);
}
function compare(a: CellValue, b: CellValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}
/** All conditions use AND. Empty values sort last in both directions; ties retain the database's stable order. */
export function evaluateRows(rows: DatabaseRow[], properties: DatabaseProperty[], config: ViewConfig): DatabaseRow[] {
  const filtered = rows.filter(row => config.filters.every(filter => {
    const actual = valueOf(row, filter.propertyId, properties);
    const expected = filter.value;
    const contains = Array.isArray(actual) ? actual.includes(String(expected)) : String(actual ?? '').toLocaleLowerCase().includes(String(expected ?? '').toLocaleLowerCase());
    switch (filter.operator) {
      case 'is_empty': return empty(actual);
      case 'is_not_empty': return !empty(actual);
      case 'contains': return contains;
      case 'not_contains': return !contains;
      case 'equals': return !empty(actual) && compare(actual, expected) === 0;
      case 'not_equals': return empty(actual) || compare(actual, expected) !== 0;
      case 'gt': return !empty(actual) && compare(actual, expected) > 0;
      case 'gte': return !empty(actual) && compare(actual, expected) >= 0;
      case 'lt': return !empty(actual) && compare(actual, expected) < 0;
      case 'lte': return !empty(actual) && compare(actual, expected) <= 0;
    }
  }));
  const displayValue = (value: CellValue, id: string): CellValue => {
    const property = properties.find(p => p.id === id);
    if (property?.type === 'select') return property.choices.find(c => c.id === value)?.label ?? null;
    if (property?.type === 'multi_select' && Array.isArray(value)) return value.map(id => property.choices.find(c => c.id === id)?.label ?? '').join(', ');
    return value;
  };
  return filtered.sort((a, b) => {
    for (const sort of config.sorts) {
      const av = displayValue(valueOf(a, sort.propertyId, properties), sort.propertyId);
      const bv = displayValue(valueOf(b, sort.propertyId, properties), sort.propertyId);
      if (empty(av) !== empty(bv)) return empty(av) ? 1 : -1;
      const delta = compare(av, bv);
      if (delta) return sort.direction === 'asc' ? delta : -delta;
    }
    return 0;
  });
}
