import type { ReactNode } from 'react';
import { Box, Paper, Stack, Text, Title } from '@mantine/core';

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return <Box className="auth-page">
    <Paper className="auth-card" withBorder p="xl" radius="md">
      <Stack gap="xs" mb="lg">
        <Text className="auth-brand">Notes</Text>
        <Title order={2} size="h3">{title}</Title>
        {subtitle && <Text c="dimmed" size="sm">{subtitle}</Text>}
      </Stack>
      {children}
    </Paper>
  </Box>;
}
