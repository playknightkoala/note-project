import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Group, Popover, Stack } from '@mantine/core';
import type { CellValue, DatabaseProperty } from '@shared/database';
import { valueSchema } from '@shared/database';
import { errorText, isApiError } from '../../api/client.ts';
import { CellDisplay, CellValueInput } from './CellValueInput.tsx';
import { useUpdateGuard } from '../../updates/guards.ts';
import { useDatabaseAccess } from './access.ts';

export interface EditableCellProps {
  property: DatabaseProperty | null; value: CellValue; label: string;
  /** `base` is the value the cell showed when this edit began, so a change made elsewhere meanwhile is noticed for this cell only. */
  onSave: (value: CellValue, base: CellValue) => Promise<unknown>; onReload: () => void;
  tabIndex?: number; rowIndex?: number; columnIndex?: number; onFocus?: () => void; emptyLabel?: string;
}
export function EditableCell(props: EditableCellProps) {
  const { canEditRows } = useDatabaseAccess();
  if (!canEditRows) return <StaticCell {...props} />;
  if (!props.property || ['text', 'number', 'url'].includes(props.property.type)) return <InlineCell {...props} />;
  if (props.property.type === 'checkbox') return <CheckboxCell {...props} />;
  return <PopoverCell {...props} />;
}
/** The value only: for a reader who may not change rows. Keeps its place in the grid's keyboard navigation. */
function StaticCell({ property, value, label, tabIndex = 0, rowIndex, columnIndex, onFocus, emptyLabel }: EditableCellProps) {
  return <button type="button" role={rowIndex === undefined ? undefined : 'gridcell'} tabIndex={tabIndex} className="database-cell database-cell--static" aria-label={label} aria-readonly
    data-row={rowIndex} data-col={columnIndex} onFocus={onFocus}>{emptyLabel !== undefined && (value === null || value === '') ? emptyLabel : <CellDisplay property={property} value={value} />}</button>;
}
function CheckboxCell({ value, label, onSave, onReload, tabIndex = 0, rowIndex, columnIndex, onFocus }: EditableCellProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const busy = useRef(false);
  const toggle = async () => {
    if (busy.current || error) return;
    busy.current = true; setPending(true);
    try { await onSave(value !== true, value); }
    catch (error) { setError(error); }
    finally { busy.current = false; setPending(false); }
  };
  return <div className="database-inline-editor"><button type="button" role={rowIndex === undefined ? undefined : 'gridcell'} className="database-cell" aria-label={label} aria-pressed={value === true} aria-busy={pending} tabIndex={tabIndex} data-row={rowIndex} data-col={columnIndex} onFocus={onFocus} onClick={() => { void toggle(); }}>{value === true ? '☑' : '☐'}</button>
    {!!error && <div role="alert" className="database-cell-error">{errorText(error)}<Button mt="xs" size="compact-xs" onClick={() => { setError(null); onReload(); }}>重新載入資料</Button></div>}
  </div>;
}
function InlineCell({ property, value, label, onSave, onReload, tabIndex = 0, rowIndex, columnIndex, onFocus, emptyLabel }: EditableCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [base, setBase] = useState<CellValue>(value);
  const [original, setOriginal] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const busy = useRef(false);
  const composing = useRef(false);
  const cancelled = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef(false);
  useUpdateGuard(() => { if (editing && (draft !== original || pending)) throw new Error('請先儲存或取消資料格的修改，再更新。'); });
  useEffect(() => { if (!editing && focusAfter.current) { focusAfter.current = false; button.current?.focus(); } }, [editing]);
  const save = async (restoreFocus = false) => {
    if (busy.current || composing.current || cancelled.current) return;
    focusAfter.current = restoreFocus;
    if (draft === original) { setEditing(false); return; }
    const next = property?.type === 'number' && draft.trim() ? Number(draft) : draft || null;
    if (property && !valueSchema(property).safeParse(next).success) { setError(new Error('輸入值與欄位型別不符，請檢查後再儲存。')); return; }
    busy.current = true; setPending(true); setError(null);
    try { await onSave(next, base); setEditing(false); }
    catch (error) { setError(error); }
    finally { busy.current = false; setPending(false); }
  };
  if (!editing) return <button ref={button} type="button" role={rowIndex === undefined ? undefined : 'gridcell'} tabIndex={tabIndex} className="database-cell" aria-label={label}
    data-row={rowIndex} data-col={columnIndex} onFocus={onFocus} onClick={() => {
      const text = value === null ? '' : String(value);
      setDraft(text); setOriginal(text); setBase(value); setError(null); cancelled.current = false; setEditing(true);
    }}>{emptyLabel !== undefined && (value === null || value === '') ? emptyLabel : <CellDisplay property={property} value={value} />}</button>;
  return <div className="database-inline-editor" onKeyDown={event => event.stopPropagation()}>
    <input className="database-cell database-cell-input" aria-label={property?.name ?? '名稱'} value={draft} autoFocus disabled={pending}
      maxLength={property ? 2000 : 500} inputMode={property?.type === 'number' ? 'decimal' : undefined}
      onChange={event => setDraft(event.currentTarget.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onBlur={() => { if (!error) void save(); }} onKeyDown={event => {
        if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
        if (event.key === 'Enter') { event.preventDefault(); void save(true); }
        if (event.key === 'Escape' && !busy.current) { cancelled.current = true; focusAfter.current = true; setEditing(false); }
      }} />
    {!!error && <div className="database-cell-error" role="alert"><span>{errorText(error)}</span><Group gap="xs" mt="xs">
      {!isApiError(error, 409) && <Button size="compact-xs" onMouseDown={event => event.preventDefault()} onClick={() => { void save(); }}>重試儲存</Button>}
      <Button size="compact-xs" variant="default" onMouseDown={event => event.preventDefault()} onClick={() => { cancelled.current = true; setEditing(false); onReload(); }}>重新載入並捨棄草稿</Button>
    </Group></div>}
  </div>;
}
function PopoverCell({ property, value, label, onSave, onReload, tabIndex = 0, rowIndex, columnIndex, onFocus, emptyLabel }: EditableCellProps) {
  const [opened, setOpened] = useState(false);
  const [draft, setDraft] = useState<CellValue>(value);
  const [base, setBase] = useState<CellValue>(value);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [composing, setComposing] = useState(false);
  useUpdateGuard(() => { if (opened && (JSON.stringify(draft) !== JSON.stringify(value) || pending)) throw new Error('請先儲存或取消資料格的修改，再更新。'); });
  const save = async () => {
    if (pending || composing) return;
    setPending(true); setError(null);
    try {
      const value = property?.type === 'number' && typeof draft === 'string' && draft.trim() ? Number(draft) : draft;
      if (property && !valueSchema(property).safeParse(value).success) throw new Error('輸入值與欄位型別不符，請檢查後再儲存。');
      await onSave(value, base); setOpened(false);
    } catch (error) { setError(error); } finally { setPending(false); }
  };
  return <Popover opened={opened} onChange={next => { if (!pending) setOpened(next); }} position="bottom-start" width={320} shadow="md" trapFocus withinPortal closeOnEscape={!composing && !pending}>
    <Popover.Target><button type="button" role={rowIndex === undefined ? undefined : 'gridcell'} tabIndex={tabIndex} className="database-cell" aria-label={label}
      data-row={rowIndex} data-col={columnIndex} onFocus={onFocus}
      onClick={() => { setDraft(value); setBase(value); setError(null); setOpened(true); }}>{emptyLabel !== undefined && (value === null || value === '') ? emptyLabel : <CellDisplay property={property} value={value} />}</button></Popover.Target>
    <Popover.Dropdown><form onSubmit={event => { event.preventDefault(); void save(); }} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}>
      <Stack gap="sm">
        <CellValueInput property={property} label={property?.name ?? '名稱'} value={draft} onChange={setDraft} autoFocus />
        {!!error && <Alert color="red" role="alert">{errorText(error)}{isApiError(error, 409) && <Button mt="xs" size="compact-xs" variant="white" onClick={() => { setOpened(false); onReload(); }}>重新載入並捨棄草稿</Button>}</Alert>}
        <Group justify="space-between"><Button size="compact-xs" variant="subtle" disabled={pending} onClick={() => setDraft(null)}>清除</Button>
          <Group gap="xs"><Button size="compact-xs" variant="default" disabled={pending} onClick={() => setOpened(false)}>取消</Button><Button size="compact-xs" type="submit" loading={pending}>儲存</Button></Group>
        </Group>
      </Stack>
    </form></Popover.Dropdown>
  </Popover>;
}
