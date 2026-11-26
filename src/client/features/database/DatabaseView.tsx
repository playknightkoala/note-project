import { useCallback, useState } from 'react';
import { ActionIcon, Alert, Button, Center, Checkbox, Group, Loader, Popover, Stack, Text, Tooltip } from '@mantine/core';
import { ArrowDownUp, Columns3, Filter, Plus, RefreshCw, Table2, List, Kanban, Settings2 } from 'lucide-react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { DatabaseProperty, DatabaseRow, DatabaseView as View, ViewConfig, CellValue, DatabaseFilter } from '@shared/database';
import { useAddRow, useDatabase, useDatabaseRows, useDatabaseSchema, useDatabaseSync, useUpdateRow, databaseKeys } from '../../api/databases.ts';
import type { LoadedDatabase } from '../../api/databases.ts';
import { errorText } from '../../api/client.ts';
import { useTrashPage } from '../../api/pages.ts';
import { DataGrid } from './DataGrid.tsx';
import { PropertyDialog } from './PropertyDialog.tsx';
import { RulesDialog } from './RulesDialog.tsx';
import { readViewParams, writeViewParams } from './viewParams.ts';
import { ColumnTotalsDialog } from './ColumnTotalsDialog.tsx';
import { ViewDialog } from './ViewDialog.tsx';
import { BoardView, ListView } from './CollectionViews.tsx';
import { useDatabaseAccess } from './access.ts';

