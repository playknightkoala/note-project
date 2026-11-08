import { useState } from 'react';
import { Button, Container, Group, Modal, Stack, Table, Text, Title } from '@mantine/core';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useDeleteTrashed, useEmptyTrash, useRestorePage, useTrash } from '../../api/pages.ts';

const formatTime = (value: number) => new Date(value).toLocaleString('zh-TW', { hour12: false });

export function TrashPage() {
  const trash = useTrash();
  const restore = useRestorePage();
  const remove = useDeleteTrashed();
  const empty = useEmptyTrash();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState<{ id: string | null; title: string } | null>(null);
  const items = trash.data ?? [];
  return <Container size="md" py="xl">
    <Group justify="space-between" mb="lg">
      <Title order={2}>垃圾桶</Title>
      {items.length > 0 && <Button variant="default" color="red" leftSection={<Trash2 size={16} />} onClick={() => setConfirm({ id: null, title: '垃圾桶裡的全部頁面' })}>清空垃圾桶</Button>}
    </Group>
    {items.length === 0 ? <Text c="dimmed">垃圾桶是空的。</Text> : <Table highlightOnHover withTableBorder>
      <Table.Thead><Table.Tr><Table.Th>頁面</Table.Th><Table.Th>刪除時間</Table.Th><Table.Th></Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{items.map(item => <Table.Tr key={item.id}>
        <Table.Td>{item.icon && <span style={{ marginRight: 6 }}>{item.icon}</span>}{item.title || '無標題'}{item.descendantCount > 0 && <Text span c="dimmed" size="xs">（含 {item.descendantCount} 個子頁面）</Text>}</Table.Td>
        <Table.Td>{formatTime(item.trashedAt)}</Table.Td>
        <Table.Td>
          <Group gap="xs" justify="flex-end" wrap="nowrap">
            <Button size="compact-xs" variant="light" leftSection={<RotateCcw size={12} />} onClick={() => restore.mutate(item.id, { onSuccess: () => navigate(`/p/${item.id}`) })}>還原</Button>
            <Button size="compact-xs" variant="light" color="red" onClick={() => setConfirm({ id: item.id, title: item.title || '無標題' })}>永久刪除</Button>
          </Group>
        </Table.Td>
      </Table.Tr>)}</Table.Tbody>
    </Table>}
    <Modal opened={confirm !== null} onClose={() => setConfirm(null)} title="永久刪除" centered>
      <Stack gap="md">
        <Text size="sm">確定要永久刪除「{confirm?.title}」嗎？這個動作無法復原，頁面內容與歷史都會消失。</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => setConfirm(null)}>取消</Button>
          <Button color="red" loading={remove.isPending || empty.isPending} onClick={() => {
            const done = () => setConfirm(null);
            if (confirm?.id) remove.mutate(confirm.id, { onSettled: done }); else empty.mutate(undefined, { onSettled: done });
          }}>永久刪除</Button>
        </Group>
      </Stack>
    </Modal>
  </Container>;
}
