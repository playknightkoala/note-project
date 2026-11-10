// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { MemoryRouter } from 'react-router';
import { ApiError } from '../../src/client/api/client.ts';
import { EditableCell } from '../../src/client/features/database/EditableCell.tsx';
import { DataGrid } from '../../src/client/features/database/DataGrid.tsx';
import { NewRowInput } from '../../src/client/features/database/NewRowInput.tsx';
import { BoardView, ListView } from '../../src/client/features/database/CollectionViews.tsx';
import { readViewParams, writeViewParams } from '../../src/client/features/database/viewParams.ts';
import { evaluateRows, validateView } from '../../src/shared/database.ts';
import type { DatabaseProperty, DatabaseRow } from '../../src/shared/database.ts';

const property: DatabaseProperty = { id: crypto.randomUUID(), name: '摘要', type: 'text', choices: [], position: 1 };
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('reports the value the cell showed when editing began, even if a background refresh brings a newer one', async () => {
  const save = vi.fn().mockResolvedValue({});
  const reload = vi.fn();
  const view = (value: string) => <MantineProvider env="test"><EditableCell property={property} value={value} label="編輯摘要" onSave={save} onReload={reload} /></MantineProvider>;
  const { rerender } = render(view('原文'));
  fireEvent.click(screen.getByRole('button', { name: '編輯摘要' }));
  fireEvent.change(screen.getByLabelText('摘要'), { target: { value: '我的草稿' } });
  rerender(view('另一個分頁的修改'));
  await act(async () => { fireEvent.keyDown(screen.getByLabelText('摘要'), { key: 'Enter' }); });
  // The server compares this base with what the cell holds now, so the other tab's change is noticed, not overwritten.
  expect(save).toHaveBeenCalledWith('我的草稿', '原文');
});

it('keeps a rejected draft visible and lets the user explicitly discard and reload', async () => {
  const save = vi.fn().mockRejectedValue(new ApiError(409, 'version_conflict', '資料已更新'));
  const reload = vi.fn();
  render(<MantineProvider env="test"><EditableCell property={property} value="原文" label="編輯摘要" onSave={save} onReload={reload} /></MantineProvider>);
  fireEvent.click(screen.getByRole('button', { name: '編輯摘要' }));
  fireEvent.change(screen.getByLabelText('摘要'), { target: { value: '保留這份草稿' } });
  await act(async () => { fireEvent.blur(screen.getByLabelText('摘要')); });
  expect((screen.getByLabelText('摘要') as HTMLInputElement).value).toBe('保留這份草稿');
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '重新載入並捨棄草稿' }));
  expect(reload).toHaveBeenCalledOnce();
});

it('keeps the cell editor open when selecting an option from the nested dropdown', async () => {
  const choice = { id: crypto.randomUUID(), label: '進行中', color: 'blue' as const };
  const select: DatabaseProperty = { ...property, type: 'select', choices: [choice] };
  const save = vi.fn().mockResolvedValue({});
  render(<MantineProvider env="test"><EditableCell property={select} value={null} label="編輯狀態" onSave={save} onReload={vi.fn()} /></MantineProvider>);
  fireEvent.click(screen.getByRole('button', { name: '編輯狀態' }));
  fireEvent.click(screen.getByRole('combobox'));
  const option = screen.getByRole('option', { name: '進行中' });
  fireEvent.mouseDown(option); fireEvent.click(option);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '儲存' })); });
  expect(save).toHaveBeenCalledWith(choice.id, null);
});

it('rejects an incomplete number instead of serializing NaN as null and clearing a cell', async () => {
  const save = vi.fn();
  render(<MantineProvider env="test"><EditableCell property={{ ...property, type: 'number' }} value={1} label="編輯數字" onSave={save} onReload={vi.fn()} /></MantineProvider>);
  fireEvent.click(screen.getByRole('button', { name: '編輯數字' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '-' } });
  await act(async () => { fireEvent.blur(screen.getByRole('textbox')); });
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

it('saves on blur once, ignores IME Enter, and cancels edits with Escape', async () => {
  let finish!: () => void;
  const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<MantineProvider env="test"><EditableCell property={property} value="原文" label="摘要格" onSave={save} onReload={vi.fn()} /></MantineProvider>);
  fireEvent.click(screen.getByRole('button', { name: '摘要格' }));
  const input = screen.getByLabelText('摘要');
  fireEvent.change(input, { target: { value: '新內容' } });
  fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
  expect(save).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.blur(input); });
  expect(save).toHaveBeenCalledExactlyOnceWith('新內容', '原文');
  await act(async () => finish());
  fireEvent.click(screen.getByRole('button', { name: '摘要格' }));
  fireEvent.change(screen.getByLabelText('摘要'), { target: { value: '取消這份草稿' } });
  fireEvent.keyDown(screen.getByLabelText('摘要'), { key: 'Escape' });
  expect(save).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('textbox')).toBeNull();
});

