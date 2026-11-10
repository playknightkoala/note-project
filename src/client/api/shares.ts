import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MemberRole, OpenedLinkDto, ShareScope, SharesDto, ShareStateDto } from '@shared/shares';
import { api } from './client.ts';
import { loadShares } from '../offline/notes.ts';
import { pageKeys } from './pages.ts';

export const shareKeys = { all: ['shares'] as const, state: (pageId: string) => ['share', pageId] as const };

/** What I share and what is shared with me; the latter also without a connection. */
export function useShares() {
  return useQuery({ queryKey: shareKeys.all, queryFn: loadShares, networkMode: 'always', staleTime: 30_000, retry: false });
}

export function useShareState(pageId: string, enabled = true) {
  return useQuery({ queryKey: shareKeys.state(pageId), queryFn: () => api<ShareStateDto>('GET', `/api/pages/${pageId}/share`), enabled, retry: false });
}

export type ShareChange =
  | { type: 'scope'; scope: ShareScope } | { type: 'link'; on: boolean } | { type: 'account'; role: MemberRole | null }
  | { type: 'member'; email: string; role: MemberRole } | { type: 'role'; userId: string; role: MemberRole } | { type: 'remove'; userId: string };

/** Every change answers with the share as it is afterwards. */
export function useChangeShare(pageId: string) {
  const client = useQueryClient();
  const base = `/api/pages/${pageId}/share`;
  return useMutation({
    mutationFn: (change: ShareChange) => {
      switch (change.type) {
        case 'scope': return api<ShareStateDto>('PUT', base, { json: { scope: change.scope } });
        case 'link': return api<ShareStateDto>(change.on ? 'POST' : 'DELETE', `${base}/link`);
        case 'account': return api<ShareStateDto>('PUT', `${base}/account-link`, { json: { role: change.role } });
        case 'member': return api<ShareStateDto>('PUT', `${base}/members`, { json: { email: change.email, role: change.role } });
        case 'role': return api<ShareStateDto>('PATCH', `${base}/members/${change.userId}`, { json: { role: change.role } });
        case 'remove': return api<ShareStateDto>('DELETE', `${base}/members/${change.userId}`);
      }
    },
    onSuccess: state => {
      client.setQueryData(shareKeys.state(pageId), state);
      void client.invalidateQueries({ queryKey: shareKeys.all });
      void client.invalidateQueries({ queryKey: pageKeys.tree });
    },
  });
}

/** Opens a share link as the signed-in account; answers the page to go to. */
export const openShareLink = (token: string, pageId?: string) => api<OpenedLinkDto>('POST', '/api/shares/open', { json: { token, ...(pageId ? { pageId } : {}) } });

/** Stops sharing a page altogether: the link and every member. */
export function useStopSharing() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (pageId: string) => api<void>('DELETE', `/api/pages/${pageId}/share`),
    onSuccess: (_result, pageId) => {
      client.setQueryData<ShareStateDto>(shareKeys.state(pageId), current => current && { ...current, share: null });
      void client.invalidateQueries({ queryKey: shareKeys.all });
      void client.invalidateQueries({ queryKey: pageKeys.tree });
    },
  });
}

/** A member takes a share off their own list. */
export function useLeaveShare() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (pageId: string) => api<void>('DELETE', `/api/shares/incoming/${pageId}`),
    onSuccess: (_result, pageId) => {
      client.setQueryData<SharesDto>(shareKeys.all, current => current && { ...current, incoming: current.incoming.filter(share => share.pageId !== pageId) });
      void client.invalidateQueries({ queryKey: shareKeys.all });
    },
  });
}
