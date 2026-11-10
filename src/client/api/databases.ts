import { useEffect } from 'react';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CellValue, DatabaseDto, DatabaseRow, PropertyInput, RowsDto, ViewConfig, ViewInput } from '@shared/database';
import { evaluateRows, validateView } from '@shared/database';
import type { DatabaseSnapshotDto, OfflineOp } from '@shared/offline';
import { newId } from '@shared/ids';
import { ApiError, api } from './client.ts';
import { pageKeys } from './pages.ts';
import { hasQueued, localDatabase, OUTBOX_EVENT, storeDatabase, submitOp, transient } from '../offline/outbox.ts';
import { offlineOwner } from '../offline/owner.ts';
import { createLocalRow, dropLocalRow, renameLocalRow } from '../offline/notes.ts';

export const databaseKeys = {
  meta: (id: string) => ['database', id] as const,
  rows: (id: string) => ['database-rows', id] as const,
  row: (id: string) => ['database-row', id] as const,
};
/** `local`: shown from the copy on this device (offline, or while changes are waiting to be synced). */
export type LoadedDatabase = DatabaseDto & { local: boolean };
const NOT_DOWNLOADED = '此資料庫尚未下載至此裝置，連線後開啟一次即可離線使用。';

/** The copy on this device, downloading it first when there is none yet and the server can be reached. */
async function deviceCopy(id: string) {
  const view = await localDatabase(id);
  if (view) return view;
  const owner = offlineOwner();
  try {
    const snapshot = await api<DatabaseSnapshotDto>('GET', `/api/offline/databases/${id}`);
    // Stored without its stamp: the next sync then downloads it properly, row pages included.
    if (owner && offlineOwner() === owner) await storeDatabase(owner, { ...snapshot, stamp: '' });
  } catch (error) { if (!transient(error)) throw error; }
  const downloaded = await localDatabase(id);
  if (!downloaded) throw new ApiError(0, 'internal', NOT_DOWNLOADED);
  return downloaded;
}

/**
 * The server's answer while nothing is waiting for this database; otherwise (changes not yet synced, or no
 * connection) the copy on this device with those changes applied, so the user keeps seeing their own edits.
 */
async function loadDatabase(id: string): Promise<LoadedDatabase> {
  if (!await hasQueued(`db:${id}`)) {
    try { return { ...await api<DatabaseDto>('GET', `/api/databases/${id}`), local: false }; }
    catch (error) { if (!transient(error)) throw error; }
  }
  return { ...(await deviceCopy(id)).meta, local: true };
}
async function localRows(id: string, config: ViewConfig): Promise<RowsDto> {
  const view = await deviceCopy(id);
  const error = validateView(config, view.meta.properties);
  if (error) throw new ApiError(400, 'bad_request', error);
  const rows = evaluateRows(view.rows, view.meta.properties, config);
  return { rows, total: rows.length, offset: 0, limit: Math.max(rows.length, 1) };
}

/** Re-reads a database's queries when its waiting changes or its copy on this device change, and when the connection does. */
export function useDatabaseSync(id: string): void {
  const client = useQueryClient();
  useEffect(() => {
    const refresh = () => { for (const key of [databaseKeys.meta(id), databaseKeys.rows(id), ['database-row']]) void client.invalidateQueries({ queryKey: key }); };
    const changed = (event: Event) => { if ((event as CustomEvent<string>).detail === `db:${id}`) refresh(); };
    window.addEventListener(OUTBOX_EVENT, changed); window.addEventListener('online', refresh); window.addEventListener('offline', refresh);
    return () => { window.removeEventListener(OUTBOX_EVENT, changed); window.removeEventListener('online', refresh); window.removeEventListener('offline', refresh); };
  }, [client, id]);
}

export function useDatabase(id: string) {
  return useQuery({ queryKey: databaseKeys.meta(id), queryFn: () => loadDatabase(id), networkMode: 'always', retry: false, staleTime: 0, gcTime: 0, refetchInterval: 30_000 });
}
export function useDatabaseRows(id: string, version: number, config: ViewConfig, enabled = true, local = false) {
  return useInfiniteQuery({
    queryKey: [...databaseKeys.rows(id), version, config.sorts, config.filters, local], initialPageParam: 0, networkMode: 'always', retry: false,
    queryFn: async ({ pageParam, signal }) => {
      if (local) return localRows(id, config);
      try { return await api<RowsDto>('GET', `/api/databases/${id}/rows?${new URLSearchParams({ sort: JSON.stringify(config.sorts), filter: JSON.stringify(config.filters), offset: String(pageParam), limit: '100' })}`, { signal }); }
      catch (error) {
        // The connection dropped between loading the structure and the rows: show the copy kept here instead.
        if (!transient(error) || signal.aborted || pageParam !== 0 || !await localDatabase(id)) throw error;
        return localRows(id, config);
      }
    },
    getNextPageParam: last => last.offset + last.rows.length < last.total ? last.offset + last.rows.length : undefined,
    enabled, staleTime: 0, gcTime: 0, placeholderData: keepPreviousData,
  });
}
export function useDatabaseRow(id: string, databaseId: string) {
  return useQuery({
    queryKey: databaseKeys.row(id), networkMode: 'always', retry: false, staleTime: 0, gcTime: 0, refetchInterval: 30_000,
    queryFn: async () => {
      if (!await hasQueued(`db:${databaseId}`)) {
        try { return await api<DatabaseRow>('GET', `/api/rows/${id}`); }
        catch (error) { if (!transient(error)) throw error; }
      }
      const row = (await deviceCopy(databaseId)).rows.find(item => item.id === id);
      if (!row) throw new ApiError(404, 'not_found', '找不到資料列。');
      return row;
    },
  });
}

