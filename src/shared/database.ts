import { z } from 'zod';

export const PROPERTY_TYPES = ['text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url'] as const;
export const CHOICE_COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const;
export const propertyTypeSchema = z.enum(PROPERTY_TYPES);
export type PropertyType = z.infer<typeof propertyTypeSchema>;
export const propertyLabels: Record<PropertyType, string> = { text: '文字', number: '數字', select: '單選', multi_select: '多選', date: '日期', checkbox: '核取方塊', url: '網址' };
export const choiceSchema = z.object({ id: z.string().uuid(), label: z.string().trim().min(1).max(80), color: z.enum(CHOICE_COLORS).default('gray') });
export type PropertyChoice = z.infer<typeof choiceSchema>;
const choicesSchema = z.array(choiceSchema).max(100).refine(choices => new Set(choices.map(c => c.id)).size === choices.length, '選項 ID 不可重複。');
/** Common currencies, offered both as the options of a currency column and as the two sides of a conversion. */
export const CURRENCIES = ['TWD', 'JPY', 'USD', 'EUR', 'CNY', 'HKD', 'KRW', 'GBP', 'AUD', 'CAD', 'SGD', 'THB', 'MYR', 'VND', 'PHP', 'IDR', 'CHF', 'NZD'] as const;
export const currencySchema = z.enum(CURRENCIES);
export type Currency = z.infer<typeof currencySchema>;
export const currencyLabels: Record<Currency, string> = {
  TWD: '新台幣（TWD）', JPY: '日圓（JPY）', USD: '美元（USD）', EUR: '歐元（EUR）', CNY: '人民幣（CNY）', HKD: '港幣（HKD）',
  KRW: '韓元（KRW）', GBP: '英鎊（GBP）', AUD: '澳幣（AUD）', CAD: '加幣（CAD）', SGD: '新加坡幣（SGD）', THB: '泰銖（THB）',
  MYR: '馬來西亞令吉（MYR）', VND: '越南盾（VND）', PHP: '菲律賓披索（PHP）', IDR: '印尼盾（IDR）', CHF: '瑞士法郎（CHF）', NZD: '紐西蘭幣（NZD）',
};
/**
 * `rate` is how much of `to` one unit of `from` buys. Without `sourceId` each cell holds its own amount in `from`.
 * With it the column is calculated from that amount column instead, and `currencyId` names the currency column that
 * says, row by row, which of the two currencies the amount is in; without one every amount counts as `from`.
 */
export const currencyConversionSchema = z.object({
  from: currencySchema, to: currencySchema,
  rate: z.number().positive().finite().refine(rate => Number.isFinite(1 / rate)),
  sourceId: z.string().uuid().optional(), currencyId: z.string().uuid().optional(),
}).refine(({ from, to }) => from !== to, '請選擇兩種不同的幣別。')
  .refine(({ sourceId, currencyId }) => !currencyId || !!sourceId, '指定幣別欄位前請先選擇金額欄位。');
export type CurrencyConversion = z.infer<typeof currencyConversionSchema>;

export function convertCurrency(amount: number, rate: number): number | null {
  const converted = amount * rate;
  return Number.isFinite(converted) ? converted : null;
}

export const propertyInputSchema = z.object({
  name: z.string().trim().min(1).max(80), type: propertyTypeSchema, groupThousands: z.boolean().optional(),
  /** A single-select column whose choices are currency codes. */
  currencyChoices: z.boolean().optional(), currencyConversion: currencyConversionSchema.nullable().optional(), choices: choicesSchema.default([]),
});
export type PropertyInput = z.infer<typeof propertyInputSchema>;
/** Only what a request names is changed: `choices` has no default here, or renaming a column would also empty its choices. */
export const propertyPatchSchema = propertyInputSchema.partial().extend({ choices: choicesSchema.optional() });
export type PropertyPatch = z.infer<typeof propertyPatchSchema>;
export interface DatabaseProperty extends PropertyInput { id: string; position: number }
export const propertyMoveSchema = z.object({ index: z.number().int().min(0).max(50) });
/**
 * The columns with `propertyId` at `index` among the others (past the end: last), positions renumbered; null when
 * there is no such column. The order belongs to the database, so every view and the row panel follow it.
 */
export function moveProperty(properties: DatabaseProperty[], propertyId: string, index: number): DatabaseProperty[] | null {
  const moved = properties.find(property => property.id === propertyId);
  if (!moved) return null;
  const order = properties.filter(property => property.id !== propertyId);
  order.splice(Math.max(0, Math.min(order.length, index)), 0, moved);
  return order.map((property, at) => ({ ...property, position: (at + 1) * 1024 }));
}
/**
 * The `index` for `moveProperty` that puts a column at `place` among the visible ones of a view (in their order).
 * Hidden columns stay next to the visible column they follow.
 */
