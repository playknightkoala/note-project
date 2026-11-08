import { useState } from 'react';
import { ActionIcon, Alert, Badge, Button, Code, CopyButton, Group, NumberInput, Stack, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { Check, Copy, X } from 'lucide-react';
import { useCreateInvite, useInvites, useRevokeInvite } from '../../api/auth.ts';
import { errorText } from '../../api/client.ts';

const formatTime = (value: number) => new Date(value).toLocaleString('zh-TW', { hour12: false });

export function AdminInvites() {
  const invites = useInvites();
  const create = useCreateInvite();
  const revoke = useRevokeInvite();
  const [hours, setHours] = useState<number | string>(72);
  const [note, setNote] = useState('');
  const [issued, setIssued] = useState<string | null>(null);
  const now = Date.now();
  const link = issued ? `${window.location.origin}/register?invite=${encodeURIComponent(issued)}` : '';
  return <Stack gap="lg">
    <Stack gap="sm" maw={520}>
      <Text size="sm" c="dimmed">邀請碼只能使用一次，產生後只顯示這一次；請直接把連結交給對方。</Text>
      <Group align="flex-end" gap="sm">
        <NumberInput label="有效時數" min={1} max={720} value={hours} onChange={setHours} w={120} />
        <TextInput label="備註（選填）" value={note} onChange={e => setNote(e.currentTarget.value)} style={{ flex: 1 }} />
        <Button loading={create.isPending} onClick={() => create.mutate({ expiresInHours: Number(hours) || 72, ...(note ? { note } : {}) }, { onSuccess: result => { setIssued(result.code); setNote(''); } })}>產生邀請碼</Button>
      </Group>
      {create.error && <Alert color="red" variant="light">{errorText(create.error)}</Alert>}
      {issued && <Alert color="green" variant="light" title="新的邀請連結" withCloseButton onClose={() => setIssued(null)}>
        <Group gap="xs" wrap="nowrap">
          <Code style={{ flex: 1, overflowWrap: 'anywhere' }}>{link}</Code>
          <CopyButton value={link}>{({ copied, copy }) => <Tooltip label={copied ? '已複製' : '複製連結'}><ActionIcon variant="subtle" onClick={copy} aria-label="複製連結">{copied ? <Check size={16} /> : <Copy size={16} />}</ActionIcon></Tooltip>}</CopyButton>
        </Group>
      </Alert>}
    </Stack>
    <Table striped highlightOnHover withTableBorder>
      <Table.Thead><Table.Tr><Table.Th>備註</Table.Th><Table.Th>建立</Table.Th><Table.Th>到期</Table.Th><Table.Th>狀態</Table.Th><Table.Th></Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>
        {(invites.data ?? []).map(invite => {
          const state = invite.usedAt ? <Badge color="gray">已使用</Badge> : invite.revokedAt ? <Badge color="red">已撤銷</Badge> : invite.expiresAt < now ? <Badge color="orange">已過期</Badge> : <Badge color="green">可用</Badge>;
          return <Table.Tr key={invite.id}>
            <Table.Td>{invite.note ?? <Text c="dimmed" span>—</Text>}</Table.Td>
            <Table.Td>{formatTime(invite.createdAt)}</Table.Td>
            <Table.Td>{formatTime(invite.expiresAt)}</Table.Td>
            <Table.Td>{state}</Table.Td>
            <Table.Td>{!invite.usedAt && !invite.revokedAt && invite.expiresAt >= now &&
              <Tooltip label="撤銷"><ActionIcon variant="subtle" color="red" aria-label="撤銷邀請碼" onClick={() => revoke.mutate(invite.id)}><X size={16} /></ActionIcon></Tooltip>}</Table.Td>
          </Table.Tr>;
        })}
        {invites.data?.length === 0 && <Table.Tr><Table.Td colSpan={5}><Text c="dimmed" ta="center" py="md">還沒有邀請碼。</Text></Table.Td></Table.Tr>}
      </Table.Tbody>
    </Table>
  </Stack>;
}