export function DatabaseView({ databaseId }: { databaseId: string }) {
  useDatabaseSync(databaseId);
  const query = useDatabase(databaseId);
  if (query.isPending) return <Center p="xl"><Loader size="sm" /></Center>;
  if (query.error || !query.data) return <Alert color="red" title="無法載入資料庫">{errorText(query.error)}<Button mt="sm" size="xs" onClick={() => { void query.refetch(); }}>重試</Button></Alert>;
  return <DatabaseContent key={databaseId} meta={query.data} />;
}
function DatabaseContent({ meta }: { meta: LoadedDatabase }) {
  const [params, setParams] = useSearchParams();
  const client = useQueryClient();
  const access = useDatabaseAccess();
  const view = meta.views.find(view => view.id === params.get('view')) ?? meta.views[0];
  const schema = useDatabaseSchema(meta.id);
  const pending = schema.isPending ? schema.variables : undefined;
  const pendingConfig = pending?.action === 'view' && pending.id === view?.id ? pending.input.config : undefined;
  const fallback = pendingConfig ?? view?.config ?? { sorts: [], filters: [] };
  const { config, error } = readViewParams(params, fallback, meta.properties);
  const rows = useDatabaseRows(meta.id, meta.version, config, !error, meta.local);
  const create = useAddRow(meta.id);
  const update = useUpdateRow();
  const trash = useTrashPage();
  const [property, setProperty] = useState<DatabaseProperty | null | undefined>();
  const [rules, setRules] = useState<{ mode: 'sort' | 'filter'; version: number } | null>(null);
  const [columnFilter, setColumnFilter] = useState<DatabaseFilter | null>(null);
  const [totalsOpen, setTotalsOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [viewDialog, setViewDialog] = useState<View | null | undefined>();
  const [notice, setNotice] = useState('');
  const hasOverride = params.has('sort') || params.has('filter') || params.has('columns');
  const apply = (next: ViewConfig, field: 'sorts' | 'filters' | 'columns', version = meta.version) => {
    if (!access.canManage) {
      setParams(writeViewParams(params, next), { replace: true });
      return;
    }
    if (!view || schema.isPending) return;
    // A bookmarked URL may contain someone else's temporary settings. Persist only the control edited here.
    const key = { sorts: 'sort', filters: 'filter', columns: 'columns' }[field];
    if (params.has(key)) {
      const remaining = new URLSearchParams(params);
      remaining.delete(key);
      setParams(remaining, { replace: true });
    }
    if (JSON.stringify(view.config[field]) === JSON.stringify(next[field])) return;
    schema.mutate({ action: 'view', id: view.id, version, input: { name: view.name, config: { ...view.config, [field]: next[field] } } });
  };
  const clearOverrides = (viewId?: string) => {
    const next = new URLSearchParams(params);
    for (const key of ['sort', 'filter', 'columns']) next.delete(key);
    if (viewId) next.set('view', viewId);
    setParams(next, { replace: true });
  };
  const selectView = (id: string) => { clearOverrides(id); setAdding(false); };
  const reset = () => clearOverrides();
  const reload = () => { update.reset(); void Promise.all([client.invalidateQueries({ queryKey: databaseKeys.meta(meta.id) }), client.invalidateQueries({ queryKey: databaseKeys.rows(meta.id) })]); };
  const onMore = useCallback(() => { void rows.fetchNextPage(); }, [rows.fetchNextPage]);
  const saveCell = (row: DatabaseRow, propertyId: string, value: CellValue, base: CellValue) => update.mutateAsync({ id: row.id, databaseId: meta.id,
    ...(propertyId === 'title' ? { title: { base: typeof base === 'string' ? base : '', value: typeof value === 'string' ? value : '' } } : { values: { [propertyId]: { base, value } } }) });
  const moveProperty = (propertyId: string, index: number) => {
    schema.mutate({ action: 'move', id: propertyId, index, version: meta.version });
  };
  const data = rows.data?.pages.flatMap(page => page.rows) ?? [];
  const total = rows.data?.pages[0]?.total ?? 0;
  const createRow = async (title: string, values: Record<string, CellValue>) => {
    await create.mutateAsync({ title, values });
    setNotice(config.filters.length ? '已新增資料列；若不符合目前篩選，請清除篩選後查看。' : '已新增資料列。');
  };
  const collectionProps = { rows: data, properties: meta.properties, config, onSave: saveCell, onCreate: createRow, onTrash: (row: DatabaseRow) => trash.mutate({ id: row.id }, { onSuccess: () => { void client.invalidateQueries({ queryKey: databaseKeys.rows(meta.id) }); } }), onReload: reload, adding, onCloseAdd: () => setAdding(false) };
  const icons = { table: Table2, list: List, board: Kanban };
  return <div className="database-view">
    <Group justify="space-between" gap="sm" className="database-toolbar">
      <Group gap={4} className="database-view-tabs" role="tablist" aria-label="資料庫視圖" onKeyDown={event => {
        const index = meta.views.findIndex(item => item.id === view?.id);
        const next = event.key === 'ArrowRight' ? (index + 1) % meta.views.length : event.key === 'ArrowLeft' ? (index - 1 + meta.views.length) % meta.views.length : event.key === 'Home' ? 0 : event.key === 'End' ? meta.views.length - 1 : -1;
        if (next < 0 || (event.target as HTMLElement).getAttribute('role') !== 'tab') return;
        event.preventDefault(); const id = meta.views[next]!.id; selectView(id); document.getElementById(`view-tab-${id}`)?.focus();
      }}>{meta.views.map(item => { const Icon = icons[item.type]; return <Button key={item.id} role="tab" tabIndex={view?.id === item.id ? 0 : -1} aria-selected={view?.id === item.id} aria-controls={`view-panel-${item.id}`} id={`view-tab-${item.id}`} variant={view?.id === item.id ? 'light' : 'subtle'} color="gray" size="compact-sm" className="database-view-tab" leftSection={<Icon size={15} />} onClick={() => selectView(item.id)}>{item.name}</Button>; })}
        {access.canManage && <ActionIcon variant="subtle" color="gray" aria-label="新增視圖" disabled={schema.isPending || meta.views.length >= 20} onClick={() => setViewDialog(null)}><Plus size={16} /></ActionIcon>}
      </Group>
      <Group gap="xs">
        {view?.type === 'table' && access.canManage && <Button size="compact-xs" variant="subtle" disabled={schema.isPending} onClick={() => setTotalsOpen(true)}>欄位加總</Button>}
        <Tooltip label={`排序${config.sorts.length ? `（${config.sorts.length}）` : ''}`}><ActionIcon color="gray" variant={config.sorts.length ? 'light' : 'subtle'} aria-label="排序" disabled={schema.isPending} onClick={() => setRules({ mode: 'sort', version: meta.version })}><ArrowDownUp size={15} /></ActionIcon></Tooltip>
        <Tooltip label={`篩選${config.filters.length ? `（${config.filters.length}）` : ''}`}><ActionIcon color="gray" variant={config.filters.length ? 'light' : 'subtle'} aria-label="篩選" disabled={schema.isPending} onClick={() => { setColumnFilter(null); setRules({ mode: 'filter', version: meta.version }); }}><Filter size={15} /></ActionIcon></Tooltip>
        <Popover position="bottom-end" shadow="md"><Popover.Target><ActionIcon color="gray" variant="subtle" aria-label="顯示欄位" title="顯示欄位"><Columns3 size={15} /></ActionIcon></Popover.Target><Popover.Dropdown><Stack gap="xs">
          <Text size="xs" c="dimmed">名稱欄固定顯示</Text>{meta.properties.map(p => <Checkbox disabled={schema.isPending} key={p.id} label={p.name} checked={!config.columns || config.columns.includes(p.id)} onChange={event => {
            const visible = config.columns ?? meta.properties.map(p => p.id);
            apply({ ...config, columns: event.currentTarget.checked ? [...visible.filter(id => id !== p.id), p.id] : visible.filter(id => id !== p.id) }, 'columns');
          }} />)}<Button size="compact-xs" variant="subtle" disabled={schema.isPending} onClick={() => apply({ ...config, columns: meta.properties.map(p => p.id) }, 'columns')}>顯示全部</Button>
        </Stack></Popover.Dropdown></Popover>
        {view && access.canManage && <Tooltip label="編輯視圖"><ActionIcon variant="subtle" color="gray" aria-label="編輯視圖" disabled={schema.isPending} onClick={() => setViewDialog(view)}><Settings2 size={15} /></ActionIcon></Tooltip>}
        {view?.type !== 'table' && access.canManage && <Tooltip label="新增屬性"><ActionIcon variant="subtle" color="gray" aria-label="新增屬性" disabled={schema.isPending} onClick={() => setProperty(null)}><Plus size={15} /></ActionIcon></Tooltip>}
        <Tooltip label="重新載入"><ActionIcon variant="subtle" color="gray" aria-label="重新載入" loading={rows.isFetching} onClick={reload}><RefreshCw size={15} /></ActionIcon></Tooltip>
        {access.canEditRows && <Button size="compact-xs" leftSection={<Plus size={14} />} onClick={() => { create.reset(); setAdding(true); }}>新增</Button>}
      </Group>
    </Group>
    {hasOverride && <Group gap="xs" mb="xs"><Text size="xs" c="dimmed">網址中的顯示條件只套用在你的畫面。</Text><Button size="compact-xs" variant="subtle" onClick={reset}>還原已儲存視圖</Button></Group>}
    {meta.local && <Text size="xs" c="orange" mb="xs" role="status">目前顯示此裝置上的副本；修改已存此裝置，連線後自動同步。移至垃圾桶需要連線。</Text>}
    {pendingConfig && <Text size="xs" c="dimmed" mb="sm" role="status">正在儲存視圖…</Text>}
    {notice && <Text size="xs" c="dimmed" mb="xs" role="status">{notice}</Text>}
    {(error || rows.error || schema.error || trash.error || update.error) && <Alert color="red" mb="sm">{error ?? errorText(rows.error ?? schema.error ?? trash.error ?? update.error)}<Group mt="xs"><Button size="compact-xs" variant="white" onClick={() => { schema.reset(); reload(); }}>重新載入資料</Button>{hasOverride && <Button size="compact-xs" variant="white" onClick={reset}>重設視圖</Button>}</Group></Alert>}
    <div role="tabpanel" id={`view-panel-${view?.id}`} aria-labelledby={`view-tab-${view?.id}`} key={view?.id}>
    {rows.isPending && !error ? <Center p="xl"><Loader size="sm" /></Center> : !error && (view?.type === 'list' ? <ListView {...collectionProps} /> : view?.type === 'board' ? <BoardView {...collectionProps} moving={update.isPending} onMove={(row, groupBy, choice) => update.mutate({ id: row.id, databaseId: meta.id, values: { [groupBy]: { base: row.values[groupBy] ?? null, value: choice } } })} /> : <DataGrid databaseId={meta.id} properties={meta.properties} rows={data} total={total} config={config} totals={rows.isPlaceholderData || rows.isError ? undefined : rows.data?.pages[0]?.totals}
      onSave={saveCell} onReload={reload} onEditProperty={setProperty} onConfig={apply} onMoveProperty={moveProperty} schemaPending={schema.isPending}
      onFilter={property => {
        setColumnFilter({ propertyId: property?.id ?? 'title', operator: property?.type === 'checkbox' ? 'equals' : 'is_not_empty', value: property?.type === 'checkbox' ? true : null });
        setRules({ mode: 'filter', version: meta.version });
      }}
      onTrash={row => trash.mutate({ id: row.id }, { onSuccess: () => { void client.invalidateQueries({ queryKey: databaseKeys.rows(meta.id) }); } })}
      onCreate={createRow} onAddProperty={() => setProperty(null)} adding={adding} onCloseAdd={() => setAdding(false)}
      hasMore={!!rows.hasNextPage} loadingMore={rows.isFetchingNextPage} onMore={onMore} />)}
    </div>
    {view?.type !== 'table' && rows.hasNextPage && <Button mt="sm" variant="subtle" size="xs" loading={rows.isFetchingNextPage} onClick={onMore}>載入更多資料列</Button>}
    <Text size="xs" c="dimmed" mt="xs">{data.length < total ? `已載入 ${data.length}／${total} 列；看板計數為已載入數量。` : `${total} 列`}{view?.type === 'table' && (access.canEditRows ? ' · 方向鍵移動 · Enter 編輯／儲存 · Alt+Enter 開啟頁面' : ' · 方向鍵移動 · Alt+Enter 開啟頁面')}{view?.type === 'board' && access.canEditRows && ' · 拖曳把手移組，或使用卡片選單'}</Text>
    {property !== undefined && <PropertyDialog meta={meta} property={property} onClose={() => setProperty(undefined)} onReload={reload} />}
    {rules && <RulesDialog mode={rules.mode} properties={meta.properties} config={rules.mode === 'filter' && columnFilter ? { ...config, filters: [...config.filters.filter(filter => filter.propertyId !== columnFilter.propertyId), columnFilter] } : config} onApply={next => apply(next, rules.mode === 'filter' ? 'filters' : 'sorts', rules.version)} onClose={() => { setRules(null); setColumnFilter(null); }} />}
    {totalsOpen && view && <ColumnTotalsDialog meta={meta} view={view} onClose={() => setTotalsOpen(false)} />}
    {viewDialog !== undefined && <ViewDialog meta={meta} view={viewDialog} onClose={() => setViewDialog(undefined)} onSelect={selectView} />}
  </div>;
}
