import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminUserDto, AuthStatusDto, InviteDto, LoginInput, RegisterInput, SessionDto, UserDto } from '@shared/api';
import { api, isApiError, setCsrfToken } from './client.ts';

export const authKeys = { me: ['me'] as const, status: ['auth', 'status'] as const, users: ['admin', 'users'] as const, invites: ['admin', 'invites'] as const };

async function fetchMe(): Promise<UserDto | null> {
  try {
    const session = await api<SessionDto>('GET', '/api/auth/me');
    setCsrfToken(session.csrfToken);
    return session.user;
  } catch (error) {
    if (isApiError(error, 401)) { setCsrfToken(null); return null; }
    throw error;
  }
}

export function useMe() {
  return useQuery({ queryKey: authKeys.me, queryFn: fetchMe, staleTime: 5 * 60 * 1000, retry: false });
}

export function useAuthStatus() {
  return useQuery({ queryKey: authKeys.status, queryFn: () => api<AuthStatusDto>('GET', '/api/auth/status'), staleTime: 60_000 });
}

function useSessionMutation<TInput>(path: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => api<SessionDto>('POST', path, { json: input }),
    onSuccess: session => {
      setCsrfToken(session.csrfToken);
      queryClient.setQueryData(authKeys.me, session.user);
      void queryClient.invalidateQueries({ queryKey: authKeys.status });
    },
  });
}

export const useLogin = () => useSessionMutation<LoginInput>('/api/auth/login');
export const useRegister = () => useSessionMutation<RegisterInput>('/api/auth/register');

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('POST', '/api/auth/logout'),
    onSuccess: () => { setCsrfToken(null); queryClient.clear(); },
  });
}

export function useChangePassword() {
  return useMutation({ mutationFn: (input: { currentPassword: string; newPassword: string }) => api<void>('POST', '/api/auth/password', { json: input }) });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { displayName?: string; username?: string | null }) => api<SessionDto>('PATCH', '/api/auth/profile', { json: input }),
    onSuccess: session => queryClient.setQueryData(authKeys.me, session.user),
  });
}

export function useAdminUsers() {
  return useQuery({ queryKey: authKeys.users, queryFn: async () => (await api<{ users: AdminUserDto[] }>('GET', '/api/admin/users')).users });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; disabled?: boolean; role?: 'admin' | 'user' }) => api<{ user: AdminUserDto }>('PATCH', `/api/admin/users/${id}`, { json: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authKeys.users }),
  });
}

export function useInvites() {
  return useQuery({ queryKey: authKeys.invites, queryFn: async () => (await api<{ invites: InviteDto[] }>('GET', '/api/admin/invites')).invites });
}

export function useCreateInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { expiresInHours: number; note?: string }) => api<{ code: string; invite: InviteDto }>('POST', '/api/admin/invites', { json: input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authKeys.invites }),
  });
}

export function useRevokeInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>('DELETE', `/api/admin/invites/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authKeys.invites }),
  });
}
