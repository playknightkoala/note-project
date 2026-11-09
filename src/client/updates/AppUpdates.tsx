import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Group, List, Modal, Stack, Text, UnstyledButton } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { isNewerVersion, versionInfoSchema } from '@shared/version';
import { api, errorText } from '../api/client.ts';
import { reportAppVersion, UPDATE_CHECK_EVENT } from '../offline/register.ts';
import { activateAppUpdate } from './activate.ts';
import { prepareForUpdate } from './guards.ts';
import { APP_VERSION } from './version.ts';
import { pendingFileUploads } from '../api/files.ts';

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
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [composing, setComposing] = useState(false);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = () => { clearTimeout(timer); setComposing(true); };
    const end = () => { timer = setTimeout(() => setComposing(false), 100); };
    document.addEventListener('compositionstart', start, true); document.addEventListener('compositionend', end, true);
    return () => { clearTimeout(timer); document.removeEventListener('compositionstart', start, true); document.removeEventListener('compositionend', end, true); };
  }, []);
  useEffect(() => {
    if (!available || composing || seen.current === available.version) return;
    seen.current = available.version; setFailure(null); setOpened(true);
    if ('serviceWorker' in navigator) void navigator.serviceWorker.getRegistration().then(registration => registration?.update()).catch(() => {});
  }, [available, composing]);
  useEffect(() => {
    const check = () => { void info.refetch(); };
    window.addEventListener(UPDATE_CHECK_EVENT, check);
    return () => window.removeEventListener(UPDATE_CHECK_EVENT, check);
  }, [info.refetch]);

  const check = async () => {
    if (available) { setOpened(true); return; }
    setNotice('正在檢查更新…');
    const result = await info.refetch();
    setNotice(result.error ? '無法檢查更新，請確認連線後再試。' : result.data && isNewerVersion(result.data.version, APP_VERSION) ? '' : '目前已是最新版本。');
  };
  const update = async () => {
    if (!available || busy) return;
    setBusy(true); setFailure(null);
    try {
      await prepareForUpdate();
      if (pendingFileUploads) throw new Error('附件仍在上傳，請等候完成後再更新。');
      const deadline = Date.now() + 10_000;
      while (client.isMutating() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (client.isMutating()) throw new Error('仍有資料正在儲存，請稍後再更新。');
      await prepareForUpdate();
      await activateAppUpdate(available.version);
    } catch (error) { setFailure(errorText(error)); setBusy(false); }
  };
  const releases = available?.releases.filter(release => isNewerVersion(release.version, APP_VERSION) && !isNewerVersion(release.version, available.version)) ?? [];
  return <>
    <UnstyledButton className="app-version" aria-label={`目前版本 ${APP_VERSION}，檢查更新`} onClick={event => { event.stopPropagation(); void check(); }}>
      <Text component="span" size="xs" c="dimmed">v{APP_VERSION}</Text>
      {available && <Text component="span" size="xs" c="orange">有新版</Text>}
    </UnstyledButton>
    {notice && <Text size="xs" c="dimmed" px="xs" role="status">{notice}</Text>}
    <Modal opened={opened && !!available} onClose={() => { if (!busy) setOpened(false); }} title="有新版本可更新" centered closeOnClickOutside={false} closeOnEscape={!busy} withCloseButton={!busy}>
      <Stack>
        <Text>目前版本 v{APP_VERSION}，最新版本 v{available?.version}。</Text>
        {releases.length ? releases.map(release => <Stack key={release.version} gap="xs">
          <Text fw={600}>v{release.version} · {release.title}</Text>
          <List size="sm" spacing="xs">{release.changes.map(change => <List.Item key={change}>{change}</List.Item>)}</List>
        </Stack>) : <Text size="sm">此版本包含功能更新與問題修正。</Text>}
        <Text size="sm" c="dimmed">更新會重新載入此分頁，已保存的離線筆記與附件快取會保留。請先儲存或取消尚未送出的留言及表單內容。</Text>
        {failure && <Alert color="red" title="尚未完成更新">{failure}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" disabled={busy} onClick={() => setOpened(false)}>稍後更新</Button>
          <Button loading={busy} onClick={() => { void update(); }}>立即更新</Button>
        </Group>
      </Stack>
    </Modal>
  </>;
}