it('shows two empty table inputs without creating records and creates only after a value is entered', async () => {
  const create = vi.fn().mockResolvedValue({});
  render(<MantineProvider env="test"><MemoryRouter><DataGrid databaseId="synthetic" rows={[]} properties={[property]} total={0} config={{ sorts: [], filters: [] }} onSave={vi.fn()} onReload={vi.fn()} onEditProperty={vi.fn()} onConfig={vi.fn()} onFilter={vi.fn()} onTrash={vi.fn()} hasMore={false} loadingMore={false} onMore={vi.fn()} onCreate={create} onAddProperty={vi.fn()} adding={false} onCloseAdd={vi.fn()} /></MemoryRouter></MantineProvider>);
  expect(screen.getAllByRole('row')).toHaveLength(3);
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '空白列 1／名稱' }));
  fireEvent.blur(screen.getByLabelText('名稱'));
  expect(create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '空白列 2／摘要' }));
  fireEvent.change(screen.getByLabelText('摘要'), { target: { value: '先填屬性' } });
  await act(async () => { fireEvent.keyDown(screen.getByLabelText('摘要'), { key: 'Enter' }); });
  expect(create).toHaveBeenCalledExactlyOnceWith('', { [property.id]: '先填屬性' });
});

it('creates from the bottom input on Enter and keeps a failed title for retry', async () => {
  const create = vi.fn().mockRejectedValueOnce(new Error('連線失敗')).mockResolvedValueOnce({});
  render(<MantineProvider env="test"><NewRowInput onCreate={create} /></MantineProvider>);
  fireEvent.click(screen.getByRole('button', { name: '新增頁面' }));
  fireEvent.change(screen.getByLabelText('新資料列名稱'), { target: { value: '保留標題' } });
  fireEvent.compositionStart(screen.getByLabelText('新資料列名稱'));
  fireEvent.keyDown(screen.getByLabelText('新資料列名稱'), { key: 'Enter' });
  expect(create).not.toHaveBeenCalled();
  fireEvent.compositionEnd(screen.getByLabelText('新資料列名稱'));
  await act(async () => { fireEvent.keyDown(screen.getByLabelText('新資料列名稱'), { key: 'Enter' }); });
  expect(screen.getByRole('alert').textContent).toContain('連線失敗');
  expect((screen.getByLabelText('新資料列名稱') as HTMLInputElement).value).toBe('保留標題');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重試' })); });
  expect(create).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: '新增頁面' })).toBeTruthy();
});

it('toggles a checkbox directly from its shown value and suppresses double clicks while saving', async () => {
  let finish!: () => void;
  const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<MantineProvider env="test"><EditableCell property={{ ...property, type: 'checkbox' }} value={false} label="完成狀態" onSave={save} onReload={vi.fn()} /></MantineProvider>);
  fireEvent.click(screen.getByRole('button', { name: '完成狀態' }));
  fireEvent.click(screen.getByRole('button', { name: '完成狀態' }));
  expect(save).toHaveBeenCalledExactlyOnceWith(true, false);
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => finish());
});

it('edits shared row titles in list view from the title shown, and moves board cards through the accessible menu', async () => {
  const group: DatabaseProperty = { ...property, type: 'select', choices: [{ id: crypto.randomUUID(), label: '進行中', color: 'blue' }] };
  const row: DatabaseRow = { id: crypto.randomUUID(), databaseId: 'synthetic', title: '共用任務', icon: null, version: 7, values: {}, updatedAt: 0 };
  const save = vi.fn().mockResolvedValue({}); const move = vi.fn();
  const props = { rows: [row], properties: [group], config: { sorts: [], filters: [], groupBy: group.id }, onSave: save, onCreate: vi.fn(), onTrash: vi.fn(), onReload: vi.fn(), adding: false, onCloseAdd: vi.fn() };
  const { rerender } = render(<MantineProvider env="test"><MemoryRouter><ListView {...props} /></MemoryRouter></MantineProvider>);
  fireEvent.click(screen.getByRole('button', { name: '共用任務／名稱' }));
  fireEvent.change(screen.getByLabelText('名稱'), { target: { value: '改名' } });
  await act(async () => { fireEvent.blur(screen.getByLabelText('名稱')); });
  expect(save).toHaveBeenCalledWith(row, 'title', '改名', '共用任務');
  rerender(<MantineProvider env="test"><MemoryRouter><BoardView {...props} onMove={move} moving={false} /></MemoryRouter></MantineProvider>);
  fireEvent.click(screen.getByRole('button', { name: '卡片選單：共用任務' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: '進行中' }));
  expect(move).toHaveBeenCalledExactlyOnceWith(row, group.id, group.choices[0]!.id);
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
