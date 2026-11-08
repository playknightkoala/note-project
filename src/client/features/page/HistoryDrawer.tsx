import { useState } from 'react';
import { Alert, Button, Drawer, Group, Loader, ScrollArea, Stack, Text, UnstyledButton } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { Block } from '@shared/blocks';
import { extractPlainText } from '@shared/text';
import { api, errorText } from '../../api/client.ts';
import { useVersions } from '../../api/pages.ts';

const reasons: Record<string, string> = { autosave: '自動快照', restore: '還原前', import: '匯入', manual: '手動' };
const formatTime = (value: number) => new Date(value).toLocaleString('zh-TW', { hour12: false });

interface Props { pageId: string; opened: boolean; onClose: () => void; currentVersion: number; onRestored: () => void }

/** Page history: snapshots the server kept before overwrites; restoring goes through the normal If-Match save path. */
export function HistoryDrawer({ pageId, opened, onClose, currentVersion, onRestored }: Props) {
  const versions = useVersions(pageId, opened);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const preview = useQuery({
    queryKey: ['version', pageId, selected],
    queryFn: () => api<{ title: string; content: Block[]; version: number }>('GET', `/api/pages/${pageId}/versions/${selected}`),
    enabled: opened && selected !== null,
  });
  const restore = async () => {
    if (!selected) return;
    setRestoring(true); setError(null);
    try {
      await api('POST', `/api/pages/${pageId}/versions/${selected}/restore`, { headers: { 'if-match': `"${currentVersion}"` } });
      onRestored(); onClose();
    } catch (err) { setError(errorText(err)); } finally { setRestoring(false); }
  };
  return <Drawer opened={opened} onClose={onClose} position="right" size={420} title="頁面歷史" padding="md">
    <Stack gap="sm" h="calc(100vh - 80px)">
      <Text size="xs" c="dimmed">伺服器在內容被覆寫前留下快照（間隔至少 10 分鐘，每頁最多 100 份）。還原會先把目前內容存成新的快照。</Text>
      {error && <Alert color="red" variant="light">{error}</Alert>}
      {versions.isPending && <Loader size="sm" />}
      {versions.data?.length === 0 && <Text size="sm" c="dimmed">還沒有歷史版本。</Text>}
      <ScrollArea.Autosize mah={220} type="auto">
        <Stack gap={2}>
          {(versions.data ?? []).map(version => <UnstyledButton key={version.id} className={`history-item${selected === version.id ? ' history-item--active' : ''}`} onClick={() => setSelected(version.id)}>
            <Group justify="space-between" wrap="nowrap">
              <Text size="sm" truncate>{version.title || '無標題'}</Text>
              <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>{formatTime(version.createdAt)}</Text>
            </Group>
            <Text size="xs" c="dimmed">版本 {version.version} · {reasons[version.reason] ?? version.reason} · {Math.max(1, Math.round(version.size / 1024))} KB</Text>
          </UnstyledButton>)}
        </Stack>
      </ScrollArea.Autosize>
      {selected && <>
        <Text size="xs" fw={600} c="dimmed">預覽（純文字）</Text>
        <ScrollArea style={{ flex: 1 }} type="auto" className="history-preview">
          {preview.isPending ? <Loader size="sm" /> : preview.error ? <Text size="sm" c="red">{errorText(preview.error)}</Text>
            : <pre className="history-preview__text">{extractPlainText(preview.data!.content) || '（空白頁面）'}</pre>}
        </ScrollArea>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>關閉</Button>
          <Button loading={restoring} onClick={() => { void restore(); }} disabled={!preview.data}>還原此版本</Button>
        </Group>
      </>}
    </Stack>
  </Drawer>;
}