export function moveTargetIndex(properties: DatabaseProperty[], visibleIds: string[], propertyId: string, place: number): number {
  const others = properties.filter(property => property.id !== propertyId).map(property => property.id);
  const shown = visibleIds.filter(id => id !== propertyId && others.includes(id));
  if (!shown.length) return Math.max(0, properties.findIndex(property => property.id === propertyId));
  return place < shown.length ? others.indexOf(shown[Math.max(0, place)]!) : others.indexOf(shown.at(-1)!) + 1;
}
export type CellValue = string | number | boolean | string[] | null;
export interface DatabaseRow { id: string; databaseId: string; title: string; icon: string | null; version: number; values: Record<string, CellValue>; updatedAt: number }
export const cellValueSchema = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.array(z.string()).max(100), z.null()]);
export const rowInputSchema = z.object({ title: z.string().max(500).optional(), values: z.record(z.string().uuid(), cellValueSchema).refine(values => Object.keys(values).length <= 50, '一次最多更新 50 個欄位。').default({}) });
export type RowInput = z.infer<typeof rowInputSchema>;

export const fieldIdSchema = z.union([z.literal('title'), z.string().uuid()]);
export const sortSchema = z.object({ propertyId: fieldIdSchema, direction: z.enum(['asc', 'desc']) });
export const FILTER_OPERATORS = ['contains', 'not_contains', 'equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'] as const;
export type FilterOperator = typeof FILTER_OPERATORS[number];
export const filterLabels: Record<FilterOperator, string> = { contains: '包含', not_contains: '不包含', equals: '等於', not_equals: '不等於', gt: '大於／晚於', gte: '大於等於／不早於', lt: '小於／早於', lte: '小於等於／不晚於', is_empty: '為空', is_not_empty: '不為空' };
export const filterSchema = z.object({ propertyId: fieldIdSchema, operator: z.enum(FILTER_OPERATORS), value: z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]).default(null) });
const columnIds = z.array(z.uuid()).max(50).refine(ids => new Set(ids).size === ids.length, '欄位不可重複。');
export const viewConfigSchema = z.object({
  sumColumns: columnIds.optional(),
  groupBy: z.string().uuid().optional(),
  sorts: z.array(sortSchema).max(10).default([]), filters: z.array(filterSchema).max(20).default([]),
  columns: columnIds.optional(),
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
export type ColumnTotals = Record<string, string>;
export interface RowsDto { rows: DatabaseRow[]; total: number; offset: number; limit: number; totals?: ColumnTotals }
export const rowsQuerySchema = z.object({ offset: z.coerce.number().int().min(0).max(5000).default(0), limit: z.coerce.number().int().min(1).max(200).default(100), sort: z.string().max(5000).optional(), filter: z.string().max(20000).optional(), sums: z.string().max(2000).optional() });

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
  if (config.sumColumns?.some(id => !canSumColumn(byId.get(id)))) return '加總須使用數字或金額欄位。';
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

/**
 * Drops references to a property from a saved view. `validChoices` narrows this to filters that name a choice which
 * no longer exists, so adding or renaming a choice leaves sorts and the remaining filters alone.
 */
export function pruneViewConfig(view: ViewConfig, propertyId: string, options: { remove: boolean; clearGrouping: boolean; validChoices?: Set<string>; sumOnly?: boolean }): ViewConfig {
  if (options.sumOnly) return view.sumColumns ? { ...view, sumColumns: view.sumColumns.filter(id => id !== propertyId) } : view;
  const { remove, clearGrouping, validChoices } = options;
  const config: ViewConfig = { ...view,
    sorts: validChoices ? view.sorts : view.sorts.filter(sort => sort.propertyId !== propertyId),
    filters: view.filters.filter(filter => filter.propertyId !== propertyId || (validChoices !== undefined && (typeof filter.value !== 'string' || validChoices.has(filter.value)))),
    ...(remove && view.columns ? { columns: view.columns.filter(col => col !== propertyId) } : {}) };
  if (!validChoices && view.sumColumns) config.sumColumns = view.sumColumns.filter(id => id !== propertyId);
  if (clearGrouping && config.groupBy === propertyId) delete config.groupBy;
  return config;
}

const collator = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' });
const empty = (value: CellValue | undefined) => value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
/** A cleared cell is stored as no value at all, whichever empty form the editor produced. */
export const isEmptyValue = empty;
const blank = (value: CellValue | undefined) => empty(value) || value === false;
/** Whether two cell values are the same stored value; every empty form counts as one, and so does an unticked checkbox. */
export const sameValue = (a: CellValue | undefined, b: CellValue | undefined): boolean => blank(a) ? blank(b) : !blank(b) && JSON.stringify(a) === JSON.stringify(b);
function valueOf(row: DatabaseRow, id: string, properties: DatabaseProperty[]): CellValue {
  if (id === 'title') return row.title;
  const property = properties.find(p => p.id === id);
  const converted = convertedAmount(row.values, property, properties);
  if (converted !== undefined) return converted?.amount ?? null;
  return row.values[id] ?? (property?.type === 'checkbox' ? false : null);
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

/** A conversion column that follows an amount column: its cells are calculated and hold nothing of their own. */
export const isCalculated = (property: DatabaseProperty | null | undefined): boolean => !!property?.currencyConversion?.sourceId;
export interface ConvertedAmount { amount: number; currency: Currency; sourceAmount: number; sourceCurrency: Currency }
/**
 * What a calculated conversion column shows for a row: `undefined` when the column is not calculated (its cells hold
 * their own amounts), `null` when there is nothing to show (no amount, or a currency that is neither side of the rate).
 */
export function convertedAmount(values: Record<string, CellValue>, property: DatabaseProperty | null | undefined, properties: DatabaseProperty[]): ConvertedAmount | null | undefined {
  const conversion = property?.currencyConversion;
  if (!conversion?.sourceId) return undefined;
  const sourceAmount = values[conversion.sourceId];
  if (typeof sourceAmount !== 'number') return null;
  let reverse = false;
  if (conversion.currencyId) {
    const code = properties.find(p => p.id === conversion.currencyId)?.choices.find(choice => choice.id === values[conversion.currencyId!])?.label;
    if (code === conversion.to) reverse = true;
    else if (code !== conversion.from) return null;
  }
  const amount = convertCurrency(sourceAmount, reverse ? 1 / conversion.rate : conversion.rate);
  if (amount === null) return null;
  return reverse ? { amount, currency: conversion.from, sourceAmount, sourceCurrency: conversion.to }
    : { amount, currency: conversion.to, sourceAmount, sourceCurrency: conversion.from };
}

/** What is wrong with a column's own settings, apart from the other columns it refers to. */
export function propertyIssue(input: PropertyInput): string | null {
  if (input.currencyConversion && input.type !== 'number') return '幣值換算須使用數字欄位。';
  if (!['select', 'multi_select'].includes(input.type) && input.choices.length) return '只有單選與多選欄位能設定選項。';
  if (new Set(input.choices.map(choice => choice.label.toLowerCase())).size !== input.choices.length) return '選項名稱不可重複。';
  if (input.currencyChoices) {
    if (input.type !== 'select') return '幣別須使用單選欄位。';
    if (!input.choices.length) return '請至少選擇一種幣別。';
    if (input.choices.some(choice => !currencySchema.safeParse(choice.label).success)) return '幣別欄位的選項必須是支援的幣別代碼。';
  }
  return null;
}

/**
 * The first conversion column whose amount or currency column is missing or of the wrong kind. Checked for the whole
 * database after every change to its columns, so a column in use by a conversion cannot be removed or repurposed.
 */
export function conversionIssue(properties: DatabaseProperty[]): { property: DatabaseProperty; message: string } | null {
  for (const property of properties) {
    const conversion = property.currencyConversion;
    if (!conversion) continue;
    const source = properties.find(p => p.id === conversion.sourceId);
    if (conversion.sourceId && (source?.type !== 'number' || source.currencyConversion)) return { property, message: '換算的金額欄位必須是此資料庫的數字或金額欄位。' };
    if (conversion.currencyId && !properties.find(p => p.id === conversion.currencyId)?.currencyChoices) return { property, message: '換算依據的幣別欄位必須是此資料庫的幣別欄位。' };
  }
  return null;
}

export function canSumColumn(property: DatabaseProperty | undefined): boolean {
  return property?.type === 'number' && !property.currencyConversion;
}

/** Sum the decimal values supplied by the rows without introducing floating-point rounding artifacts.
 * A common scale accommodates the smallest finite exponent and all digits of a number’s mantissa.
 */
export function sumColumns(rows: DatabaseRow[], ids: readonly string[]): ColumnTotals {
  const scale = 340;
  return Object.fromEntries(ids.map(id => {
    let total = 0n;
    for (const row of rows) {
      const value = row.values[id];
      if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) continue;
      const [mantissa, exponent] = value.toExponential().split('e');
      const [whole, fraction = ''] = mantissa!.split('.');
      total += BigInt(whole + fraction) * 10n ** BigInt(scale + Number(exponent) - fraction.length);
    }
    const digits = (total < 0n ? -total : total).toString().padStart(scale + 1, '0');
    const integer = digits.slice(0, -scale);
    const fraction = digits.slice(-scale).replace(/0+$/, '');
    return [id, (total < 0n ? '-' : '') + integer + (fraction ? '.' + fraction : '')];
  }));
}
