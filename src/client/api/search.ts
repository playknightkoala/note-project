import { useQuery } from '@tanstack/react-query';
import type { SearchResponse } from '@shared/api';
import { api } from './client.ts';

export const SEARCH_PAGE_SIZE = 20;

export function useSearch(userId: string, query: string, offset: number, enabled: boolean) {
  return useQuery({
    queryKey: ['search', userId, query, offset],
    queryFn: ({ signal }) => api<SearchResponse>('GET', `/api/search?${new URLSearchParams({ q: query, limit: String(SEARCH_PAGE_SIZE), offset: String(offset) })}`, { signal }),
    enabled: enabled && !!query, staleTime: 0, gcTime: 0,
  });
}
