import type { ReactNode } from 'react';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { UiStateProvider } from './uiState.tsx';
import { colorSchemeManager, theme } from './theme.ts';
import { isApiError } from '../api/client.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    mutations: { networkMode: 'always' },
    queries: {
      retry: (count, error) => !(isApiError(error) && error.status > 0 && error.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

export function AppProviders({ children }: { children: ReactNode }) {
  return <MantineProvider theme={theme} defaultColorScheme="auto" colorSchemeManager={colorSchemeManager}>
    <QueryClientProvider client={queryClient}>
      <UiStateProvider><ErrorBoundary>{children}</ErrorBoundary></UiStateProvider>
    </QueryClientProvider>
  </MantineProvider>;
}
