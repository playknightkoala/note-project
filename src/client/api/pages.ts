import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PageDto, PageHeadDto, PageNode, PageResponse, TrashItemDto, VersionDto } from '@shared/api';
import { api } from './client.ts';
import { cachePage, createLocalNote, loadNote, loadTree, offlineNote, offlineStorageError, saveLocalContent, saveLocalTitle } from '../offline/notes.ts';
import { applyFavorite, applyMove, applyRename, applyTrash } from '../features/shell/treeIndex.ts';

export const pageKeys = {
  tree: ['tree'] as const,
  page: (id: string) => ['page', id] as const,
  trash: ['trash'] as const,
  versions: (id: string) => ['versions', id] as const,
};

export function useTree() {
  return useQuery({ queryKey: pageKeys.tree, queryFn: loadTree, networkMode: 'always', staleTime: 30_000 });
}

/** The full page (content included). gcTime 0 so re-entering a page always refetches; the editor owns the content while mounted. */
export function usePage(id: string | undefined) {
  return useQuery({
    queryKey: pageKeys.page(id ?? ''),
    queryFn: () => loadNote(id!), networkMode: 'always',
    enabled: !!id, staleTime: Infinity, gcTime: 0, retry: false,
  });
}

/** Optimistic tree mutation helper: snapshot, apply a pure update, roll back on error, refetch when settled. */
function useTreeMutation<TInput>(mutationFn: (input: TInput) => Promise<unknown>, apply: (nodes: PageNode[], input: TInput) => PageNode[]) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async input => {
      await queryClient.cancelQueries({ queryKey: pageKeys.tree });
      const previous = queryClient.getQueryData<PageNode[]>(pageKeys.tree);
      if (previous) queryClient.setQueryData(pageKeys.tree, apply(previous, input));
      return { previous };
    },
    onError: (_error, _input, context) => { if (context?.previous) queryClient.setQueryData(pageKeys.tree, context.previous); },
    onSettled: () => queryClient.invalidateQueries({ queryKey: pageKeys.tree }),
  });
}

export interface CreatePageInput { parentId?: string | null; kind?: 'page' | 'database'; title?: string; afterId?: string | null; icon?: string | null }

/**
 * Creates a page the way the sidebar does: an ordinary note under a downloaded note (or at the root) is created on
 * this device and synced later, anything else needs the server.
 */
export async function createPage(input: CreatePageInput): Promise<PageResponse> {
  if (input.kind !== 'database' && !input.icon && !offlineStorageError) {
    const parent = input.parentId ? await offlineNote(input.parentId).catch(() => undefined) : undefined;
    if (!input.parentId || parent?.local.page.kind === 'page') return createLocalNote(input);
  }
  return cachePage(await api<PageResponse>('POST', '/api/pages', { json: input }));
}

export function useCreatePage() {
  const queryClient = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: async (input: CreatePageInput) => {
      if (input.kind !== 'database' && !input.icon && !offlineStorageError) return createLocalNote(input);
      return cachePage(await api<PageResponse>('POST', '/api/pages', { json: input }));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: pageKeys.tree }),
  });
}

export const useMovePage = () => useTreeMutation(
  (input: { id: string; parentId: string | null; index: number }) => api('POST', `/api/pages/${input.id}/move`, { json: { parentId: input.parentId, index: input.index } }),
  (nodes, input) => applyMove(nodes, input.id, input.parentId, input.index),
);

export const useToggleFavorite = () => useTreeMutation(
  (input: { id: string; favorite: boolean }) => api('POST', `/api/pages/${input.id}/favorite`, { json: { favorite: input.favorite } }),
  (nodes, input) => applyFavorite(nodes, input.id, input.favorite),
);

export const useTrashPage = () => useTreeMutation(
  (input: { id: string }) => api('DELETE', `/api/pages/${input.id}`),
  (nodes, input) => applyTrash(nodes, input.id),
);

