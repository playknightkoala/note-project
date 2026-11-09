import { useEffect, useState } from 'react';
import { Alert, Anchor, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { downloadNotes, offlineNotes, offlineStorageError, syncNotes } from './notes.ts';
import type { OfflineNote } from './notes.ts';
import { OFFLINE_EVENT, updateLocal } from './storage.ts';
import { errorText } from '../api/client.ts';

function exportDraft(note: OfflineNote): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(note.local, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = `筆記草稿-${note.local.page.id}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function OfflineStatus() {
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState<OfflineNote[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [storageFailure, setStorageFailure] = useState<string | null>(offlineStorageError);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => { void offlineNotes().then(items => { if (active) { setNotes(items); setStorageFailure(offlineStorageError); } }).catch(error => { if (active) setStorageFailure(errorText(error)); }); };
    const connect = () => { setOnline(navigator.onLine); if (navigator.onLine) void syncNotes(); };
    const focus = () => { if (document.visibilityState === 'visible') void syncNotes(); };
    const prepared = () => setReady(true);
    window.addEventListener(OFFLINE_EVENT, refresh);
    window.addEventListener('online', connect); window.addEventListener('offline', connect);
    window.addEventListener('notes:offline-ready', prepared);
    document.addEventListener('visibilitychange', focus);
    const timer = setInterval(() => { void syncNotes(); }, 15_000);
    if ('serviceWorker' in navigator) void navigator.serviceWorker.ready.then(() => { if (active) setReady(true); });
    refresh(); void syncNotes();
    return () => { active = false; clearInterval(timer); window.removeEventListener(OFFLINE_EVENT, refresh); window.removeEventListener('online', connect); window.removeEventListener('offline', connect); window.removeEventListener('notes:offline-ready', prepared); document.removeEventListener('visibilitychange', focus); };
  }, []);
  const pending = notes.filter(n => n.pending);
  const problems = pending.filter(n => n.problem);
  const download = async () => {
    setBusy(true); setMessage(null);
    try { await downloadNotes(); setMessage('一般筆記已下載至此裝置。'); }
    catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  };
  return <>
    <Group className="offline-status" gap="xs" px="sm" py={6} role="status" wrap="wrap">
      <Text size="xs" c={problems.length ? 'red' : !online || pending.length ? 'orange' : 'dimmed'}>
        {!online ? '離線使用中' : problems.length ? '部分筆記需要處理' : pending.length ? '等待同步' : '同步已完成'}
        {pending.length ? ` · ${pending.length} 篇尚未同步` : ''}
      </Text>
      <Button size="compact-xs" variant="subtle" onClick={() => setOpened(true)}>離線與同步</Button>
    </Group>
    {storageFailure && <Alert color="red" title="本機儲存無法使用" m="sm">{storageFailure} 請勿關閉尚未同步的筆記。</Alert>}
    <Modal opened={opened} onClose={() => setOpened(false)} title="離線與同步" size="lg">
      <Stack>
        <Text size="sm">{ready ? '離線介面已準備完成。' : '離線介面尚未準備完成；手機須使用 HTTPS，並先連線開啟一次。'} 已下載 {notes.filter(n => n.local.page.kind === 'page').length} 篇一般筆記。</Text>
        <Text size="sm" c="dimmed">一般筆記的標題與內文可離線新增、編輯。恢復連線或重新開啟後自動同步；iPhone 關閉後不保證背景同步。資料庫、留言、新附件上傳及頁面設定需要連線。清除網站資料會移除此裝置尚未同步的內容。</Text>
        <Text size="sm" c="dimmed">下載包含筆記標題與內文。附件須另外連線開啟後才會快取，每個檔案最多 20 MB，每個帳號保留最近 100 個；裝置空間不足時可能無法保留。</Text>
        <Group>
          <Button size="xs" loading={busy} disabled={!online} onClick={() => { void download(); }}>下載全部一般筆記</Button>
          <Button size="xs" variant="default" disabled={!online} onClick={() => { void syncNotes().then(() => queryClient.invalidateQueries({ queryKey: ['tree'] })); }}>立即同步</Button>
        </Group>
        {message && <Text size="sm" role="status">{message}</Text>}
        {pending.map(note => <Stack key={note.local.page.id} gap={4}>
          <Anchor component={Link} to={`/p/${note.local.page.id}`} onClick={() => setOpened(false)}>{note.local.page.title || '無標題'}</Anchor>
          <Text size="xs" c={note.problem ? 'red' : 'dimmed'}>{note.problem ?? '已儲存於此裝置，等待同步。'}</Text>
          <Group gap="xs">
            <Button size="compact-xs" variant="subtle" onClick={() => exportDraft(note)}>匯出本機草稿</Button>
            <Button size="compact-xs" variant="subtle" color="red" onClick={() => {
              if (window.confirm('移除此筆記的本機副本及尚未同步的修改？伺服器上的內容不受影響。建議先匯出草稿。')) {
                void updateLocal<OfflineNote>(`page:${note.userId}:${note.local.page.id}`, () => undefined).then(() => window.location.assign('/'));
              }
            }}>捨棄本機草稿</Button>
            {note.problem && <Button size="compact-xs" variant="subtle" onClick={() => { void updateLocal<OfflineNote>(`page:${note.userId}:${note.local.page.id}`, current => current ? { ...current, problem: undefined, conflict: undefined } : current).then(() => syncNotes()); }}>重試同步</Button>}
          </Group>
        </Stack>)}
      </Stack>
    </Modal>
  </>;
}
