import { describe, expect, it } from 'vitest';
import { perPersonTwd, pruneViewConfig, validateView } from '../../src/shared/database.ts';
import type { DatabaseProperty, ExpenseConfig, ViewConfig } from '../../src/shared/database.ts';

const expense: ExpenseConfig = { amountId: 'amount', currencyId: 'currency', peopleId: 'people', rateId: 'rate', rates: { JPY: 4.95, TWD: 1 } };
const config: ViewConfig = { expense, filters: [], sorts: [] };
const base = { amount: 15900, currency: 'JPY', people: 1 };
describe('每人台幣', () => {
  it('uses currency defaults, per-row overrides, and whole-person shares', () => {
    expect(perPersonTwd(base, expense)).toBe(3212);
    expect(perPersonTwd({ ...base, amount: 37180, currency: 'TWD', people: 3 }, expense)).toBe(12393);
    expect(perPersonTwd({ ...base, amount: -225, rate: 5, people: 2 }, expense)).toBe(-23);
    expect(perPersonTwd({ ...base, amount: 0 }, expense)).toBe(0);
  });
  it.each([{ people: 4.95 }, { people: 0 }, { amount: null }, { rate: 0 }, { currency: 'USD' }])('marks incomplete input as missing', patch => {
    expect(perPersonTwd({ ...base, ...patch }, expense)).toBeNull();
  });
  it('checks the source types and removes broken references when editing the database', () => {
    const props: DatabaseProperty[] = ['amount', 'currency', 'people', 'rate'].map(id => ({ id, name: id, position: 1, type: id === 'currency' ? 'select' : 'number', choices: [] }));
    expect(validateView(config, props)).toBeNull();
    expect(validateView(config, props.slice(1))).toBeTruthy();
    expect(pruneViewConfig(config, 'amount', { remove: true, clearGrouping: true }).expense).toBeUndefined();
    expect(pruneViewConfig(config, 'currency', { remove: false, clearGrouping: false, validChoices: new Set(['JPY']) }).expense?.rates).toEqual({ JPY: 4.95 });
  });
});