/** Title/icon/cover edits: the tree gets the new title immediately; the page query receives the returned version. */
export function usePatchPage() {
  const queryClient = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: async (input: { id: string; title?: string; localRevision?: string; icon?: string | null; coverFileId?: string | null; coverPreset?: string | null; coverPosition?: number; fullWidth?: boolean }) => {
      const { id, localRevision, ...body } = input;
      if (body.title !== undefined && (await offlineNote(id).catch(() => undefined))?.local.page.kind === 'page') return saveLocalTitle(id, body.title, localRevision);
      return api<PageResponse>('PATCH', `/api/pages/${id}`, { json: body });
    },
    onMutate: async input => {
      await queryClient.cancelQueries({ queryKey: pageKeys.tree });
      const previous = queryClient.getQueryData<PageNode[]>(pageKeys.tree);
      if (previous && (input.title !== undefined || input.icon !== undefined)) queryClient.setQueryData(pageKeys.tree, applyRename(previous, input.id, input.title, input.icon));
      return { previous };
    },
    onError: (_error, _input, context) => { if (context?.previous) queryClient.setQueryData(pageKeys.tree, context.previous); },
    onSuccess: (response, input) => {
      queryClient.setQueryData<PageResponse>(pageKeys.page(input.id), current => current ? { ...current, page: { ...current.page, ...pick(response.page), content: current.page.content }, breadcrumbs: response.breadcrumbs } : response);
      if (response.page.kind === 'row') void queryClient.invalidateQueries({ queryKey: ['database-row', input.id] });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: pageKeys.tree }),
  });
}
const pick = (page: PageDto) => ({ title: page.title, icon: page.icon, coverUrl: page.coverUrl, coverPosition: page.coverPosition, fullWidth: page.fullWidth, version: page.version, updatedAt: page.updatedAt });

export function useDuplicatePage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<PageResponse>('POST', `/api/pages/${id}/duplicate`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: pageKeys.tree }),
  });
}

const KEEPALIVE_LIMIT_BYTES = 60 * 1024;
export async function saveContent(id: string, version: number, content: unknown[], { overwrite = false, localRevision, ...options }: { keepalive?: boolean; signal?: AbortSignal; overwrite?: boolean; localRevision?: string } = {}) {
  const note = await offlineNote(id).catch(() => undefined);
  if (note?.local.page.kind === 'page') return saveLocalContent(id, content, localRevision);
  // Browsers refuse keepalive requests above 64 KB outright; a plain request at least has a chance to complete.
  const { keepalive, ...rest } = options;
  const small = keepalive === true && new TextEncoder().encode(JSON.stringify(content)).length < KEEPALIVE_LIMIT_BYTES;
  return api<PageHeadDto>('PUT', `/api/pages/${id}/content`, { json: { content, overwrite }, headers: { 'if-match': `"${version}"` }, ...rest, ...(small ? { keepalive: true } : {}) });
}

export const fetchHead = (id: string) => api<PageHeadDto>('GET', `/api/pages/${id}/head`);

export function useTrash() {
  return useQuery({ queryKey: pageKeys.trash, queryFn: async () => (await api<{ items: TrashItemDto[] }>('GET', '/api/trash')).items });
}

function useTrashMutation<TInput>(mutationFn: (input: TInput) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn, onSettled: () => { void queryClient.invalidateQueries({ queryKey: pageKeys.trash }); void queryClient.invalidateQueries({ queryKey: pageKeys.tree }); } });
}
export const useRestorePage = () => useTrashMutation((id: string) => api('POST', `/api/trash/${id}/restore`));
export const useDeleteTrashed = () => useTrashMutation((id: string) => api('DELETE', `/api/trash/${id}`));
export const useEmptyTrash = () => useTrashMutation(() => api('DELETE', '/api/trash'));

export function useVersions(id: string, enabled: boolean) {
  return useQuery({ queryKey: pageKeys.versions(id), queryFn: async () => (await api<{ versions: VersionDto[] }>('GET', `/api/pages/${id}/versions`)).versions, enabled });
}
