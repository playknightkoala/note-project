import { describe, expect, it } from 'vitest';
import { convertCurrency, currencyConversionSchema, pruneViewConfig, sumColumns, validateView, viewConfigSchema } from '../../src/shared/database.ts';
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
});
