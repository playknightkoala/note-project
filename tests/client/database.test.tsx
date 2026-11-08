// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { ApiError } from '../../src/client/api/client.ts';
import { EditableCell } from '../../src/client/features/database/EditableCell.tsx';
import { readViewParams, writeViewParams } from '../../src/client/features/database/viewParams.ts';
import { evaluateRows, validateView } from '../../src/shared/database.ts';
import type { DatabaseProperty, DatabaseRow } from '../../src/shared/database.ts';

const property: DatabaseProperty = { id: crypto.randomUUID(), name: '摘要', type: 'text', choices: [], position: 1 };
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('retains the version at editor opening even if a background refresh brings a newer row', async () => {
  const save = vi.fn().mockResolvedValue({});
  const reload = vi.fn();
  const view = (version: number, value: string) => <MantineProvider env="test"><EditableCell property={property} value={value} version={version} label="編輯摘要" onSave={save} onReload={reload} /></MantineProvider>;
  const { rerender } = render(view(1, '原文'));
  fireEvent.click(screen.getByRole('button', { name: '編輯摘要' }));
  fireEvent.change(screen.getByLabelText('摘要'), { target: { value: '我的草稿' } });
  rerender(view(2, '另一個分頁的修改'));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '儲存' })); });
  expect(save).toHaveBeenCalledWith('我的草稿', 1);
});

it('keeps a rejected draft visible and lets the user explicitly discard and reload', async () => {
  const save = vi.fn().mockRejectedValue(new ApiError(409, 'version_conflict', '資料已更新'));
  const reload = vi.fn();
  render(<MantineProvider env="test"><EditableCell property={property} value="原文" version={1} label="編輯摘要" onSave={save} onReload={reload} /></MantineProvider>);
  fireEvent.click(screen.getByRole('button', { name: '編輯摘要' }));
  fireEvent.change(screen.getByLabelText('摘要'), { target: { value: '保留這份草稿' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '儲存' })); });
  expect((screen.getByLabelText('摘要') as HTMLInputElement).value).toBe('保留這份草稿');
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '重新載入並捨棄草稿' }));
  expect(reload).toHaveBeenCalledOnce();
});

it('keeps the cell editor open when selecting an option from the nested dropdown', async () => {
  const choice = { id: crypto.randomUUID(), label: '進行中', color: 'blue' as const };
  const select: DatabaseProperty = { ...property, type: 'select', choices: [choice] };
  const save = vi.fn().mockResolvedValue({});
  render(<MantineProvider env="test"><EditableCell property={select} value={null} version={4} label="編輯狀態" onSave={save} onReload={vi.fn()} /></MantineProvider>);
  fireEvent.click(screen.getByRole('button', { name: '編輯狀態' }));
  fireEvent.click(screen.getByRole('combobox'));
  const option = screen.getByRole('option', { name: '進行中' });
  fireEvent.mouseDown(option); fireEvent.click(option);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '儲存' })); });
  expect(save).toHaveBeenCalledWith(choice.id, 4);
});

it('rejects an incomplete number instead of serializing NaN as null and clearing a cell', async () => {
  const save = vi.fn();
  render(<MantineProvider env="test"><EditableCell property={{ ...property, type: 'number' }} value={1} version={2} label="編輯數字" onSave={save} onReload={vi.fn()} /></MantineProvider>);
  fireEvent.click(screen.getByRole('button', { name: '編輯數字' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '-' } });
  fireEvent.blur(screen.getByRole('textbox'));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '儲存' })); });
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByText('輸入值與欄位型別不符，請檢查後再儲存。')).toBeTruthy();
});

it('round-trips sort/filter/column URL parameters, preserves other parameters and rejects missing columns', () => {
  const config = { sorts: [{ propertyId: property.id, direction: 'desc' as const }], filters: [{ propertyId: property.id, operator: 'contains' as const, value: '中文&x' }], columns: [property.id] };
  const params = writeViewParams(new URLSearchParams('other=value'), config);
  expect(params.get('other')).toBe('value');
  expect(readViewParams(params, { sorts: [], filters: [] }, [property])).toEqual({ config, error: null });
  expect(readViewParams(params, { sorts: [], filters: [] }, []).error).toContain('不存在');
  expect(readViewParams(new URLSearchParams('filter=invalid'), config, [property]).error).toContain('網址');
});

describe('typed view evaluation', () => {
  const select: DatabaseProperty = { ...property, type: 'select', choices: [
    { id: crypto.randomUUID(), label: 'Zulu', color: 'red' }, { id: crypto.randomUUID(), label: 'Alpha', color: 'green' },
  ] };
  const multi: DatabaseProperty = { ...select, id: crypto.randomUUID(), type: 'multi_select' };
  const date: DatabaseProperty = { ...property, id: crypto.randomUUID(), type: 'date' };
  const base = (id: string, values: DatabaseRow['values']): DatabaseRow => ({ id, databaseId: 'db', title: id, icon: null, version: 1, values, updatedAt: 0 });
  const data = [base('z', { [select.id]: select.choices[0]!.id, [multi.id]: [select.choices[1]!.id], [date.id]: '2026-12-01' }), base('empty', {}), base('a', { [select.id]: select.choices[1]!.id, [date.id]: '2026-01-01' })];
  it('sorts choices by label and keeps empty cells last in either direction', () => {
    expect(evaluateRows(data, [select], { sorts: [{ propertyId: select.id, direction: 'asc' }], filters: [] }).map(row => row.id)).toEqual(['a', 'z', 'empty']);
    expect(evaluateRows(data, [select], { sorts: [{ propertyId: select.id, direction: 'desc' }], filters: [] }).map(row => row.id)).toEqual(['z', 'a', 'empty']);
  });
  it('combines multi-select membership and date comparisons', () => {
    const config = { sorts: [], filters: [{ propertyId: multi.id, operator: 'contains' as const, value: select.choices[1]!.id }, { propertyId: date.id, operator: 'gt' as const, value: '2026-06-01' }] };
    expect(validateView(config, [multi, date])).toBeNull();
    expect(evaluateRows(data, [multi, date], config).map(row => row.id)).toEqual(['z']);
    expect(validateView({ sorts: [], filters: [{ propertyId: date.id, operator: 'contains', value: '2026' }] }, [date])).toContain('不支援');
  });
});
