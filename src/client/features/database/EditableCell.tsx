import { useState } from 'react';
import { Alert, Button, Group, Popover, Stack } from '@mantine/core';
import type { CellValue, DatabaseProperty } from '@shared/database';
import { valueSchema } from '@shared/database';
import { errorText, isApiError } from '../../api/client.ts';
import { CellDisplay, CellValueInput } from './CellValueInput.tsx';

export function EditableCell({ property, value, version, label, onSave, onReload, tabIndex = 0, rowIndex, columnIndex, onFocus }: {
  property: DatabaseProperty | null; value: CellValue; version: number; label: string; onSave: (value: CellValue, version: number) => Promise<unknown>; onReload: () => void;
  tabIndex?: number; rowIndex?: number; columnIndex?: number; onFocus?: () => void;
}) {
  const [opened, setOpened] = useState(false);
  const [draft, setDraft] = useState<CellValue>(value);
  const [baseVersion, setBaseVersion] = useState(version);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [composing, setComposing] = useState(false);
  const save = async () => {
    if (pending || composing) return;
    setPending(true); setError(null);
    try {
      const value = property?.type === 'number' && typeof draft === 'string' && draft.trim() ? Number(draft) : draft;
      if (property && !valueSchema(property).safeParse(value).success) throw new Error('輸入值與欄位型別不符，請檢查後再儲存。');
      await onSave(value, baseVersion); setOpened(false);
    } catch (error) { setError(error); } finally { setPending(false); }
  };
  return <Popover opened={opened} onChange={next => { if (!pending) setOpened(next); }} position="bottom-start" width={320} shadow="md" trapFocus withinPortal closeOnEscape={!composing && !pending}>
    <Popover.Target><button type="button" role={rowIndex === undefined ? undefined : 'gridcell'} tabIndex={tabIndex} className="database-cell" aria-label={label}
      data-row={rowIndex} data-col={columnIndex} onFocus={onFocus}
      onClick={() => { setDraft(value); setBaseVersion(version); setError(null); setOpened(true); }}>{<CellDisplay property={property} value={value} />}</button></Popover.Target>
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
