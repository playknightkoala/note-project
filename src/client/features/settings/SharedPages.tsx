import { ActionIcon, Alert, Anchor, Badge, Group, Loader, Table, Text, Tooltip } from '@mantine/core';
import { Settings2, X } from 'lucide-react';
import { Link } from 'react-router';
import { accountLinkLabels, databaseScopeLabels, scopeLabels } from '@shared/shares';
import { errorText } from '../../api/client.ts';
import { useShares, useStopSharing } from '../../api/shares.ts';
import { useShareDialog } from '../share/ShareDialog.tsx';

const formatTime = (value: number) => new Date(value).toLocaleString('zh-TW', { hour12: false });

/** Everything of mine that somebody else can reach, in one place. */
export function SharedPages() {
  const shares = useShares();
  const stop = useStopSharing();
  const openShare = useShareDialog();
  if (shares.isPending) return <Loader size="sm" />;
  if (shares.error) return <Alert color="red">{errorText(shares.error)}</Alert>;
  const outgoing = shares.data.outgoing;
  return <>
    <Text size="sm" c="dimmed" mb="sm">這裡列出你開放給其他人的頁面。公開連結任何知道網址的人都能閱讀；「知道連結的人」是登入本站後開啟公開連結的帳號；成員是個別指定的本站帳號。</Text>
    {stop.error && <Alert color="red" mb="sm">{errorText(stop.error)}</Alert>}
    <Table striped highlightOnHover withTableBorder>
      <Table.Thead><Table.Tr><Table.Th>頁面</Table.Th><Table.Th>範圍</Table.Th><Table.Th>開放方式</Table.Th><Table.Th>更新</Table.Th><Table.Th></Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>
        {outgoing.map(share => <Table.Tr key={share.pageId}>
          <Table.Td><Anchor component={Link} to={`/p/${share.pageId}`} size="sm">{share.icon ? `${share.icon} ` : ''}{share.title || '無標題'}</Anchor></Table.Td>
          <Table.Td>{(share.kind === 'database' ? databaseScopeLabels : scopeLabels)[share.scope]}</Table.Td>
          <Table.Td><Group gap={4}>{share.link && <Badge color="orange" variant="light">公開連結</Badge>}{share.accountRole && <Badge color="grape" variant="light">{accountLinkLabels[share.accountRole]}</Badge>}{share.members > 0 && <Badge color="blue" variant="light">{share.members} 位成員</Badge>}</Group></Table.Td>
          <Table.Td>{formatTime(share.updatedAt)}</Table.Td>
          <Table.Td><Group gap={2} wrap="nowrap" justify="flex-end">
            <Tooltip label="管理分享"><ActionIcon variant="subtle" color="gray" aria-label={`管理分享：${share.title || '無標題'}`} onClick={() => openShare({ id: share.pageId, kind: share.kind, title: share.title })}><Settings2 size={16} /></ActionIcon></Tooltip>
            <Tooltip label="停止分享"><ActionIcon variant="subtle" color="red" aria-label={`停止分享：${share.title || '無標題'}`} disabled={stop.isPending}
              onClick={() => { if (window.confirm(`停止分享「${share.title || '無標題'}」？公開連結會失效，所有成員與透過連結進來的帳號都無法再存取。`)) stop.mutate(share.pageId); }}><X size={16} /></ActionIcon></Tooltip>
          </Group></Table.Td>
        </Table.Tr>)}
        {outgoing.length === 0 && <Table.Tr><Table.Td colSpan={5}><Text c="dimmed" ta="center" py="md">目前沒有分享任何頁面。在頁面選單選「分享」即可開始。</Text></Table.Td></Table.Tr>}
      </Table.Tbody>
    </Table>
  </>;
}
