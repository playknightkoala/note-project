import { useEffect, useState } from 'react';
import { Alert, Anchor, Button, Group, Modal, NumberInput, Stack, Text } from '@mantine/core';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { downloadNotes, offlineNotes, offlineStorageError, SYNC_EVENT, SYNC_TREE_EVENT, syncNotes, syncStatus } from './notes.ts';
import { attachmentCacheInfo, DEFAULT_CACHE_MB, MAX_CACHE_MB, setAttachmentCacheLimit } from './attachments.ts';
import type { OfflineNote } from './notes.ts';
import { OFFLINE_EVENT, updateLocal } from './storage.ts';
import { errorText } from '../api/client.ts';
import { exportPageDraft } from './exportDraft.ts';

export function OfflineStatus() {
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState<OfflineNote[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [storageFailure, setStorageFailure] = useState<string | null>(offlineStorageError);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState(syncStatus);
  const [cacheMB, setCacheMB] = useState<string | number>(DEFAULT_CACHE_MB);
  const [cacheInfo, setCacheInfo] = useState<Awaited<ReturnType<typeof attachmentCacheInfo>> | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => { void offlineNotes().then(items => { if (active) { setNotes(items); setStorageFailure(offlineStorageError); } }).catch(error => { if (active) setStorageFailure(errorText(error)); }); };
    const sync = () => setStatus({ ...syncStatus });
    const tree = () => { void queryClient.invalidateQueries({ queryKey: ['tree'] }); };
    const connect = () => { setOnline(navigator.onLine); if (navigator.onLine) void syncNotes({ force: true }); };
    const focus = () => { if (document.visibilityState === 'visible') void syncNotes({ force: true }); };
    const prepared = () => setReady(true);
    window.addEventListener(OFFLINE_EVENT, refresh);
    window.addEventListener(SYNC_EVENT, sync);
    window.addEventListener(SYNC_TREE_EVENT, tree);
    window.addEventListener('online', connect); window.addEventListener('offline', connect);
    window.addEventListener('notes:offline-ready', prepared);
    document.addEventListener('visibilitychange', focus);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void syncNotes(); }, 15_000);
    if ('serviceWorker' in navigator) void navigator.serviceWorker.ready.then(() => { if (active) setReady(true); });
    refresh(); void syncNotes({ force: true });
    return () => { active = false; clearInterval(timer); window.removeEventListener(OFFLINE_EVENT, refresh); window.removeEventListener(SYNC_EVENT, sync); window.removeEventListener(SYNC_TREE_EVENT, tree); window.removeEventListener('online', connect); window.removeEventListener('offline', connect); window.removeEventListener('notes:offline-ready', prepared); document.removeEventListener('visibilitychange', focus); };
  }, []);
  useEffect(() => {
    if (!opened) return;
    let active = true;
    const refresh = () => { void attachmentCacheInfo().then(info => { if (active) setCacheInfo(info); }).catch(error => { if (active) setMessage(errorText(error)); }); };
    void attachmentCacheInfo().then(info => { if (active) { setCacheInfo(info); setCacheMB(info.limitMB); } }).catch(error => { if (active) setMessage(errorText(error)); });
    navigator.serviceWorker?.addEventListener('message', refresh);
    return () => { active = false; navigator.serviceWorker?.removeEventListener('message', refresh); };
  }, [opened]);
  const pending = notes.filter(n => n.pending);
  const problems = pending.filter(n => n.problem);
  const download = async () => {
    setBusy(true); setMessage(null);
    try { await downloadNotes(); await queryClient.invalidateQueries({ queryKey: ['tree'] }); setMessage(syncStatus.phase === 'complete' ? '離線筆記已同步完成，標題與內文已更新至此裝置。' : '已檢查更新，仍有待同步或需要處理的筆記。'); }
    catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  };
  const label = !online ? '離線使用中' : problems.length ? '部分筆記需要處理' : status.phase === 'syncing' ? '正在同步離線筆記…' : status.phase === 'error' ? '同步尚未完成' : pending.length || status.phase === 'pending' ? '等待同步' : status.phase === 'complete' ? '離線筆記已同步完成' : '尚未確認同步狀態';
  const completedTime = status.completedAt ? new Date(status.completedAt).toLocaleString('zh-TW', { hour12: false }) : null;
  return <>
    <Group className="offline-status" gap="xs" px="sm" py={6} role="status" wrap="wrap">
      <Text size="xs" c={problems.length || status.phase === 'error' ? 'red' : !online || pending.length ? 'orange' : status.phase === 'complete' ? 'green' : 'dimmed'}>
        {label}
        {pending.length ? ` · ${pending.length} 篇尚未同步` : ''}
      </Text>
      {completedTime && <Text size="xs" c="dimmed">最近完整同步：{completedTime}</Text>}
      <Button size="compact-xs" variant="subtle" onClick={() => setOpened(true)}>離線與同步</Button>
    </Group>
    {storageFailure && <Alert color="red" title="本機儲存無法使用" m="sm">{storageFailure} 請勿關閉尚未同步的筆記。</Alert>}
    <Modal opened={opened} onClose={() => setOpened(false)} title="離線與同步" size="lg">
      <Stack>
        <Text size="sm">{ready ? '離線介面已準備完成。' : '離線介面尚未準備完成；手機須使用 HTTPS，並先連線開啟一次。'} 已下載 {notes.filter(n => n.local.page.kind === 'page' && !n.removed).length} 篇一般筆記。</Text>
        <Text size="sm" c="dimmed">連線開啟、恢復連線或切回網站時，會自動上傳修改並下載所有一般筆記的更新；開著網站時每分鐘檢查更新，不必反覆手動下載。手機關閉後不保證背景同步。資料庫、留言、新附件上傳及頁面設定需要連線。清除網站資料會移除此裝置尚未同步的內容。</Text>
        {status.phase === 'complete' && online && !pending.length && <Alert color="green" title="離線筆記已同步完成">標題與內文已更新至此裝置，本機修改已保存於伺服器。最近完整同步：{completedTime}。附件快取另計。</Alert>}
        {status.phase === 'error' && <Alert color="orange" title="同步尚未完成">{status.error} 系統會稍後重試，也可按「立即同步」。</Alert>}
        <Text size="sm" c="dimmed">附件須連線開啟後才會快取，依總容量保留，超過容量會移除較早快取，不影響伺服器原檔。{status.maxUploadBytes ? `伺服器目前的附件上傳上限為 ${Math.round(status.maxUploadBytes / 1024 / 1024)} MB。` : ''}裝置空間不足時可能無法保留。</Text>
        <NumberInput label="此裝置的附件離線快取上限（MB）" description="只套用於目前帳號；不限制筆記篇數。瀏覽器可用空間可能低於此設定。" min={100} max={MAX_CACHE_MB} allowDecimal={false} value={cacheMB} onChange={setCacheMB} />
        {cacheInfo && <Text size="xs" c="dimmed">附件快取已用 {(cacheInfo.usedBytes / 1024 / 1024).toFixed(1)} MB／{cacheInfo.limitMB} MB，共 {cacheInfo.count} 個附件。</Text>}
        <Button size="xs" variant="default" onClick={() => { void setAttachmentCacheLimit(Number(cacheMB)).then(async () => { setCacheInfo(await attachmentCacheInfo()); setMessage('附件快取容量已儲存，超出的較早快取會自動清理。'); }).catch(error => setMessage(errorText(error))); }}>儲存快取容量</Button>
        <Group>
          <Button size="xs" loading={busy} disabled={!online} onClick={() => { void download(); }}>立即同步</Button>
        </Group>
        {message && <Text size="sm" role="status">{message}</Text>}
        {problems.some(note => note.conflict) && <Alert color="orange" title="版本衝突：本機草稿已保留">請開啟該筆記，選擇載入最新版本或以本機內容覆蓋。系統不會自動合併或覆蓋；建議先匯出草稿，覆蓋前的線上內容會留在頁面歷史。</Alert>}
        {pending.map(note => <Stack key={note.local.page.id} gap={4}>
          <Anchor component={Link} to={`/p/${note.local.page.id}`} onClick={() => setOpened(false)}>{note.local.page.title || '無標題'}</Anchor>
          <Text size="xs" c={note.problem ? 'red' : 'dimmed'}>{note.problem ?? '已儲存於此裝置，等待同步。'}</Text>
          <Group gap="xs">
            <Button size="compact-xs" variant="subtle" onClick={() => exportPageDraft(note.local)}>匯出本機草稿</Button>
            <Button size="compact-xs" variant="subtle" color="red" onClick={() => {
              if (window.confirm('移除此筆記的本機副本及尚未同步的修改？伺服器上的內容不受影響。建議先匯出草稿。')) {
                void updateLocal<OfflineNote>(`page:${note.userId}:${note.local.page.id}`, () => undefined).then(() => window.location.assign('/'));
              }
            }}>捨棄本機草稿</Button>
            {note.problem && !note.conflict && <Button size="compact-xs" variant="subtle" onClick={() => { void updateLocal<OfflineNote>(`page:${note.userId}:${note.local.page.id}`, current => current ? { ...current, problem: undefined, conflict: undefined } : current).then(() => syncNotes({ force: true })); }}>重試同步</Button>}
          </Group>
        </Stack>)}
      </Stack>
    </Modal>
  </>;
}
