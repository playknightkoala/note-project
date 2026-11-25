import { useState } from 'react';
import { Alert, Button, Checkbox, Group, Modal, Stack, Text } from '@mantine/core';
import { canSumColumn } from '@shared/database';
import type { DatabaseDto, DatabaseView } from '@shared/database';
import { useDatabaseSchema } from '../../api/databases.ts';
import { errorText } from '../../api/client.ts';
import { useUpdateGuard } from '../../updates/guards.ts';

export function ColumnTotalsDialog({ meta, view, onClose, onSaved }: { meta: DatabaseDto; view: DatabaseView; onClose: () => void; onSaved: (from: number, to: number) => void }) {
  const [version] = useState(meta.version);
  const [selected, setSelected] = useState(view.config.sumColumns ?? []);
  const columns = meta.properties.filter(canSumColumn);
  const mutation = useDatabaseSchema(meta.id);
  useUpdateGuard(() => { throw new Error('請先儲存或關閉欄位加總設定。'); });

  return <Modal opened title="欄位加總" onClose={() => { if (!mutation.isPending) onClose(); }}>
    <Stack>
      {columns.length ? <Text size="sm">加總目前篩選條件下的所有資料列。</Text>
        : <Text size="sm">新增數字或金額欄位後，就能設定加總。</Text>}
      <Checkbox.Group value={selected} onChange={setSelected}>
        <Stack gap="sm">{columns.map(column => <Checkbox key={column.id} value={column.id} label={column.name} />)}</Stack>
      </Checkbox.Group>
      {mutation.error && <Alert color="red">{errorText(mutation.error)}</Alert>}
      <Group justify="flex-end">
        <Button variant="default" disabled={mutation.isPending} onClick={onClose}>取消</Button>
        <Button loading={mutation.isPending} disabled={!columns.length} onClick={() => {
          mutation.mutate({ action: 'view', id: view.id, version, input: { name: view.name, config: { ...view.config, sumColumns: selected } } }, { onSuccess: result => { onSaved(version, result.version); onClose(); } });
        }}>儲存</Button>
      </Group>
    </Stack>
  </Modal>;
}