type SchemaChange =
  | { action: 'add'; input: PropertyInput }
  | { action: 'update'; id: string; input: PropertyInput }
  | { action: 'delete'; id: string }
  | { action: 'addView'; input: ViewInput }
  | { action: 'deleteView'; id: string }
  | { action: 'view'; id: string; input: ViewInput };
/** The structure as it is after the change: the server's answer, or the local view while the change waits. */
async function submitSchema(databaseId: string, op: OfflineOp): Promise<{ database: DatabaseDto; queued: boolean }> {
  const result = await submitOp(op);
  const database = result.database ?? (await localDatabase(databaseId))?.meta;
  if (!database) throw new ApiError(0, 'internal', '修改已存此裝置，連線後同步；此裝置尚未下載這個資料庫，暫時無法顯示。');
  return { database, queued: result.queued };
}
export function useDatabaseSchema(databaseId: string) {
  const client = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: async ({ version, ...change }: SchemaChange & { version: number }): Promise<DatabaseDto & { createdViewId?: string }> => {
      const base = { databaseId, baseVersion: version };
      if (change.action === 'add') return (await submitSchema(databaseId, { type: 'property.add', ...base, propertyId: newId(), input: change.input })).database;
      if (change.action === 'update') return (await submitSchema(databaseId, { type: 'property.update', ...base, propertyId: change.id, input: change.input })).database;
      if (change.action === 'delete') return (await submitSchema(databaseId, { type: 'property.delete', ...base, propertyId: change.id })).database;
      if (change.action === 'deleteView') return (await submitSchema(databaseId, { type: 'view.delete', ...base, viewId: change.id })).database;
      if (change.action === 'view') return (await submitSchema(databaseId, { type: 'view.update', ...base, viewId: change.id, input: change.input })).database;
      // A board needs a single-select column to group by. It is picked (or created) here, with ids known in
      // advance, so the same steps can also be carried out later from the queue.
      const input = { ...change.input, config: { ...change.input.config } };
      let baseVersion = version;
      if (input.type === 'board' && !input.config.groupBy) {
        const current = client.getQueryData<LoadedDatabase>(databaseKeys.meta(databaseId)) ?? await loadDatabase(databaseId);
        let groupBy = current.properties.find(property => property.type === 'select')?.id;
        if (!groupBy) {
          groupBy = newId();
          const added = await submitSchema(databaseId, { type: 'property.add', ...base, propertyId: groupBy, input: { name: '狀態', type: 'select', choices: [
            { id: newId(), label: '尚未開始', color: 'gray' }, { id: newId(), label: '進行中', color: 'blue' }, { id: newId(), label: '已完成', color: 'green' }] } });
          if (!added.queued) baseVersion = added.database.version;
        }
        input.config.groupBy = groupBy;
      }
      const viewId = newId();
      return { ...(await submitSchema(databaseId, { type: 'view.add', databaseId, baseVersion, viewId, input })).database, createdViewId: viewId };
    },
    onSuccess: async ({ createdViewId: _created, ...database }) => {
      client.setQueryData<LoadedDatabase>(databaseKeys.meta(databaseId), current => ({ ...database, local: current?.local ?? false }));
      await Promise.all([client.invalidateQueries({ queryKey: databaseKeys.meta(databaseId) }), client.invalidateQueries({ queryKey: databaseKeys.rows(databaseId) })]);
    },
  });
}
export function useAddRow(databaseId: string) {
  const client = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: async ({ title = '', values }: { title?: string; values: Record<string, CellValue> }) => {
      const rowId = newId();
      // Its page exists here first, marked as local-only, so the row can be opened before the server knows it. The
      // mark is cleared when the server confirms the row, whichever tab that happens in.
      await createLocalRow(databaseId, rowId, title).catch(() => undefined);
      try { return (await submitOp({ type: 'row.create', databaseId, rowId, title, values })).row; }
      catch (error) { await dropLocalRow(rowId); throw error; }
    },
    onSuccess: async () => { await client.invalidateQueries({ queryKey: databaseKeys.rows(databaseId) }); },
  });
}
/** `base` is what the cell showed when the edit began; only a cell that changed elsewhere since then is a conflict. */
export interface RowChange { id: string; databaseId: string; title?: { base: string; value: string }; values?: Record<string, { base: CellValue; value: CellValue }> }
export async function changeRow({ id, databaseId, title, values = {} }: RowChange): Promise<DatabaseRow | undefined> {
  const result = await submitOp({ type: 'row.update', databaseId, rowId: id, ...(title ? { title } : {}), values });
  if (title) await renameLocalRow(id, title.value).catch(() => undefined);
  return result.row;
}
export function useUpdateRow() {
  const client = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: changeRow,
    onSuccess: async (row, input) => {
      if (row) client.setQueryData(databaseKeys.row(input.id), row);
      await Promise.all([
        client.invalidateQueries({ queryKey: databaseKeys.rows(input.databaseId) }),
        ...(input.title ? [client.invalidateQueries({ queryKey: pageKeys.page(input.id) })] : []),
      ]);
    },
  });
}
