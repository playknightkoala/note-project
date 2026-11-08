import { Alert, Anchor, Button, Loader, Stack, Text } from '@mantine/core';
import { Link } from 'react-router';
import { useDatabase, useDatabaseRow, useUpdateRow } from '../../api/databases.ts';
import { errorText } from '../../api/client.ts';
import { EditableCell } from './EditableCell.tsx';

export function RowPropertiesPanel({ rowId, databaseId }: { rowId: string; databaseId: string }) {
  const meta = useDatabase(databaseId);
  const row = useDatabaseRow(rowId);
  const update = useUpdateRow();
  const reload = () => { void meta.refetch(); void row.refetch(); };
  return <Stack gap="xs" className="row-properties">
    <Anchor component={Link} to={`/p/${databaseId}`} size="sm">← 返回資料庫</Anchor>
    {(meta.isPending || row.isPending) && <Loader size="xs" />}
    {(meta.error || row.error) && <Alert color="red">{errorText(meta.error ?? row.error)}<Button size="compact-xs" onClick={reload}>重試</Button></Alert>}
    {meta.data && row.data && <>
      {meta.data.properties.length === 0 && <Text size="sm" c="dimmed">尚未設定屬性，可回資料庫新增欄位。</Text>}
      {meta.data.properties.map(property => <div className="row-property" key={property.id}>
        <Text size="sm" c="dimmed" className="row-property__name">{property.name}</Text>
        <EditableCell property={property} value={row.data.values[property.id] ?? null} version={row.data.version} label={`屬性：${property.name}`} onReload={reload}
          onSave={(value, version) => update.mutateAsync({ id: rowId, version, values: { [property.id]: value } })} />
      </div>)}
    </>}
  </Stack>;
}
