import { Button, Center, Loader, Stack, Text, Title } from '@mantine/core';
import { Plus } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router';
import { useCreatePage, useTree } from '../../api/pages.ts';
import { useUiState } from '../../app/uiState.tsx';
import { useMe } from '../../api/auth.ts';

/** Lands on the last visited page, else the first page; with no pages, offers to create one. */
export function HomePage() {
  const tree = useTree();
  const me = useMe();
  const create = useCreatePage();
  const navigate = useNavigate();
  const { lastPageId } = useUiState();
  if (tree.isPending) return <Center h="60vh"><Loader size="sm" /></Center>;
  const pages = tree.data ?? [];
  const target = pages.find(node => node.id === lastPageId) ?? pages.filter(node => node.parentId === null).sort((a, b) => a.position - b.position)[0];
  if (target) return <Navigate to={`/p/${target.id}`} replace />;
  return <Center h="70vh">
    <Stack align="center" gap="sm">
      <Title order={2}>{me.data?.displayName}，歡迎。</Title>
      <Text c="dimmed">建立第一個頁面開始寫筆記。</Text>
      <Button leftSection={<Plus size={16} />} loading={create.isPending} onClick={() => create.mutate({}, { onSuccess: result => navigate(`/p/${result.page.id}`) })}>新增頁面</Button>
    </Stack>
  </Center>;
}
