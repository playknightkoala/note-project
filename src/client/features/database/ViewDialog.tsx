import { useRef, useState } from 'react';
import { Alert, Button, Group, Modal, Select, Stack, Text, TextInput } from '@mantine/core';
import { VIEW_TYPES, viewLabels } from '@shared/database';
import type { DatabaseDto, DatabaseView, ViewType } from '@shared/database';
import { useDatabaseSchema } from '../../api/databases.ts';
import { errorText } from '../../api/client.ts';
import { useUpdateGuard } from '../../updates/guards.ts';

export function ViewDialog({ meta, view, onClose, onSelect }: { meta: DatabaseDto; view: DatabaseView | null; onClose: () => void; onSelect: (id: string) => void }) {
  const mutation = useDatabaseSchema(meta.id);
  const [version] = useState(meta.version);
  const [name, setName] = useState(view?.name ?? '清單');
  const [type, setType] = useState<ViewType>(view?.type ?? 'list');
  const [groupBy, setGroupBy] = useState<string | null>(view?.config.groupBy ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const composing = useRef(false);
  useUpdateGuard(() => { throw new Error('請先儲存或關閉視圖設定，再更新。'); });
  const groups = meta.properties.filter(property => property.type === 'select').map(property => ({ value: property.id, label: property.name }));
  const save = () => {
    const config = { ...(view?.config ?? { sorts: [], filters: [] }) };
    delete config.groupBy;
    if (type === 'board' && groupBy) config.groupBy = groupBy;
    mutation.mutate({ ...(view ? { action: 'view' as const, id: view.id } : { action: 'addView' as const }), input: { name, type, config }, version }, {
      onSuccess: next => { onSelect(view?.id ?? next.views.at(-1)!.id); onClose(); },
    });
  };
  return <Modal opened onClose={() => { if (!mutation.isPending) onClose(); }} title={view ? '編輯視圖' : '新增視圖'}>
    <form onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onSubmit={event => { event.preventDefault(); if (!composing.current) save(); }}><Stack>
      <TextInput label="視圖名稱" value={name} maxLength={80} required autoFocus onChange={event => setName(event.currentTarget.value)} />
      <Select label="視圖類型" value={type} allowDeselect={false} data={VIEW_TYPES.map(value => ({ value, label: viewLabels[value] }))} onChange={value => {
        if (!value) return; const next = value as ViewType; setType(next); if (!view && name === viewLabels[type]) setName(viewLabels[next]);
      }} />
      {type === 'board' && <><Select label="分組欄位" placeholder={view ? '請選擇單選欄位' : '自動選用或建立狀態欄位'} value={groupBy} data={groups} clearable onChange={setGroupBy} />
        {!view && !groupBy && <Text size="xs" c="dimmed">使用第一個單選欄位；沒有時建立「狀態」，包含尚未開始、進行中、已完成。既有資料保留在「未設定」群組。</Text>}</>}
      {mutation.error && <Alert color="red">{errorText(mutation.error)}<Text size="xs">若資料已更新，請關閉視窗並重新載入後再操作。</Text></Alert>}
      {confirmDelete && view && <Alert color="red" title="刪除此視圖？">只移除呈現設定，資料列仍會保留。<Button mt="xs" color="red" loading={mutation.isPending} onClick={() => mutation.mutate({ action: 'deleteView', id: view.id, version }, { onSuccess: next => { onSelect(next.views[0]!.id); onClose(); } })}>確認刪除視圖</Button></Alert>}
      <Group justify="space-between">{view && <Button color="red" variant="subtle" disabled={meta.views.length <= 1 || mutation.isPending} onClick={() => setConfirmDelete(true)}>刪除視圖</Button>}
        <Button type="submit" loading={mutation.isPending} disabled={!name.trim() || (type === 'board' && !!view && !groupBy)}>儲存視圖</Button></Group>
    </Stack></form>
  </Modal>;
}
