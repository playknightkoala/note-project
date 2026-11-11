import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Group, List, Modal, ScrollArea, Stack, Text, UnstyledButton } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { releases as releaseLog } from '@shared/releases';
import { isNewerVersion, versionInfoSchema } from '@shared/version';
import { api, errorText } from '../api/client.ts';
import { reportAppVersion, UPDATE_CHECK_EVENT } from '../offline/register.ts';
import { activateAppUpdate } from './activate.ts';
import { prepareForUpdate } from './guards.ts';
import { APP_VERSION } from './version.ts';
import { pendingFileUploads } from '../api/files.ts';

/** How soon saving is tried again while something only the user can finish is still open. */
const RETRY_MS = 2000;

/**
 * Saves what is open: notes and titles are written, uploads and requests in flight are waited for. What only the
 * user can finish (an open form, an unsent comment, a text composition) is reported instead.
 */
async function saveForUpdate(client: QueryClient): Promise<void> {
  await prepareForUpdate();
  if (pendingFileUploads) throw new Error('附件仍在上傳，請等候完成後再更新。');
  const deadline = Date.now() + 10_000;
  while (client.isMutating() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  if (client.isMutating()) throw new Error('仍有資料正在儲存，請稍後再更新。');
  await prepareForUpdate();
}

export function AppUpdates() {
  const client = useQueryClient();
  const info = useQuery({
    queryKey: ['app-version'],
    queryFn: async ({ signal }) => {
      reportAppVersion();
      return versionInfoSchema.parse(await api('GET', '/api/version', { signal, cache: 'no-store' }));
    },
    staleTime: 30_000, refetchInterval: 60_000, refetchOnWindowFocus: true, refetchOnReconnect: true, retry: false,
  });
  const available = info.data && isNewerVersion(info.data.version, APP_VERSION) ? info.data : null;
  const version = available?.version ?? null;
  /** The version whose update window is shown: everything here was saved first. */
  const [ready, setReady] = useState<string | null>(null);
  /** Why the window has not appeared yet. */
  const [waiting, setWaiting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [logOpened, setLogOpened] = useState(false);
  const [composing, setComposing] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = () => { clearTimeout(timer); setComposing(true); };
    const end = () => { timer = setTimeout(() => setComposing(false), 100); };
    document.addEventListener('compositionstart', start, true); document.addEventListener('compositionend', end, true);
    return () => { clearTimeout(timer); document.removeEventListener('compositionstart', start, true); document.removeEventListener('compositionend', end, true); };
  }, []);
  useEffect(() => {
    const changed = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', changed); window.addEventListener('offline', changed);
    return () => { window.removeEventListener('online', changed); window.removeEventListener('offline', changed); };
  }, []);
  // A new version: save first, then show the window. It cannot be put off, so it must never open over unsaved work.
  useEffect(() => {
    if (!version || composing || !online || ready === version) return;
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async () => {
      try {
        await saveForUpdate(client);
        if (!active) return;
        setWaiting(null); setFailure(null); setLogOpened(false); setReady(version);
      } catch (error) {
        if (!active) return;
        setWaiting(errorText(error));
        timer = setTimeout(() => { void attempt(); }, RETRY_MS);
      }
    };
    void attempt();
    return () => { active = false; clearTimeout(timer); };
  }, [version, composing, online, ready, client]);
  useEffect(() => {
    if (version && 'serviceWorker' in navigator) void navigator.serviceWorker.getRegistration().then(registration => registration?.update()).catch(() => {});
  }, [version]);
  useEffect(() => {
    const check = () => { void info.refetch(); };
    window.addEventListener(UPDATE_CHECK_EVENT, check);
    return () => window.removeEventListener(UPDATE_CHECK_EVENT, check);
  }, [info.refetch]);

  const update = async () => {
    if (!available || busy) return;
    setBusy(true); setFailure(null);
    // Something changed after the window opened and cannot be saved for the user: step back until it is finished.
    try { await saveForUpdate(client); }
    catch (error) { setWaiting(errorText(error)); setReady(null); setBusy(false); return; }
    try { await activateAppUpdate(available.version); }
    catch (error) { setFailure(errorText(error)); setBusy(false); }
  };
  const incoming = available?.releases.filter(release => isNewerVersion(release.version, APP_VERSION) && !isNewerVersion(release.version, available.version)) ?? [];
  const history = releaseLog.filter(release => !isNewerVersion(release.version, APP_VERSION));
  return <>
    <UnstyledButton className="app-version" aria-label={`目前版本 ${APP_VERSION}，查看更新紀錄`} onClick={event => { event.stopPropagation(); setLogOpened(true); void info.refetch(); }}>
      <Text component="span" size="xs" c="dimmed">v{APP_VERSION}</Text>
      {available && <Text component="span" size="xs" c="orange">有新版</Text>}
    </UnstyledButton>
    <Modal opened={logOpened} onClose={() => setLogOpened(false)} title="更新紀錄" centered size="lg" scrollAreaComponent={ScrollArea.Autosize}>
      <Stack>
        {available && <Alert color="orange" title={`有新版本 v${available.version}`}>
          {!online ? '恢復連線後會出現更新視窗。' : waiting ? `${waiting}完成後會自動出現更新視窗。` : '正在儲存這裡的修改，完成後會出現更新視窗。'}
        </Alert>}
        {history.map(release => <Stack key={release.version} gap="xs">
          <Group gap="xs">
            <Text fw={600}>v{release.version} · {release.title}</Text>
            {release.version === APP_VERSION && <Badge size="sm" variant="light">目前版本</Badge>}
          </Group>
          <List size="sm" spacing="xs">{release.changes.map(change => <List.Item key={change}>{change}</List.Item>)}</List>
        </Stack>)}
        {!history.length && <Text size="sm" c="dimmed">目前版本 v{APP_VERSION} 沒有更新紀錄。</Text>}
      </Stack>
    </Modal>
    {/* No way out but updating: no close button, no Escape, no click outside. Without a connection it steps aside. */}
    <Modal opened={!!available && ready === version && online} onClose={() => {}} title="有新版本，請更新" centered closeOnClickOutside={false} closeOnEscape={false} withCloseButton={false}>
      <Stack>
        <Text>目前版本 v{APP_VERSION}，最新版本 v{available?.version}。</Text>
        {incoming.length ? incoming.map(release => <Stack key={release.version} gap="xs">
          <Text fw={600}>v{release.version} · {release.title}</Text>
          <List size="sm" spacing="xs">{release.changes.map(change => <List.Item key={change}>{change}</List.Item>)}</List>
        </Stack>) : <Text size="sm">此版本包含功能更新與問題修正。</Text>}
        <Text size="sm" c="dimmed">這裡的修改已先儲存。更新會重新載入此分頁，離線筆記、待同步的草稿與附件快取都會保留。</Text>
        {failure && <Alert color="red" title="尚未完成更新">{failure}</Alert>}
        <Group justify="flex-end">
          <Button loading={busy} onClick={() => { void update(); }}>立即更新</Button>
        </Group>
      </Stack>
    </Modal>
  </>;
}
