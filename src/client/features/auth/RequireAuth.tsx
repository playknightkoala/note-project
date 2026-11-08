import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Center, Loader } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { Navigate, useLocation } from 'react-router';
import { AUTH_LOST_EVENT, setCsrfToken } from '../../api/client.ts';
import { authKeys, useMe } from '../../api/auth.ts';

/** Gate for everything behind login; a 401 anywhere drops the cached user and returns to the login page. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const location = useLocation();
  useEffect(() => {
    const lost = () => { setCsrfToken(null); queryClient.setQueryData(authKeys.me, null); };
    window.addEventListener(AUTH_LOST_EVENT, lost);
    return () => window.removeEventListener(AUTH_LOST_EVENT, lost);
  }, [queryClient]);
  if (me.isPending) return <Center h="100vh"><Loader size="sm" /></Center>;
  if (!me.data) {
    const next = location.pathname === '/' ? '' : `?next=${encodeURIComponent(location.pathname + location.search)}`;
    return <Navigate to={`/login${next}`} replace />;
  }
  return <>{children}</>;
}
