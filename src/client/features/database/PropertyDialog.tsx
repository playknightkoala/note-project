import { useState } from 'react';
import { ActionIcon, Alert, Button, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { Plus, Trash2 } from 'lucide-react';
import { CHOICE_COLORS, CURRENCIES, PROPERTY_TYPES, currencyConversionSchema, currencyLabels, currencySchema, propertyLabels } from '@shared/database';
import type { DatabaseDto, DatabaseProperty, PropertyChoice, PropertyType } from '@shared/database';
import { useDatabaseSchema } from '../../api/databases.ts';
import { errorText, isApiError } from '../../api/client.ts';
import { newId } from '@shared/ids';
import { useUpdateGuard } from '../../updates/guards.ts';

type FieldType = PropertyType | 'amount' | 'currency';
const fieldTypes = PROPERTY_TYPES.flatMap(value => value === 'number'
  ? [{ value, label: propertyLabels[value] }, { value: 'amount', label: '金額' }, { value: 'currency', label: '幣值換算' }]
  : [{ value, label: propertyLabels[value] }]);
const currencies = CURRENCIES.map(value => ({ value, label: currencyLabels[value] }));
const colors = ['灰', '棕', '橙', '黃', '綠', '藍', '紫', '粉紅', '紅'];
export function PropertyDialog({ meta, property, onClose, onReload }: { meta: DatabaseDto; property: DatabaseProperty | null; onClose: () => void; onReload: () => void }) {
  const [name, setName] = useState(property?.name ?? '');
  const [type, setType] = useState<FieldType>(property?.currencyConversion ? 'currency' : property?.groupThousands ? 'amount' : property?.type ?? 'text');
  const [from, setFrom] = useState(property?.currencyConversion?.from);
  const [to, setTo] = useState(property?.currencyConversion?.to);
  const [rate, setRate] = useState(property?.currencyConversion ? String(property.currencyConversion.rate) : '');
  const [reverse, setReverse] = useState(false);
  const parsedRate = Number(rate);
  const reciprocal = Number.isFinite(1 / parsedRate) && parsedRate > 0 ? String(Number((1 / parsedRate).toPrecision(12))) : '';
  const conversion = currencyConversionSchema.safeParse({ from, to, rate: reverse ? 1 / parsedRate : parsedRate });
  const [choices, setChoices] = useState<PropertyChoice[]>(property?.choices ?? []);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [baseVersion] = useState(meta.version);
  const mutation = useDatabaseSchema(meta.id);
  useUpdateGuard(() => { throw new Error('請先儲存或關閉欄位設定，再更新。'); });
  const select = type === 'select' || type === 'multi_select';
  const save = () => {
    if (type === 'currency' && !conversion.success) return;
    const input = {
      name, type: type === 'amount' || type === 'currency' ? 'number' as const : type,
      groupThousands: type === 'amount', currencyConversion: type === 'currency' ? conversion.data! : null,
      choices: select ? choices : [],
    };
    mutation.mutate(property ? { action: 'update', id: property.id, input, version: baseVersion } : { action: 'add', input, version: baseVersion }, { onSuccess: onClose });
  };
  return <Modal opened onClose={() => { if (!mutation.isPending) onClose(); }} title={property ? '編輯欄位' : '新增欄位'} closeButtonProps={{ 'aria-label': '關閉欄位編輯' }}>
    <form onSubmit={event => { event.preventDefault(); save(); }}><Stack gap="md">
      <TextInput label="欄位名稱" value={name} onChange={e => setName(e.currentTarget.value)} maxLength={80} required data-autofocus />
      <Select label="欄位型別" data={fieldTypes} value={type} onChange={value => { if (value) setType(value as FieldType); }} allowDeselect={false} />
      {type === 'currency' && <>
        <Select label="基準幣別" data={currencies.filter(option => option.value !== to)} value={from ?? null}
          onChange={value => setFrom(currencySchema.safeParse(value).data)} required />
        <Select label="換算幣別" data={currencies.filter(option => option.value !== from)} value={to ?? null}
          onChange={value => setTo(currencySchema.safeParse(value).data)} required />
        {from && to && <>
          <TextInput label={`1 ${from} 可換多少 ${to}`} inputMode="decimal" value={reverse ? reciprocal : rate}
            onChange={event => { setReverse(false); setRate(event.currentTarget.value); }} />
          <TextInput label={`1 ${to} 可換多少 ${from}`} inputMode="decimal" value={reverse ? rate : reciprocal}
            onChange={event => { setReverse(true); setRate(event.currentTarget.value); }} />
          <Text size="xs" c="dimmed">填寫任一方向的匯率，另一方向會自動換算。</Text>
        </>}
      </>}
      {property && type !== 'currency' && <Text size="xs" c="dimmed">數字與金額可直接互換。其他型別須先清空資料才能變更。</Text>}
      {select && <Stack gap="xs"><Text size="sm" fw={500}>選項</Text>{choices.map((choice, index) => <Group key={choice.id} gap="xs" wrap="nowrap">
        <TextInput aria-label={`選項 ${index + 1} 名稱`} value={choice.label} required maxLength={80} onChange={e => { const label = e.currentTarget.value; setChoices(current => current.map(item => item.id === choice.id ? { ...item, label } : item)); }} style={{ flex: 1 }} />
        <Select aria-label={`選項 ${index + 1} 顏色`} data={CHOICE_COLORS.map((value, i) => ({ value, label: colors[i]! }))} value={choice.color} w={92} allowDeselect={false} onChange={color => { if (color) setChoices(current => current.map(item => item.id === choice.id ? { ...item, color: color as PropertyChoice['color'] } : item)); }} />
        <ActionIcon aria-label={`移除選項 ${index + 1}`} color="red" variant="subtle" onClick={() => setChoices(current => current.filter(item => item.id !== choice.id))}><Trash2 size={16} /></ActionIcon>
      </Group>)}<Button size="compact-xs" variant="subtle" leftSection={<Plus size={14} />} onClick={() => setChoices(current => [...current, { id: newId(), label: '', color: 'gray' }])} disabled={choices.length >= 100}>新增選項</Button></Stack>}
      {mutation.error && <Alert color="red">{errorText(mutation.error)}{isApiError(mutation.error, 409) && <Button size="compact-xs" mt="xs" variant="white" onClick={() => { onClose(); onReload(); }}>重新載入資料</Button>}</Alert>}
      {confirmDelete && property && <Alert color="red" title="刪除欄位？"><Text size="sm">所有資料列的「{property.name}」資料與相關排序、篩選會一併移除，無法還原。</Text><Group mt="sm"><Button color="red" size="xs" loading={mutation.isPending} onClick={() => mutation.mutate({ action: 'delete', id: property.id, version: baseVersion }, { onSuccess: onClose })}>確認刪除此欄位</Button><Button size="xs" variant="default" onClick={() => setConfirmDelete(false)}>保留欄位</Button></Group></Alert>}
      <Group justify="space-between">{property ? <Button color="red" variant="subtle" onClick={() => setConfirmDelete(true)}>刪除欄位</Button> : <span />}
        <Button type="submit" loading={mutation.isPending} disabled={!name.trim() || (type === 'currency' && !conversion.success)}>儲存欄位</Button></Group>
    </Stack></form>
  </Modal>;
}
