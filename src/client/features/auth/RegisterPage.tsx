import { useState } from 'react';
import type { FormEvent } from 'react';
import { Alert, Anchor, Button, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { useAuthStatus, useMe, useRegister } from '../../api/auth.ts';
import { errorText } from '../../api/client.ts';
import { AuthLayout } from './AuthLayout.tsx';

export function RegisterPage() {
  const me = useMe();
  const status = useAuthStatus();
  const register = useRegister();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [form, setForm] = useState({ email: '', username: '', displayName: '', password: '', confirm: '', inviteCode: params.get('invite') ?? '' });
  const [localError, setLocalError] = useState<string | null>(null);
  if (me.data) return <Navigate to="/" replace />;
  const setupRequired = status.data?.setupRequired === true;
  // The operator may require a setup token (NOTES_SETUP_TOKEN) for the very first account.
  const setupToken = setupRequired && status.data?.setupTokenRequired === true;
  // Read the value synchronously: React clears currentTarget before a functional state update runs.
  const update = (key: keyof typeof form) => (event: { currentTarget: { value: string } }) => { const value = event.currentTarget.value; setForm(current => ({ ...current, [key]: value })); };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    if (form.password !== form.confirm) { setLocalError('兩次輸入的密碼不一致。'); return; }
    register.mutate({
      email: form.email, displayName: form.displayName, password: form.password,
      ...(form.username ? { username: form.username } : {}),
      ...(setupRequired && !setupToken ? {} : { inviteCode: form.inviteCode }),
    }, { onSuccess: () => navigate('/', { replace: true }) });
  };
  return <AuthLayout title={setupRequired ? '建立管理者帳號' : '註冊帳號'}
    subtitle={setupToken ? '這是第一個帳號，將成為此站的管理者。需要部署時設定的設定碼。' : setupRequired ? '這是第一個帳號，將成為此站的管理者。' : '需要管理者提供的邀請碼。'}>
    <form onSubmit={submit}>
      <Stack gap="md">
        {(localError || register.error) && <Alert color="red" variant="light">{localError ?? errorText(register.error)}</Alert>}
        {(!setupRequired || setupToken) && <TextInput label={setupToken ? '設定碼' : '邀請碼'} description={setupToken ? '部署此站時在 NOTES_SETUP_TOKEN 設定的值' : undefined} required value={form.inviteCode} onChange={update('inviteCode')} autoFocus={!form.inviteCode} />}
        <TextInput label="顯示名稱" required value={form.displayName} onChange={update('displayName')} autoFocus={(setupRequired && !setupToken) || !!form.inviteCode} />
        <TextInput label="電子郵件" type="email" autoComplete="email" required value={form.email} onChange={update('email')} />
        <TextInput label="使用者名稱（選填）" description="登入時可用來代替電子郵件；小寫英數字、底線、點、連字號" autoComplete="username" value={form.username} onChange={update('username')} />
        <PasswordInput label="密碼" description="至少 10 個字元" autoComplete="new-password" required value={form.password} onChange={update('password')} />
        <PasswordInput label="確認密碼" autoComplete="new-password" required value={form.confirm} onChange={update('confirm')} />
        <Button type="submit" loading={register.isPending} fullWidth>{setupRequired ? '建立帳號' : '註冊'}</Button>
        {!setupRequired && <Text size="sm" c="dimmed" ta="center">已有帳號？<Anchor component={Link} to="/login">登入</Anchor></Text>}
      </Stack>
    </form>
  </AuthLayout>;
}
