import { useState } from 'react';
import type { FormEvent } from 'react';
import { Alert, Button, Group, Stack, TextInput } from '@mantine/core';
import { useMe, useUpdateProfile } from '../../api/auth.ts';
import { errorText } from '../../api/client.ts';
import { useUpdateGuard } from '../../updates/guards.ts';

export function ProfileForm() {
  const me = useMe();
  const update = useUpdateProfile();
  const [displayName, setDisplayName] = useState(me.data?.displayName ?? '');
  const [username, setUsername] = useState(me.data?.username ?? '');
  const [saved, setSaved] = useState(false);
  useUpdateGuard(() => { if (displayName !== (me.data?.displayName ?? '') || username.trim() !== (me.data?.username ?? '')) throw new Error('請先儲存個人資料，再更新。'); });
  const submit = (event: FormEvent) => {
    event.preventDefault(); setSaved(false);
    update.mutate({ displayName, username: username.trim() === '' ? null : username.trim() }, { onSuccess: () => setSaved(true) });
  };
  return <form onSubmit={submit}>
    <Stack gap="md" maw={420}>
      {update.error && <Alert color="red" variant="light">{errorText(update.error)}</Alert>}
      {saved && <Alert color="green" variant="light">已儲存。</Alert>}
      <TextInput label="電子郵件" value={me.data?.email ?? ''} readOnly description="電子郵件目前不能修改" />
      <TextInput label="顯示名稱" required value={displayName} onChange={e => setDisplayName(e.currentTarget.value)} />
      <TextInput label="使用者名稱" description="登入時可用來代替電子郵件；留空表示不使用" value={username} onChange={e => setUsername(e.currentTarget.value)} />
      <Group justify="flex-end"><Button type="submit" loading={update.isPending}>儲存</Button></Group>
    </Stack>
  </form>;
}
