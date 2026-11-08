import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DatabaseDto, DatabaseRow, PropertyInput, PropertyPatch, RowInput, RowsDto, ViewConfig, ViewInput } from '@shared/database';
import { api } from './client.ts';
import { pageKeys } from './pages.ts';

export const databaseKeys = {
  meta: (id: string) => ['database', id] as const,
  rows: (id: string) => ['database-rows', id] as const,
  row: (id: string) => ['database-row', id] as const,
};
const match = (version: number) => ({ 'if-match': `"${version}"` });
export function useDatabase(id: string) {
  return useQuery({ queryKey: databaseKeys.meta(id), queryFn: () => api<DatabaseDto>('GET', `/api/databases/${id}`), staleTime: 0, gcTime: 0, refetchInterval: 30_000 });
}
export function useDatabaseRows(id: string, version: number, config: ViewConfig, enabled = true) {
  return useInfiniteQuery({
    queryKey: [...databaseKeys.rows(id), version, config.sorts, config.filters], initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => api<RowsDto>('GET', `/api/databases/${id}/rows?${new URLSearchParams({ sort: JSON.stringify(config.sorts), filter: JSON.stringify(config.filters), offset: String(pageParam), limit: '100' })}`, { signal }),
    getNextPageParam: last => last.offset + last.rows.length < last.total ? last.offset + last.rows.length : undefined,
    enabled, staleTime: 0, gcTime: 0, placeholderData: keepPreviousData,
  });
}
export function useDatabaseRow(id: string) {
  return useQuery({ queryKey: databaseKeys.row(id), queryFn: () => api<DatabaseRow>('GET', `/api/rows/${id}`), staleTime: 0, gcTime: 0, refetchInterval: 30_000 });
}
type SchemaChange =
  | { action: 'add'; input: PropertyInput }
  | { action: 'update'; id: string; input: PropertyPatch }
  | { action: 'delete'; id: string }
  | { action: 'addView'; input: ViewInput }
  | { action: 'deleteView'; id: string }
  | { action: 'view'; id: string; input: ViewInput };
export function useDatabaseSchema(databaseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ version, ...change }: SchemaChange & { version: number }) => {
      const path = `/api/databases/${databaseId}`;
      if (change.action === 'addView') return api<DatabaseDto>('POST', `${path}/views`, { headers: match(version), json: change.input });
      if (change.action === 'deleteView') return api<DatabaseDto>('DELETE', `${path}/views/${change.id}`, { headers: match(version) });
      if (change.action === 'add') return api<DatabaseDto>('POST', `${path}/properties`, { headers: match(version), json: change.input });
      if (change.action === 'delete') return api<DatabaseDto>('DELETE', `${path}/properties/${change.id}`, { headers: match(version) });
      return api<DatabaseDto>('PATCH', `${path}/${change.action === 'view' ? 'views' : 'properties'}/${change.id}`, { headers: match(version), json: change.input });
    },
    onSuccess: async meta => {
      client.setQueryData(databaseKeys.meta(databaseId), meta);
      await client.invalidateQueries({ queryKey: databaseKeys.rows(databaseId) });
    },
  });
}
export function useAddRow(databaseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ version, ...input }: RowInput & { version: number }) => api<DatabaseRow>('POST', `/api/databases/${databaseId}/rows`, { headers: match(version), json: input }),
    onSuccess: async () => { await client.invalidateQueries({ queryKey: databaseKeys.rows(databaseId) }); },
  });
}
export function useUpdateRow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, version, ...input }: RowInput & { id: string; version: number }) => api<DatabaseRow>('PATCH', `/api/rows/${id}/values`, { headers: match(version), json: input }),
    onSuccess: async row => {
      client.setQueryData(databaseKeys.row(row.id), row);
      await Promise.all([
        client.invalidateQueries({ queryKey: databaseKeys.rows(row.databaseId) }),
        client.invalidateQueries({ queryKey: pageKeys.page(row.id) }),
      ]);
    },
  });
}
