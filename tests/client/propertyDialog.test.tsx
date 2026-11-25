// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PropertyDialog } from '../../src/client/features/database/PropertyDialog.tsx';
import { EditableCell } from '../../src/client/features/database/EditableCell.tsx';
import { convertedAmount } from '../../src/shared/database.ts';
import type { DatabaseDto, DatabaseProperty } from '../../src/shared/database.ts';
import type { OfflineOp } from '../../src/shared/offline.ts';

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const twd = { id: crypto.randomUUID(), label: 'TWD', color: 'green' as const }, jpy = { id: crypto.randomUUID(), label: 'jpy', color: 'yellow' as const };
const amount: DatabaseProperty = { id: crypto.randomUUID(), name: '原幣金額', type: 'number', groupThousands: true, position: 1, choices: [] };
const select: DatabaseProperty = { id: crypto.randomUUID(), name: '幣別', type: 'select', position: 2, choices: [twd, jpy, { id: crypto.randomUUID(), label: '現金', color: 'gray' }] };
const currency: DatabaseProperty = { ...select, currencyChoices: true, choices: [twd, { ...jpy, label: 'JPY' }] };
const manual: DatabaseProperty = { id: crypto.randomUUID(), name: '日幣台幣轉換', type: 'number', position: 3, choices: [], currencyConversion: { from: 'TWD', to: 'JPY', rate: 5 } };

/** Opens the dialog for `property` (null: a new column) and returns the operations it sends. */
function open(properties: DatabaseProperty[], property: DatabaseProperty | null) {
  const meta: DatabaseDto = { id: crypto.randomUUID(), version: 7, properties, views: [{ id: crypto.randomUUID(), name: '表格', type: 'table', config: { sorts: [], filters: [] } }] };
  const ops: OfflineOp[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
    if (init.method === 'POST' && input === '/api/offline/ops') { ops.push((JSON.parse(String(init.body)) as { op: OfflineOp }).op); return Response.json({ database: meta }); }
    if (init.method === 'GET') return Response.json(meta);
    throw new Error(`Unexpected test request: ${init.method} ${input}`);
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onClose = vi.fn();
  render(<MantineProvider env="test"><QueryClientProvider client={client}><PropertyDialog meta={meta} property={property} onClose={onClose} onReload={vi.fn()} /></QueryClientProvider></MantineProvider>);
  return { ops, onClose, meta };
}
async function choose(label: string | RegExp, option: string) {
  fireEvent.click(screen.getByLabelText(label, { selector: 'input' }));
  const item = await screen.findByRole('option', { name: option });
  await act(async () => { fireEvent.mouseDown(item); fireEvent.click(item); });
}
const save = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: '儲存欄位' })); }); };

it('turns a single select into a currency column, keeping the choices that are currency codes and adding picked ones', async () => {
  const { ops, onClose, meta } = open([amount, select], select);
  await choose('欄位型別', '幣別');
  // The existing TWD and jpy choices are kept; 現金 is not a currency and is announced as going away.
  expect(screen.getByText(/「現金」不是幣別代碼/)).toBeTruthy();
  await choose(/可選幣別/, '美元（USD）');
  await save();
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(ops).toHaveLength(1);
  expect(ops[0]).toMatchObject({ type: 'property.update', databaseId: meta.id, baseVersion: 7, propertyId: select.id, input: {
    name: '幣別', type: 'select', currencyChoices: true, groupThousands: false, currencyConversion: null,
    choices: [{ id: twd.id, label: 'TWD', color: 'green' }, { id: jpy.id, label: 'JPY', color: 'yellow' }, { label: 'USD', color: 'blue' }],
  } });
});

it('requires at least one currency for a new currency column', async () => {
  const { ops } = open([amount], null);
  fireEvent.change(screen.getByRole('textbox', { name: /欄位名稱/ }), { target: { value: '幣別' } });
  await choose('欄位型別', '幣別');
  expect((screen.getByRole('button', { name: '儲存欄位' }) as HTMLButtonElement).disabled).toBe(true);
  await choose(/可選幣別/, '日圓（JPY）');
  await choose(/可選幣別/, '新台幣（TWD）');
  await save();
  expect(ops[0]).toMatchObject({ type: 'property.add', input: { name: '幣別', type: 'select', currencyChoices: true, choices: [{ label: 'JPY', color: 'yellow' }, { label: 'TWD', color: 'green' }] } });
});

it('lets a conversion follow an amount column, picking the only currency column along with it', async () => {
  const text: DatabaseProperty = { id: crypto.randomUUID(), name: '備註', type: 'text', position: 4, choices: [] };
  const { ops } = open([amount, currency, manual, text], manual);
  expect(screen.queryByLabelText('依據的幣別欄位', { selector: 'input' })).toBeNull();
  fireEvent.click(screen.getByLabelText('要換算的金額欄位', { selector: 'input' }));
  // Only numeric columns that are not conversions themselves can be the amount.
  expect((await screen.findAllByRole('option')).map(option => option.textContent)).toEqual(['原幣金額']);
  await choose('要換算的金額欄位', '原幣金額');
  expect((screen.getByLabelText('依據的幣別欄位', { selector: 'input' }) as HTMLInputElement).value).toBe('幣別');
  expect(screen.getByText(/TWD 的金額換成 JPY，JPY 的金額換成 TWD/)).toBeTruthy();
  await save();
  expect(ops[0]).toMatchObject({ type: 'property.update', propertyId: manual.id, input: { type: 'number', currencyChoices: false,
    currencyConversion: { from: 'TWD', to: 'JPY', rate: 5, sourceId: amount.id, currencyId: currency.id } } });
});

it('shows a calculated conversion as a read-only cell', () => {
  const calculated: DatabaseProperty = { ...manual, currencyConversion: { from: 'TWD', to: 'JPY', rate: 5, sourceId: amount.id, currencyId: currency.id } };
  const properties = [amount, currency, calculated];
  const cell = (values: Record<string, string | number>) => <MantineProvider env="test"><EditableCell property={calculated} value={null} label="換算格"
    converted={convertedAmount(values, calculated, properties)} onSave={vi.fn()} onReload={vi.fn()} /></MantineProvider>;
  const { rerender } = render(cell({ [amount.id]: 15900, [currency.id]: jpy.id }));
  const button = screen.getByRole('button', { name: '換算格' });
  expect(button.textContent).toBe('TWD 3,180');
  expect(button.getAttribute('aria-readonly')).toBe('true');
  fireEvent.click(button);
  expect(screen.queryByRole('textbox')).toBeNull();
  rerender(cell({ [amount.id]: 37180, [currency.id]: twd.id }));
  expect(screen.getByRole('button', { name: '換算格' }).textContent).toBe('JPY 185,900');
  rerender(cell({ [amount.id]: 37180 }));
  expect(screen.getByRole('button', { name: '換算格' }).textContent).toBe('—');
});
