import { useCallback, useEffect, useState } from 'react';
import { Alert, Anchor, Button, Center, Checkbox, Group, Loader, Modal, Popover, Stack, Text, TextInput } from '@mantine/core';
import { ArrowDownUp, Columns3, Filter, Plus, RefreshCw, Save } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { DatabaseDto, DatabaseProperty, DatabaseRow, ViewConfig, CellValue, DatabaseFilter } from '@shared/database';
import { useAddRow, useDatabase, useDatabaseRows, useDatabaseSchema, useUpdateRow, databaseKeys } from '../../api/databases.ts';
import { errorText } from '../../api/client.ts';
import { useTrashPage } from '../../api/pages.ts';
import { DataGrid } from './DataGrid.tsx';
import { PropertyDialog } from './PropertyDialog.tsx';
import { RulesDialog } from './RulesDialog.tsx';
import { readViewParams, writeViewParams } from './viewParams.ts';

export function DatabaseView({ databaseId }: { databaseId: string }) {
  const query = useDatabase(databaseId);
  if (query.isPending) return <Center p="xl"><Loader size="sm" /></Center>;
  if (query.error || !query.data) return <Alert color="red" title="無法載入資料庫">{errorText(query.error)}<Button mt="sm" size="xs" onClick={() => { void query.refetch(); }}>重試</Button></Alert>;
  return <DatabaseContent meta={query.data} />;
}
function DatabaseContent({ meta }: { meta: DatabaseDto }) {
  const [params, setParams] = useSearchParams();
  const client = useQueryClient();
  const view = meta.views[0];
  const fallback = view?.config ?? { sorts: [], filters: [] };
  const { config, error } = readViewParams(params, fallback, meta.properties);
  const rows = useDatabaseRows(meta.id, meta.version, config, !error);
  const create = useAddRow(meta.id);
  const update = useUpdateRow();
  const schema = useDatabaseSchema(meta.id);
  const trash = useTrashPage();
  const [property, setProperty] = useState<DatabaseProperty | null | undefined>();
  const [rules, setRules] = useState<'sort' | 'filter' | null>(null);
  const [columnFilter, setColumnFilter] = useState<DatabaseFilter | null>(null);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [created, setCreated] = useState<DatabaseRow | null>(null);
  const [viewSaved, setViewSaved] = useState(false);
  const [viewVersion, setViewVersion] = useState(meta.version);
  const hasOverride = params.has('sort') || params.has('filter') || params.has('columns');
  useEffect(() => { if (!hasOverride) setViewVersion(meta.version); }, [hasOverride, meta.version]);
  const apply = (next: ViewConfig) => { if (!hasOverride) setViewVersion(meta.version); setViewSaved(false); setParams(writeViewParams(params, next), { replace: true }); };
  const reset = () => { const next = new URLSearchParams(params); for (const name of ['sort', 'filter', 'columns']) next.delete(name); setParams(next, { replace: true }); schema.reset(); setViewSaved(false); };
  const reload = () => { void Promise.all([client.invalidateQueries({ queryKey: databaseKeys.meta(meta.id) }), client.invalidateQueries({ queryKey: databaseKeys.rows(meta.id) })]); };
  const onMore = useCallback(() => { void rows.fetchNextPage(); }, [rows.fetchNextPage]);
  const saveCell = (row: DatabaseRow, propertyId: string, value: CellValue, version: number) => update.mutateAsync({ id: row.id, version,
    ...(propertyId === 'title' ? { title: typeof value === 'string' ? value : '', values: {} } : { values: { [propertyId]: value } }) });
  const data = rows.data?.pages.flatMap(page => page.rows) ?? [];
  const total = rows.data?.pages[0]?.total ?? 0;
  return <div className="database-view">
    <Group justify="space-between" gap="sm" className="database-toolbar">
      <Group gap="xs"><Text fw={600} size="sm">{view?.name ?? '表格'}</Text><Text size="xs" c="dimmed">{total} 列</Text></Group>
      <Group gap="xs">
        <Button size="compact-xs" variant={config.sorts.length ? 'light' : 'subtle'} leftSection={<ArrowDownUp size={14} />} onClick={() => setRules('sort')}>排序{config.sorts.length ? ` ${config.sorts.length}` : ''}</Button>
        <Button size="compact-xs" variant={config.filters.length ? 'light' : 'subtle'} leftSection={<Filter size={14} />} onClick={() => { setColumnFilter(null); setRules('filter'); }}>篩選{config.filters.length ? ` ${config.filters.length}` : ''}</Button>
        <Popover position="bottom-end" shadow="md"><Popover.Target><Button size="compact-xs" variant="subtle" leftSection={<Columns3 size={14} />}>顯示欄位</Button></Popover.Target><Popover.Dropdown><Stack gap="xs">
          <Text size="xs" c="dimmed">名稱欄固定顯示</Text>{meta.properties.map(p => <Checkbox key={p.id} label={p.name} checked={!config.columns || config.columns.includes(p.id)} onChange={event => {
            const visible = config.columns ?? meta.properties.map(p => p.id);
            apply({ ...config, columns: event.currentTarget.checked ? [...visible.filter(id => id !== p.id), p.id] : visible.filter(id => id !== p.id) });
          }} />)}<Button size="compact-xs" variant="subtle" onClick={() => apply({ ...config, columns: meta.properties.map(p => p.id) })}>顯示全部</Button>
        </Stack></Popover.Dropdown></Popover>
        <Button size="compact-xs" variant="subtle" leftSection={<Plus size={14} />} onClick={() => setProperty(null)}>新增欄位</Button>
        <Button size="compact-xs" variant="subtle" leftSection={<RefreshCw size={14} />} onClick={reload}>重新載入</Button>
        {view && <Button size="compact-xs" variant="light" leftSection={<Save size={14} />} disabled={!!error || !hasOverride} loading={schema.isPending} onClick={() => schema.mutate({ action: 'view', id: view.id, input: { name: view.name, config }, version: viewVersion }, { onSuccess: () => { reset(); setViewSaved(true); } })}>儲存視圖</Button>}
        <Button size="compact-xs" leftSection={<Plus size={14} />} onClick={() => { create.reset(); setNewTitle(''); setAdding(true); }}>新增資料列</Button>
      </Group>
    </Group>
    {hasOverride && <Group gap="xs" mb="xs"><Text size="xs" c="dimmed">目前條件尚未儲存為預設視圖，網址可保留這些條件。</Text><Button size="compact-xs" variant="subtle" onClick={reset}>還原已儲存視圖</Button></Group>}
    {viewSaved && <Text size="xs" c="green" mb="sm" role="status">視圖已儲存。</Text>}
    {created && <Alert color="blue" mb="sm" withCloseButton onClose={() => setCreated(null)}>已新增「{created.title || '無標題'}」。<Anchor component={Link} to={`/p/${created.id}`}>開啟資料列</Anchor>{config.filters.length > 0 && '（目前篩選可能隱藏此列。）'}</Alert>}
    {(error || rows.error || schema.error || trash.error) && <Alert color="red" mb="sm">{error ?? errorText(rows.error ?? schema.error ?? trash.error)}<Group mt="xs"><Button size="compact-xs" variant="white" onClick={() => { schema.reset(); reload(); }}>重新載入資料</Button><Button size="compact-xs" variant="white" onClick={reset}>重設視圖</Button></Group></Alert>}
    {rows.isPending && !error ? <Center p="xl"><Loader size="sm" /></Center> : !error && <DataGrid databaseId={meta.id} properties={meta.properties} rows={data} total={total} config={config}
      onSave={saveCell} onReload={reload} onEditProperty={setProperty} onConfig={apply}
      onFilter={property => {
        setColumnFilter({ propertyId: property?.id ?? 'title', operator: property?.type === 'checkbox' ? 'equals' : 'is_not_empty', value: property?.type === 'checkbox' ? true : null });
        setRules('filter');
      }}
      onTrash={row => trash.mutate({ id: row.id }, { onSuccess: () => { void client.invalidateQueries({ queryKey: databaseKeys.rows(meta.id) }); } })}
      hasMore={!!rows.hasNextPage} loadingMore={rows.isFetchingNextPage} onMore={onMore} />}
    <Text size="xs" c="dimmed" mt="xs">方向鍵移動儲存格 · Enter 編輯 · Alt+Enter 開啟列頁面</Text>
    {property !== undefined && <PropertyDialog meta={meta} property={property} onClose={() => setProperty(undefined)} onReload={reload} />}
    {rules && <RulesDialog mode={rules} properties={meta.properties} config={rules === 'filter' && columnFilter ? { ...config, filters: [...config.filters.filter(filter => filter.propertyId !== columnFilter.propertyId), columnFilter] } : config} onApply={apply} onClose={() => { setRules(null); setColumnFilter(null); }} />}
    <Modal opened={adding} onClose={() => { if (!create.isPending) setAdding(false); }} title="新增資料列" closeButtonProps={{ 'aria-label': '關閉新增資料列' }}>
      <form onSubmit={event => { event.preventDefault(); create.mutate({ title: newTitle, values: {}, version: meta.version }, { onSuccess: row => { setAdding(false); setCreated(row); } }); }}><Stack>
        <TextInput label="資料列名稱" value={newTitle} onChange={event => setNewTitle(event.currentTarget.value)} maxLength={500} data-autofocus />
        {create.error && <Alert color="red">{errorText(create.error)}</Alert>}
        <Button type="submit" loading={create.isPending}>建立資料列</Button>
      </Stack></form>
    </Modal>
  </div>;
}
