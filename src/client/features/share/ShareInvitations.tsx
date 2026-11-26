import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { roleLabels } from '@shared/shares';
import type { ShareInvitationDto } from '@shared/shares';
import { api, errorText } from '../../api/client.ts';
import { shareKeys } from '../../api/shares.ts';
import { useOnline } from '../../offline/useOnline.ts';
import { syncNotes } from '../../offline/notes.ts';

export function ShareInvitations({ userId }: { userId: string }) {
  const [opened, setOpened] = useState(false);
  const online = useOnline();
  const client = useQueryClient();
  const queryKey = ['share-invitations', userId];
  const list = useQuery({ queryKey, enabled: online, refetchInterval: 30_000, retry: false,
    queryFn: () => api<{ invitations: ShareInvitationDto[] }>('GET', '/api/shares/invitations') });
  const invitations = list.data?.invitations ?? [];
  const answer = useMutation({
    networkMode: 'always',
    mutationFn: ({ id, decision }: { id: string; decision: 'accept' | 'decline' }) =>
      api<void>('POST', `/api/shares/invitations/${id}/${decision}`),
    onSuccess: (_result, { decision, id }) => {
      client.setQueryData<{ invitations: ShareInvitationDto[] }>(queryKey, current => current && { invitations: current.invitations.filter(invite => invite.id !== id) });
      if (decision === 'accept') {
        void client.invalidateQueries({ queryKey: shareKeys.all });
        void syncNotes({ force: true });
      }
    },
    onSettled: () => client.invalidateQueries({ queryKey }),
  });
  return <>
    {invitations.length > 0 && <button type="button" className="sidebar-button" onClick={() => { answer.reset(); setOpened(true); }}>
      <Mail size={15} /><span>共用邀請（{invitations.length}）</span>
    </button>}
    <Modal opened={opened} onClose={() => setOpened(false)} title="共用邀請">
      <Stack gap="sm">
        {answer.error && <Alert color="red">{errorText(answer.error)}</Alert>}
        {!online && <Text size="sm">請連線後處理邀請。</Text>}
        {invitations.map(invite => <div key={invite.id}>
          <Text fw={600}>{invite.title || '無標題'}</Text>
          <Text size="sm">{invite.ownerName} 邀請你共用 · {roleLabels[invite.role]}</Text>
          <Group gap="xs" mt="xs">
            <Button size="xs" disabled={!online || answer.isPending} onClick={() => answer.mutate({ id: invite.id, decision: 'accept' })}>接受</Button>
            <Button size="xs" variant="default" disabled={!online || answer.isPending} onClick={() => answer.mutate({ id: invite.id, decision: 'decline' })}>婉拒</Button>
          </Group>
        </div>)}
        {!invitations.length && <Text size="sm">目前沒有待處理的邀請。</Text>}
      </Stack>
    </Modal>
  </>;
}
