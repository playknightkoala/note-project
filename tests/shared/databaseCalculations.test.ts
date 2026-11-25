import { describe, expect, it } from 'vitest';
import { moveProperty, moveTargetIndex, conversionIssue, convertCurrency, convertedAmount, currencyConversionSchema, evaluateRows, propertyIssue, pruneViewConfig, sumColumns, validateView, viewConfigSchema } from '../../src/shared/database.ts';
import type { DatabaseProperty, DatabaseRow } from '../../src/shared/database.ts';

const numeric: DatabaseProperty = { id: crypto.randomUUID(), name: '費用', position: 1, type: 'number', choices: [] };
const conversion = { from: 'TWD' as const, to: 'JPY' as const, rate: 4.95 };
const row = (value: number | null): DatabaseRow => ({
  id: crypto.randomUUID(), databaseId: 'db', title: '', icon: null, version: 1, values: { [numeric.id]: value }, updatedAt: 0,
});

describe('資料庫計算', () => {
  it('requires distinct supported currencies and a positive rate with a finite inverse', () => {
    expect(currencyConversionSchema.safeParse(conversion).success).toBe(true);
    expect(currencyConversionSchema.safeParse({ ...conversion, to: 'TWD' }).success).toBe(false);
    expect(currencyConversionSchema.safeParse({ from: 'TWD', rate: 4.95 }).success).toBe(false);
    expect(currencyConversionSchema.safeParse({ ...conversion, rate: 0 }).success).toBe(false);
    expect(currencyConversionSchema.safeParse({ ...conversion, rate: Number.MIN_VALUE }).success).toBe(false);
    expect(convertCurrency(2000, conversion.rate)).toBe(9900);
    expect(convertCurrency(9900, 1 / conversion.rate)).toBeCloseTo(2000);
  });

  it('sums decimal values exactly and ignores blank cells', () => {
    expect(sumColumns([row(0.1), row(null), row(0.2), row(-1.5)], [numeric.id])).toEqual({ [numeric.id]: '-1.2' });
    expect(sumColumns([row(Number.MIN_VALUE), row(1e23), row(-1e23)], [numeric.id]))
      .toEqual({ [numeric.id]: '0.' + '0'.repeat(323) + '5' });
    expect(sumColumns([], [numeric.id])).toEqual({ [numeric.id]: '0' });
  });

  it('loads old view settings and removes a sum when the numeric column changes kind', () => {
    const config = viewConfigSchema.parse({ expense: { oldSetting: true }, sumColumns: [numeric.id] });
    expect(config).not.toHaveProperty('expense');
    expect(validateView(config, [numeric])).toBeNull();
    expect(validateView(config, [{ ...numeric, currencyConversion: conversion }])).toBeTruthy();
    expect(pruneViewConfig(config, numeric.id, { remove: false, clearGrouping: false, sumOnly: true }).sumColumns).toEqual([]);
  });

  it('moves a column among the others, renumbers positions and maps a place among the visible columns', () => {
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((name, at): DatabaseProperty => ({ id: crypto.randomUUID(), name, position: (at + 1) * 1024, type: 'text', choices: [] }));
    const all = [a!, b!, c!, d!];
    const names = (list: DatabaseProperty[] | null) => list?.map(property => property.name).join('');
    expect(names(moveProperty(all, d!.id, 0))).toBe('DABC');
    expect(names(moveProperty(all, a!.id, 2))).toBe('BCAD');
    expect(names(moveProperty(all, b!.id, 99))).toBe('ACDB');
    expect(names(moveProperty(all, b!.id, 1))).toBe('ABCD');
    expect(moveProperty(all, d!.id, 0)!.map(property => property.position)).toEqual([1024, 2048, 3072, 4096]);
    expect(moveProperty(all, crypto.randomUUID(), 0)).toBeNull();
    expect(all.map(property => property.name).join('')).toBe('ABCD');
    // B is hidden: it stays right after A wherever the visible columns go.
    const visible = [a!.id, c!.id, d!.id];
    const place = (id: string, to: number) => names(moveProperty(all, id, moveTargetIndex(all, visible, id, to)));
    expect(place(d!.id, 0)).toBe('DABC');
    expect(place(d!.id, 1)).toBe('ABDC');
    expect(place(a!.id, 1)).toBe('BCAD');
    expect(place(a!.id, 2)).toBe('BCDA');
    expect(place(c!.id, 1)).toBe('ABCD');
    expect(place(c!.id, 9)).toBe('ABDC');
    expect(moveTargetIndex(all, [c!.id], c!.id, 0)).toBe(2);
  });

  describe('a conversion that follows an amount column', () => {
    const twd = { id: crypto.randomUUID(), label: 'TWD', color: 'green' as const }, jpy = { id: crypto.randomUUID(), label: 'JPY', color: 'yellow' as const };
    const usd = { id: crypto.randomUUID(), label: 'USD', color: 'blue' as const };
    const currency: DatabaseProperty = { id: crypto.randomUUID(), name: '幣別', position: 2, type: 'select', currencyChoices: true, choices: [twd, jpy, usd] };
    const converted: DatabaseProperty = { id: crypto.randomUUID(), name: '換算', position: 3, type: 'number', choices: [],
      currencyConversion: { from: 'JPY', to: 'TWD', rate: 0.2, sourceId: numeric.id, currencyId: currency.id } };
    const properties = [numeric, currency, converted];
    const entry = (id: string, amount: number | null, choice?: string): DatabaseRow => ({
      id, databaseId: 'db', title: id, icon: null, version: 1, values: { [numeric.id]: amount, ...(choice ? { [currency.id]: choice } : {}) }, updatedAt: 0,
    });

    it('converts each row towards the other currency of the pair, and shows nothing for any other currency', () => {
      expect(convertedAmount(entry('a', 15900, jpy.id).values, converted, properties)).toEqual({ amount: 3180, currency: 'TWD', sourceAmount: 15900, sourceCurrency: 'JPY' });
      expect(convertedAmount(entry('b', 2000, twd.id).values, converted, properties)).toEqual({ amount: 10000, currency: 'JPY', sourceAmount: 2000, sourceCurrency: 'TWD' });
      expect(convertedAmount(entry('c', 10, usd.id).values, converted, properties)).toBeNull();
      expect(convertedAmount(entry('d', 10).values, converted, properties)).toBeNull();
      expect(convertedAmount(entry('e', null, jpy.id).values, converted, properties)).toBeNull();
      // Without a currency column every amount is in the base currency.
      const plain = { ...converted, currencyConversion: { from: 'JPY' as const, to: 'TWD' as const, rate: 0.2, sourceId: numeric.id } };
      expect(convertedAmount(entry('f', 500).values, plain, properties)).toMatchObject({ amount: 100, currency: 'TWD' });
      // A column that holds its own amounts is not calculated at all.
      expect(convertedAmount({}, { ...numeric, currencyConversion: conversion }, properties)).toBeUndefined();
      expect(convertedAmount({}, null, properties)).toBeUndefined();
    });

    it('sorts and filters by the calculated amount, ignoring anything stored in the column itself', () => {
      const rows = [entry('twd', 2000, twd.id), entry('none', 1), entry('jpy', 15900, jpy.id)];
      rows[1]!.values[converted.id] = 999999;
      expect(evaluateRows(rows, properties, { sorts: [{ propertyId: converted.id, direction: 'asc' }], filters: [] }).map(row => row.id)).toEqual(['jpy', 'twd', 'none']);
      expect(evaluateRows(rows, properties, { sorts: [], filters: [{ propertyId: converted.id, operator: 'gt', value: 5000 }] }).map(row => row.id)).toEqual(['twd']);
      expect(evaluateRows(rows, properties, { sorts: [], filters: [{ propertyId: converted.id, operator: 'is_empty', value: null }] }).map(row => row.id)).toEqual(['none']);
      expect(validateView({ sorts: [], filters: [{ propertyId: converted.id, operator: 'gt', value: 5000 }], sumColumns: [converted.id] }, properties)).toBe('加總須使用數字或金額欄位。');
    });

    it('requires an amount column and a currency column of the right kind', () => {
      expect(currencyConversionSchema.safeParse({ ...conversion, currencyId: currency.id }).success).toBe(false);
      expect(conversionIssue(properties)).toBeNull();
      expect(conversionIssue([currency, converted])?.property).toBe(converted);
      expect(conversionIssue([numeric, converted])?.property).toBe(converted);
      expect(conversionIssue([numeric, { ...currency, currencyChoices: false }, converted])?.property).toBe(converted);
      expect(conversionIssue([{ ...numeric, type: 'text' }, currency, converted])?.property).toBe(converted);
      const chained = { ...converted, id: crypto.randomUUID(), currencyConversion: { ...converted.currencyConversion!, sourceId: converted.id } };
      expect(conversionIssue([...properties, chained])?.property).toBe(chained);
      const self = { ...converted, currencyConversion: { ...converted.currencyConversion!, sourceId: converted.id } };
      expect(conversionIssue([numeric, currency, self])?.property).toBe(self);
    });

    it('accepts only currency codes as the choices of a currency column', () => {
      expect(propertyIssue(currency)).toBeNull();
      expect(propertyIssue({ ...currency, choices: [] })).toBeTruthy();
      expect(propertyIssue({ ...currency, choices: [{ ...twd, label: '台幣' }] })).toBeTruthy();
      expect(propertyIssue({ ...currency, type: 'multi_select' })).toBeTruthy();
      expect(propertyIssue({ ...numeric, currencyChoices: true })).toBeTruthy();
    });
  });
});
