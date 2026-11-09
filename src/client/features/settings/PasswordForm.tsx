import { useState } from 'react';
import type { FormEvent } from 'react';
import { Alert, Button, Group, PasswordInput, Stack } from '@mantine/core';
import { useChangePassword } from '../../api/auth.ts';
import { errorText } from '../../api/client.ts';
import { useUpdateGuard } from '../../updates/guards.ts';

export function PasswordForm() {
  const change = useChangePassword();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  useUpdateGuard(() => { if (Object.values(form).some(Boolean)) throw new Error('請先完成或清除密碼修改表單，再更新。'); });
  const [message, setMessage] = useState<{ color: 'red' | 'green'; text: string } | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault(); setMessage(null);
    if (form.next !== form.confirm) { setMessage({ color: 'red', text: '兩次輸入的新密碼不一致。' }); return; }
    change.mutate({ currentPassword: form.current, newPassword: form.next }, {
      onSuccess: () => { setForm({ current: '', next: '', confirm: '' }); setMessage({ color: 'green', text: '密碼已更新；其他裝置的登入已失效。' }); },
      onError: error => setMessage({ color: 'red', text: errorText(error) }),
    });
  };
  return <form onSubmit={submit}>
    <Stack gap="md" maw={420}>
      {message && <Alert color={message.color} variant="light">{message.text}</Alert>}
      <PasswordInput label="目前密碼" autoComplete="current-password" required value={form.current} onChange={e => setForm({ ...form, current: e.currentTarget.value })} />
      <PasswordInput label="新密碼" description="至少 10 個字元" autoComplete="new-password" required value={form.next} onChange={e => setForm({ ...form, next: e.currentTarget.value })} />
      <PasswordInput label="確認新密碼" autoComplete="new-password" required value={form.confirm} onChange={e => setForm({ ...form, confirm: e.currentTarget.value })} />
      <Group justify="flex-end"><Button type="submit" loading={change.isPending}>更新密碼</Button></Group>
    </Stack>
  </form>;
}
