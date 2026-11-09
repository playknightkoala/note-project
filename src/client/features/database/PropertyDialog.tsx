import { useState } from 'react';
import { ActionIcon, Alert, Button, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { Plus, Trash2 } from 'lucide-react';
import { CHOICE_COLORS, PROPERTY_TYPES, propertyLabels } from '@shared/database';
import type { DatabaseDto, DatabaseProperty, PropertyChoice, PropertyType } from '@shared/database';
import { useDatabaseSchema } from '../../api/databases.ts';
import { errorText, isApiError } from '../../api/client.ts';
import { newId } from '@shared/ids';
import { useUpdateGuard } from '../../updates/guards.ts';

const colors = ['灰', '棕', '橙', '黃', '綠', '藍', '紫', '粉紅', '紅'];
export function PropertyDialog({ meta, property, onClose, onReload }: { meta: DatabaseDto; property: DatabaseProperty | null; onClose: () => void; onReload: () => void }) {
  const [name, setName] = useState(property?.name ?? '');
  const [type, setType] = useState<PropertyType>(property?.type ?? 'text');
  const [choices, setChoices] = useState<PropertyChoice[]>(property?.choices ?? []);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [baseVersion] = useState(meta.version);
  const mutation = useDatabaseSchema(meta.id);
  useUpdateGuard(() => { throw new Error('請先儲存或關閉欄位設定，再更新。'); });
  const select = type === 'select' || type === 'multi_select';
  const save = () => {
    const input = { name, type, choices: select ? choices : [] };
    mutation.mutate(property ? { action: 'update', id: property.id, input, version: baseVersion } : { action: 'add', input, version: baseVersion }, { onSuccess: onClose });
  };
  return <Modal opened onClose={() => { if (!mutation.isPending) onClose(); }} title={property ? '編輯欄位' : '新增欄位'} closeButtonProps={{ 'aria-label': '關閉欄位編輯' }}>
    <form onSubmit={event => { event.preventDefault(); save(); }}><Stack gap="md">
      <TextInput label="欄位名稱" value={name} onChange={e => setName(e.currentTarget.value)} maxLength={80} required data-autofocus />
      <Select label="欄位型別" data={PROPERTY_TYPES.map(value => ({ value, label: propertyLabels[value] }))} value={type} onChange={value => { if (value) setType(value as PropertyType); }} allowDeselect={false} />
      {property && <Text size="xs" c="dimmed">已有資料的欄位須先清空，才能變更型別；仍被使用的選項無法移除。</Text>}
      {select && <Stack gap="xs"><Text size="sm" fw={500}>選項</Text>{choices.map((choice, index) => <Group key={choice.id} gap="xs" wrap="nowrap">
        <TextInput aria-label={`選項 ${index + 1} 名稱`} value={choice.label} required maxLength={80} onChange={e => { const label = e.currentTarget.value; setChoices(current => current.map(item => item.id === choice.id ? { ...item, label } : item)); }} style={{ flex: 1 }} />
        <Select aria-label={`選項 ${index + 1} 顏色`} data={CHOICE_COLORS.map((value, i) => ({ value, label: colors[i]! }))} value={choice.color} w={92} allowDeselect={false} onChange={color => { if (color) setChoices(current => current.map(item => item.id === choice.id ? { ...item, color: color as PropertyChoice['color'] } : item)); }} />
        <ActionIcon aria-label={`移除選項 ${index + 1}`} color="red" variant="subtle" onClick={() => setChoices(current => current.filter(item => item.id !== choice.id))}><Trash2 size={16} /></ActionIcon>
      </Group>)}<Button size="compact-xs" variant="subtle" leftSection={<Plus size={14} />} onClick={() => setChoices(current => [...current, { id: newId(), label: '', color: 'gray' }])} disabled={choices.length >= 100}>新增選項</Button></Stack>}
      {mutation.error && <Alert color="red">{errorText(mutation.error)}{isApiError(mutation.error, 409) && <Button size="compact-xs" mt="xs" variant="white" onClick={() => { onClose(); onReload(); }}>重新載入資料</Button>}</Alert>}
      {confirmDelete && property && <Alert color="red" title="刪除欄位？"><Text size="sm">所有資料列的「{property.name}」資料與相關排序、篩選會一併移除，無法還原。</Text><Group mt="sm"><Button color="red" size="xs" loading={mutation.isPending} onClick={() => mutation.mutate({ action: 'delete', id: property.id, version: baseVersion }, { onSuccess: onClose })}>確認刪除此欄位</Button><Button size="xs" variant="default" onClick={() => setConfirmDelete(false)}>保留欄位</Button></Group></Alert>}
      <Group justify="space-between">{property ? <Button color="red" variant="subtle" onClick={() => setConfirmDelete(true)}>刪除欄位</Button> : <span />}
        <Button type="submit" loading={mutation.isPending} disabled={!name.trim()}>儲存欄位</Button></Group>
    </Stack></form>
  </Modal>;
}
