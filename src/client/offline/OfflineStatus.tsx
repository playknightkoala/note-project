import { useEffect, useState } from 'react';
import { Alert, Anchor, Button, Group, Modal, NumberInput, Stack, Text } from '@mantine/core';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { downloadNotes, offlineNote, offlineNotes, offlineStorageError, renameLocalRow, SYNC_EVENT, SYNC_TREE_EVENT, syncNotes, syncStatus } from './notes.ts';
import { attachmentCacheInfo, DEFAULT_CACHE_MB, MAX_CACHE_MB, setAttachmentCacheLimit } from './attachments.ts';
import type { OfflineNote } from './notes.ts';
import { OFFLINE_EVENT, updateLocal } from './storage.ts';
import { errorText } from '../api/client.ts';
import { exportJson, exportPageDraft } from './exportDraft.ts';
import { describeQueued, discardOp, localDatabase, OUTBOX_EVENT, queuedOps, retryOp, storedDatabases } from './outbox.ts';
import type { QueuedOp } from './outbox.ts';
import { discardUpload, pendingUploads, retryUpload } from './uploads.ts';
import type { PendingUpload } from './uploads.ts';
import { offlineOwner } from './owner.ts';

export function OfflineStatus() {
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState<OfflineNote[]>([]);
  const [ops, setOps] = useState<QueuedOp[]>([]);
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [databases, setDatabases] = useState(0);
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
    const refresh = () => {
      void offlineNotes().then(items => { if (active) { setNotes(items); setStorageFailure(offlineStorageError); } }).catch(error => { if (active) setStorageFailure(errorText(error)); });
      const owner = offlineOwner();
      void Promise.all([queuedOps(), pendingUploads(), owner ? storedDatabases(owner) : []]).then(([queued, files, stored]) => { if (active) { setOps(queued); setUploads(files); setDatabases(stored.length); } }).catch(() => {});
    };
    const sync = () => setStatus({ ...syncStatus });
    const tree = () => { void queryClient.invalidateQueries({ queryKey: ['tree'] }); };
    const connect = () => { setOnline(navigator.onLine); if (navigator.onLine) void syncNotes({ force: true }); };
    const focus = () => { if (document.visibilityState === 'visible') void syncNotes({ force: true }); };
    const prepared = () => setReady(true);
    // A change to a database or a discussion was just stored on this device: send it as soon as the server is reachable.
    const queued = () => { void syncNotes(); };
    window.addEventListener(OUTBOX_EVENT, queued);
    window.addEventListener(OFFLINE_EVENT, refresh);
    window.addEventListener(SYNC_EVENT, sync);
    window.addEventListener(SYNC_TREE_EVENT, tree);
    window.addEventListener('online', connect); window.addEventListener('offline', connect);
    window.addEventListener('notes:offline-ready', prepared);
    document.addEventListener('visibilitychange', focus);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void syncNotes(); }, 15_000);
    if ('serviceWorker' in navigator) void navigator.serviceWorker.ready.then(() => { if (active) setReady(true); });
    refresh(); void syncNotes({ force: true });
    return () => { active = false; clearInterval(timer); window.removeEventListener(OUTBOX_EVENT, queued); window.removeEventListener(OFFLINE_EVENT, refresh); window.removeEventListener(SYNC_EVENT, sync); window.removeEventListener(SYNC_TREE_EVENT, tree); window.removeEventListener('online', connect); window.removeEventListener('offline', connect); window.removeEventListener('notes:offline-ready', prepared); document.removeEventListener('visibilitychange', focus); };
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
  const waiting = pending.length + ops.length + uploads.length;
  const needsAttention = problems.length > 0 || ops.some(item => item.problem) || uploads.some(item => item.problem);
  const resync = () => { void syncNotes({ force: true }); };
  /** A row made on this device takes its page text with it when discarded, so the export includes that page. */
  const exportOp = async (item: QueuedOp) => exportJson(`待同步修改-${item.id}.json`, item.op.type === 'row.create' ? { ...item, page: (await offlineNote(item.op.rowId).catch(() => undefined))?.local } : item);
  const discard = async (item: QueuedOp) => {
    const made = item.op.type === 'row.create';
    if (!window.confirm(made ? '捨棄這筆尚未同步的新資料列？此裝置上這一列的內文、後續修改與留言也會一併刪除（可先按「匯出」保存）。伺服器上的內容不受影響。' : '捨棄這項尚未同步的修改？伺服器上的內容不受影響。')) return;
    await discardOp(item.key);
    // A discarded rename: the copy of the row's page shows the name the database now has again.
    if (item.op.type === 'row.update' && item.op.title) {
      const rowId = item.op.rowId, row = (await localDatabase(item.op.databaseId))?.rows.find(candidate => candidate.id === rowId);
      if (row) await renameLocalRow(rowId, row.title).catch(() => undefined);
    }
    resync();
  };
  const download = async () => {
    setBusy(true); setMessage(null);
    try { await downloadNotes(); await queryClient.invalidateQueries({ queryKey: ['tree'] }); setMessage(syncStatus.phase === 'complete' ? '離線筆記已同步完成，標題與內文已更新至此裝置。' : '已檢查更新，仍有待同步或需要處理的筆記。'); }
    catch (error) { setMessage(errorText(error)); }
    finally { setBusy(false); }
  };
  const label = !online ? '離線使用中' : needsAttention ? (problems.length ? '部分筆記需要處理' : '部分修改需要處理') : status.phase === 'syncing' ? '正在同步離線筆記…' : status.phase === 'error' ? '同步尚未完成' : waiting || status.phase === 'pending' ? '等待同步' : status.phase === 'complete' ? '離線筆記已同步完成' : '尚未確認同步狀態';
  const completedTime = status.completedAt ? new Date(status.completedAt).toLocaleString('zh-TW', { hour12: false }) : null;
  return <>
    <Group className="offline-status" gap="xs" px="sm" py={6} role="status" wrap="wrap">
      <Text size="xs" c={needsAttention || status.phase === 'error' ? 'red' : !online || waiting ? 'orange' : status.phase === 'complete' ? 'green' : 'dimmed'}>
        {label}
        {pending.length ? ` · ${pending.length} 篇尚未同步` : ''}
        {ops.length ? ` · ${ops.length} 項修改待同步` : ''}
        {uploads.length ? ` · ${uploads.length} 個附件待上傳` : ''}
      </Text>
      {completedTime && <Text size="xs" c="dimmed">最近完整同步：{completedTime}</Text>}
      <Button size="compact-xs" variant="subtle" onClick={() => setOpened(true)}>離線與同步</Button>
    </Group>
    {storageFailure && <Alert color="red" title="本機儲存無法使用" m="sm">{storageFailure} 請勿關閉尚未同步的筆記。</Alert>}
    <Modal opened={opened} onClose={() => setOpened(false)} title="離線與同步" size="lg">
      <Stack>
        <Text size="sm">{ready ? '離線介面已準備完成。' : '離線介面尚未準備完成；手機須使用 HTTPS，並先連線開啟一次。'} 已下載 {notes.filter(n => n.local.page.kind === 'page' && !n.removed).length} 篇一般筆記、{databases} 個資料庫。</Text>
        <Text size="sm" c="dimmed">連線開啟、恢復連線或切回網站時，會自動上傳修改並下載一般筆記、資料庫（結構、視圖、資料列與列內文）及留言的更新；開著網站時每分鐘檢查更新，不必反覆手動下載。手機關閉後不保證背景同步。離線時可編輯筆記與資料列、修改資料庫結構與視圖、留言及加入附件；搜尋、頁面歷史、最愛、搬移、垃圾桶、圖示與封面、新增資料庫需要連線。清除網站資料會移除此裝置尚未同步的內容。</Text>
        {status.phase === 'complete' && online && !waiting && <Alert color="green" title="離線筆記已同步完成">筆記、資料庫與留言已更新至此裝置，本機修改已保存於伺服器。最近完整同步：{completedTime}。附件快取另計。</Alert>}
        {status.phase === 'error' && <Alert color="orange" title="同步尚未完成">{status.error} 系統會稍後重試，也可按「立即同步」。</Alert>}
        <Text size="sm" c="dimmed">既有附件須連線開啟後才會快取，依總容量保留，超過容量會移除較早快取，不影響伺服器原檔。離線加入的附件先存此裝置（不計入快取上限，也不會被自動清除），連線後上傳。{status.maxUploadBytes ? `伺服器目前的附件上傳上限為 ${Math.round(status.maxUploadBytes / 1024 / 1024)} MB。` : ''}裝置空間不足時可能無法保留。</Text>
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
        {ops.some(item => item.conflict) && <Alert color="orange" title="修改與其他裝置衝突">這些修改已保留在此裝置，尚未套用。可選擇「以我的修改覆蓋」套用到最新資料，或「捨棄」；同一資料庫（或同一頁留言）後續的修改會等它處理完才送出。</Alert>}
        {ops.map(item => <Stack key={item.key} gap={4}>
          <Text size="sm">{describeQueued(item)}{'databaseId' in item.op ? <> · <Anchor component={Link} to={`/p/${item.op.databaseId}`} onClick={() => setOpened(false)}>開啟資料庫</Anchor></> : <> · <Anchor component={Link} to={`/p/${item.op.pageId}`} onClick={() => setOpened(false)}>開啟頁面</Anchor></>}</Text>
          <Text size="xs" c={item.problem ? 'red' : 'dimmed'}>{item.problem ?? '已儲存於此裝置，等待同步。'}</Text>
          <Group gap="xs">
            <Button size="compact-xs" variant="subtle" onClick={() => { void exportOp(item); }}>匯出</Button>
            {item.problem && <Button size="compact-xs" variant="subtle" onClick={() => { void retryOp(item.key).then(resync); }}>重試同步</Button>}
            {item.conflict && <Button size="compact-xs" variant="subtle" onClick={() => { if (window.confirm(item.op.type === 'annotation.delete' ? '這則討論有此裝置沒看過的新留言。仍要刪除整則討論？' : '以這項修改覆蓋其他裝置已做的變更？')) void retryOp(item.key, true).then(resync); }}>以我的修改覆蓋</Button>}
            <Button size="compact-xs" variant="subtle" color="red" onClick={() => { void discard(item); }}>捨棄</Button>
          </Group>
        </Stack>)}
        {uploads.map(item => <Stack key={item.id} gap={4}>
          <Text size="sm">附件「{item.name}」（{(item.size / 1024 / 1024).toFixed(1)} MB）</Text>
          <Text size="xs" c={item.problem ? 'red' : 'dimmed'}>{item.problem ?? '已儲存於此裝置，等待上傳。'}</Text>
          <Group gap="xs">
            <Button size="compact-xs" variant="subtle" component="a" href={item.url} download={item.name}>下載此裝置上的副本</Button>
            {item.problem && <Button size="compact-xs" variant="subtle" onClick={() => { void retryUpload(item).then(resync); }}>重試上傳</Button>}
            <Button size="compact-xs" variant="subtle" color="red" onClick={() => { if (window.confirm('捨棄這個尚未上傳的附件？引用它的筆記會顯示附件遺失。')) void discardUpload(item).then(resync); }}>捨棄</Button>
          </Group>
        </Stack>)}
      </Stack>
    </Modal>
  </>;
}
